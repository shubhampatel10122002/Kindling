/**
 * The little "Nice!" between the child's turn and the narrator's.
 *
 * Model-generated so it fits what the child just did, but sanitised here:
 * anything that is not a short spoken acknowledgment gets rejected, and the
 * caller falls back to a template. Keeping this pure makes it testable.
 */

import type { TrackedWord } from './types';

export const MAX_ACK_WORDS = 6;

/** How the passage went, in the terms an acknowledgment should react to. */
export interface ReadingQuality {
  total: number;
  cleanFirstTry: number;
  coached: number;
  given: number;
  /** flawless | solid | effortful — what the acknowledgment should match. */
  band: 'flawless' | 'solid' | 'effortful';
}

export function summarizeReading(words: TrackedWord[]): ReadingQuality {
  const total = words.length;
  const cleanFirstTry = words.filter((w) => w.status === 'passed' && w.attempts <= 1).length;
  const coached = words.filter((w) => w.attempts > 1 || w.status === 'coaching').length;
  const given = words.filter((w) => w.status === 'given').length;

  const band: ReadingQuality['band'] =
    given === 0 && coached === 0 && cleanFirstTry === total
      ? 'flawless'
      : given > 0 || coached >= 2
        ? 'effortful'
        : 'solid';

  return { total, cleanFirstTry, coached, given, band };
}

/**
 * Accept only a genuine short interjection.
 *
 * Rejects anything that names a word (the "praised a word they never said" bug
 * class), adds story content, or runs long enough to stop feeling like a
 * transition.
 */
export function sanitizeAcknowledgment(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let s = raw
    .trim()
    // Models like to wrap short answers in quotes.
    .replace(/^["'`\s]+|["'`\s]+$/g, '')
    // Strip markdown emphasis and emoji.
    .replace(/[*_#`~]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!s) return null;

  // A remaining quote means it is citing a word — exactly what we avoid.
  if (/["“”]/.test(s)) return null;
  // Digits are never part of a natural acknowledgment.
  if (/\d/.test(s)) return null;
  // Multiple sentences means it started telling the story.
  if ((s.match(/[.!?]/g) ?? []).length > 1) return null;

  const words = s.split(' ').filter(Boolean);
  if (words.length === 0 || words.length > MAX_ACK_WORDS) return null;

  // Must end with punctuation so TTS gives it the right prosody.
  if (!/[.!?]$/.test(s)) s += '!';

  return s;
}

/** A spoken line may run this long before it stops being an acknowledgment. */
export const MAX_SPOKEN_WORDS = 16;

/**
 * Did she say yes?
 *
 * Used for exactly one question — "want one more bit?" — so it is a word list
 * rather than a model call. A five-year-old answering that question says "yeah"
 * or "no" or nothing, and routing that through an LLM would add a second of
 * latency to a decision a Set can make. Returns null when she said neither, and
 * the caller treats that as no: a session that ends early is a session she
 * wanted more of.
 */
const YES = new Set([
  'yes', 'yeah', 'yep', 'yup', 'ya', 'yah', 'sure', 'ok', 'okay', 'please',
  'more', 'again', 'course',
]);
const NO = new Set([
  'no', 'nope', 'nah', 'done', 'stop', 'finished', 'bye', 'tired', 'goodbye',
]);

export function parseYesNo(raw: string | null | undefined): boolean | null {
  if (!raw) return null;
  const words = raw.toLowerCase().match(/[a-z']+/g) ?? [];
  if (words.length === 0) return null;

  // "no thanks, I'm done" and "yes please" both lead with the answer, so the
  // first decisive word wins rather than whichever appears last.
  for (const w of words) {
    if (NO.has(w)) return false;
    if (YES.has(w)) return true;
  }
  return null;
}

/**
 * Looser sibling of the above, for the line Ollie says back when the child
 * volunteers something.
 *
 * This one is allowed to name her detail — that is the entire point of it — so
 * it keeps quotes and proper nouns. What it enforces is brevity and speakability:
 * it is going straight to TTS, and a paragraph here is Ollie discussing her
 * feelings instead of absorbing them.
 *
 * Returns null when the model produced something unusable, so the caller can
 * fall back to a template. It must never return an empty line: if she said
 * something, she gets an answer.
 */
export function sanitizeSpokenLine(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let s = raw
    .trim()
    .replace(/^["'`\s]+|["'`\s]+$/g, '')
    .replace(/[*_#`~]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    // Stage directions, which models add to anything they think is dialogue.
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!s) return null;

  // More than two sentences means it started a conversation rather than closing one.
  if ((s.match(/[.!?]/g) ?? []).length > 2) return null;

  const words = s.split(' ').filter(Boolean);
  if (words.length === 0 || words.length > MAX_SPOKEN_WORDS) return null;

  if (!/[.!?]$/.test(s)) s += '!';

  return s;
}
