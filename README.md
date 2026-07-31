# Primer

A voice-based AI reading companion. The child reads a dynamically generated story
aloud; the narrator listens with pronunciation assessment, coaches stuck words, and
adapts the story live.

She can say anything at any time, and all of it is absorbed — but only one kind of
thing ever comes back out: the story. Something she mentions today turns up as
background scenery a few minutes later, and as what the story is *about* tomorrow.
A question about the world is never answered on the spot; it goes in the jar and
becomes a later session's story. A **Consolidate** button folds the session into
the child's memory model, which shapes the next one.

Full spec in [PLAN.md](./PLAN.md). Conventions in [CLAUDE.md](./CLAUDE.md).

## Setup

```bash
# 1. Credentials
cp .env.example .env.local        # then fill in the five keys

# 2. Database
docker compose up -d
npm install
npm run db:reset                  # migrate + seed the demo child

# 3. Verify everything is reachable
npm run smoke
```

`npm run smoke` checks Postgres, both Anthropic models, Azure Speech, and
Cartesia, and prints exactly which one is failing. Get it fully green before
running a session — a missing credential shows up mid-story otherwise.

### `relation "children" does not exist`

The schema was never applied. `docker compose up -d` creates the `primer`
**database** automatically, so connecting succeeds even with zero tables — which
is why this looks like a connection problem but isn't. Fix:

```bash
npm run db:reset
```

`db:migrate` prints the database it is targeting and verifies all 9 tables exist
afterwards, so if it reports success against the wrong target you'll see it. Note
that an exported `DATABASE_URL` in your shell takes precedence over `.env.local`.

## Run

```bash
npm run dev     # Next.js on :3000 and the session WebSocket server on :3001
```

Open <http://localhost:3000>. You'll get the mic-check screen first ("say hi to
Ollie!"); the session cannot start until the microphone is verified.

**Test on laptop speakers, not headphones.** The half-duplex gate is the thing
most likely to break a demo, and headphones hide the problem entirely.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Next.js + WebSocket server together |
| `npm run smoke` | Verify all four external dependencies |
| `npm run selftest` | Deterministic core — no network, no DB |
| `npm run db:reset` | Drop, migrate, re-seed |
| `npm run check` | TypeScript, no emit |
| `npm run build` | Production build |

`npm run selftest` covers the tracker and its noise gating, the leniency table, the
mastery math, the session-opening table, the notebook caps, and Azure config
construction — 146 assertions, runs in about a second. Run it after touching any of
those files.

`DUMP_AZURE=1 npm run ws` prints the raw per-word JSON Azure returns for each
utterance, which is what to reach for if a word ever lights up that was not spoken.

## Demo path

1. Mic check → "Start the story".
2. **The doorway.** Ollie asks one question, chosen from the time of day and how long
   it has been since the last session. Tell him something — *"I lost a tooth"*. He
   names it back, says he is keeping it, and starts writing. It shows up in the
   notebook on screen so nothing looks forgotten.
3. The story opens and hands over a passage. Words light up as they are read: deep
   green for confident, pale green for close enough, amber when coaching kicks in.
   The highlight tracks her voice in real time rather than a second behind it.
4. Hold the owl and say something — try *"why is the dragon sad?"* (answered, from
   inside the story), *"why is the sky blue?"* (the jar: Ollie doesn't know, and
   tomorrow's story is someone climbing up to see), *"I want trucks instead"*
   (remix), *"my cat is named Pepper"* (kept, and back to reading).
5. Watch the tooth come back as scenery in a later passage. Once.
6. **The ending.** The story stops at a moment of tension, Ollie names one word she
   can read now that she couldn't before, and offers exactly one more bit.
7. Hit **Consolidate memory** and watch the diff: interests re-weighted, personality
   notes revised from evidence, canon threads added, and next session's plan built
   around what she told you.
8. Open **/parent** to see the whole journey: progress, words that stopped being
   hard, words that haven't, the question jar, and everything she has shared.

The right-hand panel is the demo. It shows live mode, the last Azure per-word
scores, the current plan, the memory model, parent flags, and the memory diff.
