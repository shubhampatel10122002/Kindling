# Primer MVP: Build Plan

**For the coding agent: read this entire file before writing any code. Build in the order given in Section 14. Each step must end in something runnable and demoable. Do not skip ahead. Do not add features from Section 15 (out of scope).**

> **Credentials note:** the real API keys live in `.env.local`, which is gitignored.
> They are deliberately not reproduced in this file — it is committed.

## What we are building

A voice-based AI reading companion for one child, for a YC demo. The child reads a dynamically generated story aloud for ~15 minutes. The AI narrator listens with pronunciation assessment, coaches stuck words, encourages, answers questions Socratically, and adapts the story live. The child can tap a character button ("push to talk") to speak to the narrator at any time: ask questions, request a different story, or chat. A "Consolidate" button updates the child's memory model, which shapes the next session's plan.

Scope: single child, no auth, no payments, web app only, English only.

---

## 0. Human setup (the founder does this by hand, not the agent)

### 0.1 Azure Speech
1. portal.azure.com → create a free account.
2. "Create a resource" → **Speech** (under Azure AI services) → Create.
3. Resource group `primer-dev`, region `eastus`, pricing tier `F0` (free, 5 audio hours/month) or `S0`.
4. After deploy, open the resource → **Keys and Endpoint** → copy **KEY 1** and the **Region**.

### 0.2 Cartesia TTS
1. cartesia.ai → sign up.
2. **Voice Library** → audition voices → pick ONE warm friendly narrator voice → copy its **voice ID**.
3. **API Keys** → create a key.

### 0.3 Anthropic API
Create a key at console.anthropic.com.

### 0.4 Local database
Install Docker Desktop, then `docker compose up -d`.

### 0.5 Environment file
Create `.env.local` at repo root (see `.env.example` for the full list):

```
ANTHROPIC_API_KEY=...
AZURE_SPEECH_KEY=...
AZURE_SPEECH_REGION=eastus
CARTESIA_API_KEY=...
CARTESIA_VOICE_ID=...
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/primer
```

### 0.6 MCP servers for Claude Code

```
claude mcp add --transport http microsoft-learn https://learn.microsoft.com/api/mcp
claude mcp add --transport http context7 https://mcp.context7.com/mcp
```

Microsoft Learn for Azure Speech SDK docs. Context7 for current Cartesia, Vercel AI SDK, and Drizzle docs. A Postgres MCP is not needed: use `psql` through the shell.

### 0.7 Skills for Claude Code
Maintained in `.claude/skills/` as decisions solidify:
- `.claude/skills/azure-pron/SKILL.md` — Azure config values, result-parsing decisions, the leniency table, gotchas.
- `.claude/skills/narrator/SKILL.md` — narrator system prompt template, structured output contract, mode instructions.

Plus a short `CLAUDE.md` at repo root pointing here.

---

## 1. Tech stack

| Layer | Choice |
|---|---|
| Frontend | Next.js (App Router). One session page + a debug/memory panel |
| Backend | Next.js API routes + one standalone Node WebSocket server (`ws`) for the live session |
| LLM | Claude Sonnet (`claude-sonnet-4-6`) for narrator, story planning, consolidation. Claude Haiku (`claude-haiku-4-5`) for intent classification and the safety pass. Via Vercel AI SDK (`@ai-sdk/anthropic`, `generateObject` / `generateText`) |
| Listening | Azure Speech SDK (`microsoft-cognitiveservices-speech-sdk`), two modes: Pronunciation Assessment (reading) and plain speech recognition (talking) |
| Voice out | Cartesia streaming TTS, one fixed voice ID |
| DB | PostgreSQL (Docker), raw SQL via `pg` |
| Agent frameworks | None. Plain TypeScript functions and a deterministic state machine |

Rule of the whole codebase: **deterministic code decides what happens; the LLM only decides what words to say.**

---

## 2. System components

