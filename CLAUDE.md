# Primer

Read **PLAN.md** first. Follow its build order and conventions.

## The one rule

**Deterministic code decides what happens; the LLM only decides what words to say.**

Mode transitions, scoring, coaching thresholds, mastery math, and safety gates are
plain TypeScript. The narrator LLM never chooses the next mode — it is told the
mode and asked for words.

## Layout

| Path | What lives there |
|---|---|
| `server/index.ts` | WebSocket server (port 3001). One session per connection. |
| `server/session.ts` | The state machine. Owns modes, timers, half-duplex gate, persistence. |
| `server/tracker.ts` | Word-by-word passage following: best-attempt scoring, repeats, reading ahead, noise gating. |
| `server/azure.ts` | Pronunciation assessment (reading) + plain STT (talking). |
| `server/cartesia.ts` | Streaming TTS over the raw WebSocket, with per-context cancel for barge-in. |
| `lib/leniency.ts` | Developmental-speech table. Extend this during kid testing. |
| `lib/pedagogy.ts` | Mastery math and target selection. Pure, no LLM. |
| `lib/opening.ts` | How a session opens, from local time and the gap since the last one. Pure. |
| `lib/notes.ts` | The notebook: when a volunteered detail is allowed to surface. Pure. |
| `lib/progress.ts` | "Words she can read now that she couldn't", and the parent view's history. |
| `lib/skills.ts` | The skill list and word→skill mapping. |
| `lib/llm/*` | Narrator, planner, absorb pass, safety pass, consolidation. |
| `app/api/*` | REST surface (§13). |
| `app/parent/*` | Read-only parent view. |
| `components/*` | Session UI, parent view, debug panel. |

## Conventions

- **Model IDs** live in `lib/env.ts` (`MODELS`). Sonnet for anything the child
  hears; Haiku for classification and the safety pass.
- **Never call the Anthropic API without `lib/llm/client.ts`.** It normalises
  `ANTHROPIC_BASE_URL`, which is set without `/v1` on any machine with Claude
  Code installed and otherwise 404s every request.
- **Audio**: mic is 16kHz mono PCM16 (Azure's requirement); TTS is 44.1kHz mono
  float32 (Web Audio's native format). Constants in `lib/env.ts` (`AUDIO`).
- **Wire protocol**: binary frames are audio (mic up, TTS down), text frames are
  JSON `ClientMessage` / `ServerMessage` from `lib/types.ts`.
- **`reading_events` is append-only.** Never UPDATE or DELETE.
- Only `attempt = 1` results update mastery, so coached retries can't inflate it.
- **If the child says something, Ollie says something.** The acknowledgment in
  `lib/llm/absorb.ts` has a template fallback on every failure path, and nothing may
  be added that can make it empty. Being ignored is the one failure a child
  generalises from.
- **Never rewrite the passage she is currently reading.** Volunteered details wait:
  one cameo later this session, the subject of a story tomorrow (§16).

## Commands

```bash
npm run db:reset   # drop, migrate, seed the demo child
npm run selftest   # deterministic core, no network or DB needed
npm run smoke      # verifies Postgres, Anthropic, Azure, Cartesia credentials
npm run dev        # Next.js on :3000 + WS server on :3001
```

Run `npm run selftest` after touching `tracker.ts`, `leniency.ts`, `pedagogy.ts`,
`skills.ts`, `opening.ts`, or `notes.ts` — those files carry the behaviour that is
hardest to eyeball and easiest to break.

`DUMP_AZURE=1 npm run ws` prints the raw per-word JSON for every utterance. That is
the only place the evidence lives when a word lights up that was never spoken.

## Gotchas found the hard way

- The published `@cartesia/cartesia-js` pins `Cartesia-Version: 2024-06-10`,
  which predates the `sonic-3` family. We talk to the WebSocket directly.
- Azure's typed `detailResult` omits per-phoneme scores. Parse the raw
  `SpeechServiceResponse_JsonResult` instead (`server/azure.ts` does).
- Leniency false positives are expensive: forgiving a word silently switches
  coaching off. `lib/leniency.ts` only forgives with evidence of the actual
  substitution, or from a short list of the best-attested ones.
