---
name: narrator
description: Narrator agent prompt template, structured output contract, and mode instructions
---

# Narrator agent

Implementation: `lib/llm/narrator.ts`. One `Narrator` instance per session, one
continuous conversation. The state machine picks the mode; the narrator only
picks the words.

## Structured output contract

Every turn returns exactly this (zod-validated via `generateObject`):

```jsonc
{
  "speak_text": "text the AI says aloud (sent to Cartesia)",
  "child_passage": "text the child reads next, or null",
  "plan_update": "optional: modified remaining beats, or null",
  "current_beat_index": 1
}
```

- `speak_text` goes straight to TTS. Written to be **spoken**: no markdown, no
  stage directions, no emoji.
- `child_passage` is `null` for any turn where the child should not be reading
  (COACH, SOCRATIC, CHITCHAT, ANSWER_DIRECTLY, CLOSING).

## System prompt structure

Built once per session by `buildSystemPrompt()`, rebuilt only when the plan
changes (REMIX / ADAPT). Sections, in order:

1. **Who the child is** — name, age, parent onboarding notes, weighted
   interests, personality notes, canon characters, open threads from past sessions.
2. **This session plan** — goal, premise, characters, beats, difficulty,
   must-use words, max sentence length, allowed spelling patterns.
3. **Hard rules** (the six from PLAN.md §7, verbatim in intent):
   1. Warm, playful, age-appropriate. Short sentences. No lecturing.
   2. Socratic **only** for thinking questions; procedural questions always get
      a direct, kind answer.
   3. Child passages obey vocab constraints and work in must-use words naturally.
   4. Nothing scary/violent/sad-about-family. No brand or IP — offer an original
      stand-in ("a snow queen named Elka").
   5. Stay in the story world; weave interruptions back within one sentence.
   6. On frustration: get easier and shorter immediately, and offer a choice.
4. **Output format** notes.

## Mode instructions

The state machine passes a `NarratorMode` plus free-text context. Modes:

| Mode | When | Passage? |
|---|---|---|
| `OPENING` | session start | yes |
| `NEXT_BEAT` | passage finished cleanly | yes |
| `COACH` | stuck on a word (LLM path; templates handle early builds) | no |
| `ENCOURAGE` | 2 consecutive strong passages | yes |
| `SOCRATIC` | thinking question — ONE guiding question | no |
| `ANSWER_DIRECTLY` | procedural question, or 4th Socratic turn | no |
| `CHITCHAT` | child shared something about their life | no |
| `REMIX` | change request — same difficulty/skills/words, new costume | yes |
| `ADAPT` | struggling — shorter, simpler, offer a choice | yes |
| `CLOSING` | END — wrap in one beat, never a cliffhanger | no |

**REMIX is the subtle one**: the child changes the costume, the lesson stays.
Always restate difficulty, target skills, and must-use words in the context
string so the model cannot quietly drop them.

## Never ask the narrator to recall a fact

If deterministic code already knows something, tell the narrator — do not ask it
to remember. Its context is full of plausible-but-wrong alternatives (the plan's
`must_use_words`, skill example words, earlier passages) and it will reach for
one. A real session praised **"glad"** — the canonical `blend_gl` example word —
after the child read **"glides"**.

`turn()` takes a `mustMention` option for this:

```ts
const praiseWord = pickPraiseWord(tracker.words);   // lib/praise.ts, pure
await narrator.turn('ENCOURAGE', context, { mustMention: praiseWord });
```

It adds a HARD CONSTRAINT line to the prompt, then **verifies in code** that the
word appears (`mentionsWord`, word-boundary matched so "glide" fails for
"glides"). One retry with a correction; still wrong and it falls back to
`T.encourageLine(word)`, which is a template that cannot get the word wrong.

Same principle as moving `vocab_constraints` out of the safety rubric: anything
checkable belongs in TypeScript.

## Safety pass

Before **any** text reaches TTS, `lib/llm/safety.ts` runs a Haiku yes/no rubric
over `speak_text` + `child_passage`:

- `age_appropriate`
- `on_story`
- `obeys_vocab_constraints` (checks the **child passage** only; passes if null)
- `withheld_answer_if_socratic` (passes when mode isn't SOCRATIC)
- `no_brand_or_ip`

On failure: regenerate once with the rejection reason appended, re-check, and if
it fails again fall back to a template line from `lib/templates.ts`. All failures
are logged.

The safety pass **fails open** on transport errors. A Haiku outage must not brick
a live session, and the narrator's own system prompt already carries the same
hard rules.

## Conversation management

History is `[user: mode+context, assistant: JSON]` pairs, trimmed to the last 40
messages so a 15-minute session cannot grow unbounded. A turn is only appended to
history **after** it passes safety — rejected drafts never become context.

## Things that are deliberately NOT the narrator's job

- Choosing the next mode (state machine).
- Deciding whether a word was read correctly (Azure + `lib/leniency.ts`).
- The sensitive-topic response — that is a **fixed template** in
  `lib/templates.ts` and must never be LLM-generated.
- Deciding when to stop (timers and the intent router).