1. **Session WebSocket server**: owns the live session. State machine, relays audio to Azure, streams Cartesia audio down, calls the narrator LLM. One concurrent session is fine.
2. **Audio pipeline** (browser + server): capture, playback, half-duplex control (§8).
3. **Narrator agent**: one continuous LLM conversation per session, receives mode instructions from the state machine, returns structured output (§7).
4. **Pedagogy module**: pure TypeScript, no LLM calls (§11).
5. **Story planner**: one LLM call producing a session plan JSON before each session (§6).
6. **Consolidation workflow**: one endpoint behind a button (§12).
7. **Debug panel**: live mode, last Azure result, current plan, memory model, memory diff after consolidation. This visible loop IS the YC demo.

---

## 3. Data model (Postgres)

See `db/schema.sql` for the authoritative version. Tables: `children`, `sessions`,
`reading_events` (append-only), `skill_mastery`, `child_memory`,
`child_memory_history`, `session_flags`, `child_notes` (everything the child
volunteers — see §16), plus two implementation tables: `next_plans` (the plan
consolidation prepares for the next session) and `consolidation_state` (a
watermark so consolidation only folds in events it has not already seen).

Skill list: ~30 skills hardcoded in `lib/skills.ts` (short vowels, common consonant blends, digraphs sh/ch/th/wh, 20 sight words). Each: id, description, example words, prerequisite skill ids.

---

## 4. The session state machine

Runs on the WebSocket server. Deterministic code picks the mode; the LLM writes the words.

| Mode | Trigger to enter | What happens |
|---|---|---|
| ONBOARDING | No child in the database | Ollie asks her name and one thing she likes, a grown-up confirms the spelling, then he writes. No placement test, ever. |
| DOORWAY | Session start, for a child we have met | One question chosen by `lib/opening.ts` from the local time and the gap since her last session. She talks; everything is absorbed and nothing is discussed. |
| NARRATE | Session start, or child finished a passage | Narrator produces next story beat (2-3 spoken sentences) + the child's next passage (1-2 sentences). TTS speaks the beat. Mic is muted during playback. |
| CHILD_READS | Narrator hands over | Mic streams to Azure Pronunciation Assessment with the passage as referenceText. Tracker follows word by word. |
| COACH | Word AccuracyScore < 60 (after leniency table, §9.3), or Omission, or pause > 3000ms on a word | Short coaching line ("Let's sound it out: b... l... ue"). Back to CHILD_READS on the same word. Max 2 coach attempts per word, then narrator says the word warmly and moves on. |
| ENCOURAGE | 2 consecutive passages with all words >= 80 accuracy | One short praise line naming something specific, then NARRATE. |
| TALK | Child taps the talk button (push-to-talk), any time | Pause current mode. Switch Azure to plain speech recognition. Transcribe, classify intent (§5), route. Then resume or transition. |
| REMIX | TALK intent = change_request ("I want dragons") | Discard the buffered next beat. Narrator acknowledges enthusiastically and regenerates the next beat + passage with the new theme but the SAME difficulty, SAME target skills, SAME must_use words. |
| ADAPT | 3+ COACH entries within one passage, or frustration detected | Difficulty down one level. Discard buffered beat. Regenerate next passage, shorter and simpler. |
| WRAP | Beat list complete or the session cap is reached | Narrator stops the story at a moment of tension and says when it picks up. One concrete thing she can do now that she could not before, then "one more bit?" — answered by voice or by button. Yes gives exactly one more beat. |
| END | She said no, she asked to stop, or the extra beat is finished | Warm goodbye, cliffhanger left standing. Save transcript. Asking to stop skips WRAP entirely: no upsell. |

Cross-cutting rules:
- Always keep ONE beat buffered; discard the buffer on REMIX, ADAPT, or a cameo.
- Every Azure word result is written to `reading_events` immediately.
- Silence in CHILD_READS: 8s gentle prompt, 20s more a friendly check-in, 45s total pause the session with a resume screen. Never nag more than twice.
- All mode transitions are appended to the session transcript with timestamps.

---

## 5. TALK mode and the intent router

The talk button (an owl, large and always visible) is the ONLY interruption mechanism in this MVP. No automatic off-script detection — deliberately out of scope.

