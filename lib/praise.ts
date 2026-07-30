/**
 * Choose which word to praise. Pure and deterministic.
 *
 * The narrator must never be asked to *recall* what the child read: its context
 * is full of other plausible words (the plan's must_use_words, the skill
 * vocabulary, earlier passages), and it will reach for one. A real session
 * praised "glad" — a skill-list example word — after the child read "glides".
 *
 * So code picks the word, the narrator is told to use that exact word, and the
 * result is verified.
 */

import { normalizeWord } from './skills';
import type { TrackedWord } from './types';

/** Words too small or too common to make praise feel specific. */
const TRIVIAL = new Set([
  'a', 'i', 'an', 'and', 'the', 'is', 'it', 'in', 'on', 'to', 'at', 'of', 'up',
  'go', 'so', 'we', 'he', 'me', 'my', 'no', 'do', 'was', 'has', 'had', 'her',
  'his', 'she', 'you', 'not', 'but', 'for', 'are',
]);

/**
 * The most praiseworthy word the child actually read: read cleanly on the first
 * try, substantive, and the strongest of those. Returns null when the passage
 * offers nothing worth singling out.
 */
export function pickPraiseWord(words: TrackedWord[]): string | null {
  const candidates = words.filter(
    (w) =>
      w.status === 'passed' &&
      w.attempts <= 1 &&
      w.bestScore !== null &&
      normalizeWord(w.expected).length >= 4 &&
      !TRIVIAL.has(normalizeWord(w.expected)),
  );

  const pool = candidates.length > 0
    ? candidates
    // Nothing substantive passed first-try — fall back to anything passed, so we
    // still praise a real word rather than inventing one.
    : words.filter((w) => w.status === 'passed' && !TRIVIAL.has(normalizeWord(w.expected)));

  if (pool.length === 0) return null;

  // Highest score wins; longer word breaks ties (more impressive to have read).
  const best = pool.slice().sort((a, b) => {
    const score = (b.bestScore ?? 0) - (a.bestScore ?? 0);
    if (score !== 0) return score;
    return normalizeWord(b.expected).length - normalizeWord(a.expected).length;
  })[0];

  // Strip display punctuation — the narrator should say the word, not "hops."
  return best.expected.replace(/^[^a-zA-Z']+|[^a-zA-Z']+$/g, '');
}

/**
 * Did the narrator actually use the word we told it to use?
 * Matched on word boundaries so "glide" does not satisfy a request for "glides".
 */
export function mentionsWord(text: string, word: string): boolean {
  const w = word.replace(/[^a-zA-Z']/g, '');
  if (!w) return true;
  return new RegExp(`\\b${w}\\b`, 'i').test(text);
}
