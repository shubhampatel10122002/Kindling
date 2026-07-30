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