Flow when tapped:
1. Immediately stop any TTS playback and stop pronunciation assessment.
2. Start plain Azure speech recognition.
3. No intelligible speech within 5s: playful nudge, return to the previous mode at the same word.
4. On transcript: ONE Haiku call (`lib/llm/absorb.ts`) does three jobs at once — classify the
   intent, write the single line Ollie says back, and extract what is worth keeping. One round
   trip, because the child is waiting through all of it.

   **The acknowledgment is never empty.** If she says something, Ollie says something. Model
   failure, network failure, schema failure — all of them still produce a line. A child who
   volunteers something and hears nothing has learned that talking to Ollie does nothing.

   The intent is one of:
   - `help_with_word` — answer DIRECTLY, then CHILD_READS.
   - `question_about_story` — answer it from inside the story. The answer is in the passage she is holding.
   - `question_about_world` — the question jar (§16). Ollie says he does not know and that they will find out; the question seeds a later session's plan.
   - `change_request` — enter REMIX.
   - `chitchat` — the acknowledgment is the whole response. Kept as a note (§16), never discussed, and the passage she is reading is never rewritten underneath her.
   - `want_to_stop` — enter END gracefully. Log `early_exit`. Never guilt-trip.
   - `sensitive_topic` — FIXED comfort template, never improvised, log a `sensitive_topic` flag for the parent, gently return to the story.
   - `unclear` — "Hmm, I didn't catch that! Want to tell me again, or keep reading?"

Sensitive topic template (hardcoded in `lib/templates.ts`): "That's a really big question, and I'm glad you told me. That's a great thing to talk about with your grown-up. They give the best hugs too. Should we find out what happens to [character]?"

---

## 6. Session plan schema

Generated by one `generateObject` call before each session, from child_memory + top 3 target skills.

```json
{
  "goal": "practice blend_bl, sight_friend; review short_a",
  "target_skills": ["blend_bl", "sight_friend", "short_a"],
  "premise": "Maya and Blue the dragon search for the lost bell",
  "characters": ["Blue the dragon (from canon)", "Maya (the child)"],
  "beats": ["Maya finds a torn map in the garden", "They cross the wobbly bridge", "The bell is found inside the old clock"],
  "difficulty": 3,
  "vocab_constraints": {
    "must_use_words": ["blue", "black", "friend", "map"],
    "max_sentence_words": 7,
    "allowed_patterns": "only skills with p_mastery > 0.5 plus target skills"
  }
}
```

---

## 7. Narrator agent contract

One conversation per session. System prompt includes child name/age, interests, personality_notes, canon, the session plan, and six hard rules. See `.claude/skills/narrator/SKILL.md`.

Every narrator call returns structured output:

```json
{
  "speak_text": "text the AI says aloud (sent to Cartesia)",
  "child_passage": "text the child reads next, or null",
  "plan_update": "optional: modified remaining beats",
  "current_beat_index": 1
}
```

Safety pass: before TTS, run `speak_text` + `child_passage` through one Haiku call with a yes/no rubric. On fail, regenerate once, then fall back to a safe template line. Log all failures.

---

## 8. Audio pipeline

### 8.1 Capture
- `getUserMedia` with `echoCancellation: true, noiseSuppression: true, autoGainControl: true`.
- AudioWorklet captures PCM, downsamples to 16kHz mono 16-bit, sends binary frames over the WebSocket.
- Server pushes frames into an Azure push-stream. Do NOT use the browser's SpeechRecognition API.

### 8.2 Half-duplex rule (echo prevention)
While Cartesia audio is playing:
- The server drops all incoming mic frames (server-side gate, authoritative).
- The client also pauses capture (belt and suspenders).
- Keep the gate closed for 300ms after playback ends (audio tail).

The talk button is the one exception: tapping it kills playback instantly (barge-in), then opens the mic.

### 8.3 Playback
Cartesia streaming output is forwarded over the WebSocket and played via Web Audio with a small jitter buffer. Target: first audible audio < 1s. While the child reads passage N, beat N+1 is already generated.

### 8.4 Mic check onboarding
A 15-second "say hi to Ollie!" screen. Verifies mic permission, audio path, and volume, and gives the child one successful voice interaction before any reading. If mic fails, show parent-facing fix instructions. Never start a session with an unverified mic.

