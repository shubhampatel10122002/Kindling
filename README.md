# Primer

A voice-based AI reading companion. The child reads a dynamically generated story
aloud; the narrator listens with pronunciation assessment, coaches stuck words,
answers questions Socratically, and adapts the story live. A **Consolidate**
button updates the child's memory model, which shapes the next session.

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

`npm run selftest` covers the tracker, the leniency table, the mastery math, and
Azure config construction — 48 assertions, runs in about a second. Run it after
touching any of those four files.

## Demo path

1. Mic check → "Start the story".
2. The narrator opens the story and hands over a passage; words light up green as
   they're read, amber when coaching kicks in.
3. Hold the owl and say something — try *"why is the dragon sad?"* (Socratic),
   *"I want trucks instead"* (remix), *"my dog is named Max"* (chitchat, becomes
   an interest signal).
4. Hit **Consolidate memory** in the right-hand panel and watch the diff: interests
   re-weighted, personality notes revised from evidence, canon threads added, and
   a freshly generated plan for next time.

The right-hand panel is the demo. It shows live mode, the last Azure per-word
scores, the current plan, the memory model, parent flags, and the memory diff.
