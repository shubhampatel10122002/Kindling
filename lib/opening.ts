/**
 * How a session starts.
 *
 * The tutor knows the child's local time of day and how long it has been since
 * the last session, and opens differently accordingly. That decision is a lookup
 * table, not a judgment call: the LLM is never asked "what should I say hello
 * with", because the answer depends on two numbers and a table reads them more
 * reliably than a model does.
 *
 * The opening question is a floor, not the only channel — she can interrupt with
 * the owl button at any point regardless. So we always ask exactly one thing,
 * and vary how much room it gives her.
 */

export type OpeningShape =
  /** Never met her. Onboarding handles this one. */
  | 'first_time'
  /** She was here within the last few hours. Barely ask; she has nothing new. */
  | 'quick_return'
  /** Earlier today. */
  | 'same_day'
  /** Yesterday, or overnight. The richest opening. */
  | 'new_day'
  /** Days. Ask what she has been up to. */
  | 'long_gap';

export interface OpeningPlan {
  shape: OpeningShape;
  /** What Ollie asks out loud before the story. */
  question: string;
  /** How long the doorway may stay open before we start writing. */
  doorwayMs: number;
  /** How many things she can tell us before we start writing. */
  maxTurns: number;
}

function pick<T>(arr: T[], rand: number): T {
  const i = Math.min(arr.length - 1, Math.max(0, Math.floor(rand * arr.length)));
  return arr[i];
}

/** Rough day part, from the child's clock rather than the server's. */
export function dayPart(localHour: number): 'morning' | 'afternoon' | 'evening' {
  if (localHour < 12) return 'morning';
  if (localHour < 17) return 'afternoon';
  return 'evening';
}

const QUICK_RETURN = [
  'Back already! Anything you want to tell me, or should we jump straight in?',
  "Hello again! Got something to tell me, or shall we read?",
  'Hey, you came back! Anything new, or straight to the story?',
];

const SAME_DAY = [
  'Hi again! Has anything happened since we last read?',
  'Hello again! What have you been doing since this morning?',
  'Hey! Anything new since last time?',
];

const NEW_DAY_MORNING = [
  'Good morning! How was your yesterday?',
  'Morning! Tell me one thing about yesterday.',
  'Hi! What happened yesterday?',
];

const NEW_DAY_AFTERNOON = [
  'Hello! How has your day been so far?',
  'Hi! What have you been up to today?',
  'Hey! Tell me something about today.',
];

const NEW_DAY_EVENING = [
  'Hi! How was your day?',
  'Hello! Tell me about your day.',
  'Hey! What was today like?',
];

const LONG_GAP = [
  "It's been a few days! What have you been up to?",
  "There you are! I've missed you. What have you been doing?",
  "It's been a while! Tell me everything I missed.",
];

/**
 * Pick the opening. `hoursSinceLast` is null when we have never met her.
 * `rand` is injectable so the self-test can pin a variant.
 */
export function planOpening(args: {
  hoursSinceLast: number | null;
  localHour: number;
  rand?: number;
}): OpeningPlan {
  const { hoursSinceLast, localHour } = args;
  const rand = args.rand ?? Math.random();

  if (hoursSinceLast === null) {
    return { shape: 'first_time', question: '', doorwayMs: 0, maxTurns: 0 };
  }

  // Came back within a few hours. She has nothing new to report and asking
  // "how was your day?" twice in an afternoon is how a tutor stops sounding real.
  if (hoursSinceLast < 3) {
    return {
      shape: 'quick_return',
      question: pick(QUICK_RETURN, rand),
      doorwayMs: 20_000,
      maxTurns: 1,
    };
  }

  if (hoursSinceLast < 20) {
    return { shape: 'same_day', question: pick(SAME_DAY, rand), doorwayMs: 35_000, maxTurns: 2 };
  }

  if (hoursSinceLast < 72) {
    const part = dayPart(localHour);
    const bank =
      part === 'morning'
        ? NEW_DAY_MORNING
        : part === 'afternoon'
          ? NEW_DAY_AFTERNOON
          : NEW_DAY_EVENING;
    return { shape: 'new_day', question: pick(bank, rand), doorwayMs: 60_000, maxTurns: 2 };
  }

  return { shape: 'long_gap', question: pick(LONG_GAP, rand), doorwayMs: 60_000, maxTurns: 2 };
}

/**
 * One sentence proving we remember her specifically, or null when we have
 * nothing concrete enough to be worth saying.
 *
 * Deliberately built from stored facts rather than generated: a remembered
 * detail that turns out to be invented is worse than no remembered detail.
 */
export function rememberLine(args: {
  /** Something she volunteered last time. */
  lastNoteSubject?: string | null;
  /** An unresolved thread from the last story. */
  openThread?: string | null;
  rand?: number;
}): string | null {
  const rand = args.rand ?? Math.random();
  const note = args.lastNoteSubject?.trim();
  const thread = args.openThread?.trim();

  if (note) {
    return pick(
      [
        `I kept thinking about ${note}.`,
        `I still remember what you told me about ${note}.`,
        `I wrote down ${note} last time, remember?`,
      ],
      rand,
    );
  }

  if (thread) {
    return pick(
      [`Last time we left off: ${thread}.`, `We still have this hanging: ${thread}.`],
      rand,
    );
  }

  return null;
}