---

## 9. Azure integration details

### 9.1 Reading mode
Streaming, server-side SDK, per passage: `referenceText` = the passage,
`gradingSystem: HundredMark`, `granularity: Phoneme`, `enableMiscue: true`.
Parse per-word `Word`, `AccuracyScore`, `ErrorType`, `Phonemes[]`. Feed each result to the state machine and write to `reading_events`.

### 9.2 Talk mode
A separate recognizer with no pronunciation config. Only ever active while the talk button session is open.

### 9.3 Leniency table (developmental speech)
Ages 4-6 routinely substitute phonemes. These are NOT reading errors: r→w, l→w/y, th→f/d/v, s/z lisped. Applied AFTER Azure scoring; if a word's only failing phonemes match, treat as passed and log `error_type = 'Developmental'`. Lives in `lib/leniency.ts` so it is easy to extend during kid testing.

### 9.4 Repeats and self-corrections
- Score each expected word by its BEST attempt in the passage.
- Ignore Insertion errors that repeat the previous 1-2 expected words.
- A self-correction that lands on the right word counts as correct (attempt = 2).

### 9.5 Reading ahead / skipping
Track the furthest matched word. Accept completion even if the path was messy. Never force a re-read of a word already passed.

### 9.6 Noise gating
In CHILD_READS, audio matching nothing in the reference text is ignored — not an error, not an interruption. Only the talk button interrupts.

---

## 10. Edge-case playbook

| # | Situation | Handling |
|---|---|---|
| 1 | App hears its own TTS voice | Half-duplex gate (8.2) |
| 2 | Background noise, siblings, TV | Noise gating (9.6) |
| 3 | "Wabbit" and friends | Leniency table (9.3) |
| 4 | Stutters, repeats, self-corrections | Best-attempt scoring (9.4) |
| 5 | Kid reads ahead or skips | Furthest-match tracking (9.5) |
| 6 | Kid goes silent / walks away | 8s nudge, 20s check-in, 45s pause screen (§4) |
| 7 | Kid is frustrated or overwhelmed | ADAPT + choice offer; log `frustration` flag |
| 8 | "Just tell me the answer!" | After 2 Socratic pushbacks, tell them warmly |
| 9 | "I'm done" | Graceful END, story wrapped, zero guilt (§5) |
| 10 | Heavy question | Fixed template + parent flag, never improvised (§5) |
| 11 | Kid asks for Elsa / Pokemon | Original stand-in character (§7 rule 4) |
| 12 | Talk button tapped, then silence | 5s timeout, playful nudge, resume (§5) |
| 13 | Mic broken or permission denied | Mic check screen blocks session start (8.4) |

---

## 11. Pedagogy module (pure TS, no LLM)

- `updateMastery(events)`: correct read `p += 0.15 * (1 - p)`; error `p -= 0.2 * p`. `Developmental` counts as correct. Only `attempt = 1` results update mastery.
- `pickTargets(mastery)`: lowest-mastery skills whose prerequisites have p > 0.7, plus one review skill (high mastery, oldest last_practiced).
- Interest decay lives in consolidation: weights *= 0.9 per consolidation; interests mentioned get +0.3; chitchat from TALK mode is a strong interest signal.

---

## 12. Consolidation (the button)

`POST /api/consolidate`, in order:
1. Copy current `child_memory` to `child_memory_history`.
2. Run `updateMastery` over all new `reading_events` since last consolidation.
3. One Sonnet call: current memory + session transcript → updated `{interests, personality_notes, canon}`.
4. Write updated memory, bump version.
5. Run `pickTargets`, pick up to two queued notes and the newest queued question
   (`pickPlanNotes`), generate the next session plan from them, store it, and mark
   those notes `used`. This is where a thing she said yesterday becomes what
   today's story is about.
6. Return a diff (old vs new memory) for the debug panel. "Watch it learn her."

---

## 13. API surface

- `WS /session` — the live session (audio up; TTS audio + UI events down)
- `POST /api/consolidate`
- `GET /api/memory` — current child_memory + mastery
- `GET /api/plan` — next session plan
- `POST /api/child` — create/edit the demo child + onboarding notes
- `GET /api/parent` — everything the parent view shows (read-only)

---

## 14. Build order

1. **Skeleton**: Next.js app, docker-compose.yml, schema migration, seed demo child, hardcoded session plan.
2. **Voice out**: Cartesia streaming TTS plays a hardcoded beat in the browser. Half-duplex gate scaffolding.
3. **Listening**: AudioWorklet capture, WS to server, Azure Pronunciation Assessment, per-word scores rendered live.
4. **Audio hardening**: mic check screen, echo test on a real laptop speaker+mic (no headphones), noise gating. Do not proceed until the app cannot hear itself.
5. **State machine**: NARRATE / CHILD_READS / COACH / ENCOURAGE with templated coach lines.
6. **TALK mode**: the button, barge-in, plain STT, Haiku intent router, `help_with_word`, `chitchat`, `want_to_stop`, sensitive-topic template. REMIX stubbed.
7. **Live narrator**: replace templates with the narrator agent, buffered beat generation, safety pass, real REMIX.
8. **ADAPT** + frustration path.
9. **Pedagogy + events**: reading_events writes, leniency table, best-attempt scoring, mastery math.
10. **Consolidate button** + memory diff view + next-plan generation.
11. **Demo polish**: story text on screen with current word highlighted, big friendly talk button, memory panel on the side.

Testing note: put the app in front of a real 4-6 year old no later than step 5. Every assumption about kid behaviour in this file is provisional until then.

---

## 15. Out of scope (do not build)

Auth, multi-child, payments, mobile, nightly cron, custom ASR, automatic off-script
detection (the talk button replaces it), agent frameworks, analytics, i18n, voice
cloning, avatar animation.

The read-only parent view at `/parent` is in scope and built; a parent *app* — accounts,
notifications, settings, anything that writes — is not.

---

## 16. Free-form in, story out

The child can say anything at any time. All of it is absorbed. Only one kind of thing
ever comes back out: the story, and the reading session around it.

Everything she says routes to exactly one of three destinations — the current story, a
future story, or what we understand about her. Nothing routes to open-ended conversation.

### The three speeds

1. **Immediately.** Acknowledge, do not act. One short line naming her detail back, and
   Ollie says he is keeping it. Then back to reading.
2. **Later this session.** At most ONE detail returns as background scenery in a later
   passage (`pickCameo`). Not the plot — just a presence, and nobody remarks on it.
3. **Next session.** A detail or a question becomes what the story is *about*
   (`pickPlanNotes`, consumed by the planner at consolidation).

The delay is deliberate. Instant rewriting is a gimmick, and it teaches a child that
interrupting reshapes the world — which is more fun than reading and will replace it. A
promise visibly kept a few minutes later, then paid off properly the next day, is what
makes the book feel alive. The `child_notes` row she can see in the notebook is how she
knows the rest were queued rather than forgotten.

### The caps are the quality control

`MAX_CAMEOS_PER_SESSION = 1` and `MAX_SUBJECTS_PER_PLAN = 2` are small integers rather
than a weighting model, because a small integer cannot fail in an interesting way. A
story built from everything she has ever said reads like a list, not a story.

### The question jar

"Why is the sky blue?" is not answered. Ollie says he does not know and that they will
find out — and the next session's story is someone climbing up to see. Curiosity
sustained beats curiosity resolved, especially at six. Questions about the story in
front of her are different: those get a real answer, immediately, because the answer is
in the passage she is holding and deflecting would read as evasion.

### Mood is absorbed, not discussed

"I'm tired today" does not open a conversation about feelings. It shortens the session
and drops the difficulty, silently. Tutors do this; therapists talk about it. She still
gets an answer out loud — a few words, then on with the story.

### The naming rule

Things personal to her are kept literally: her cat, her sister, her tooth, her friend.
Brands, public figures and known characters are generalized into their category — the
classifier is asked to do it, and `generalizeSubject` is the backstop.
