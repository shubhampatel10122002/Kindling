/**
 * Developmental speech leniency. PLAN.md §9.3.
 *
 * Ages 4-6 routinely substitute phonemes. These are NOT reading errors and must
 * not trigger COACH. Applied AFTER Azure scoring: if a word's only failing
 * phonemes match this table, treat the word as passed and log
 * error_type = 'Developmental'.
 *
 * Keep this table easy to extend during kid testing — that is the whole point
 * of it living in its own file.
 *
 * Design note: this table is deliberately conservative. A false positive here is
 * expensive — it silently switches coaching off for a word the child genuinely
 * cannot read — so we forgive a phoneme only when Azure tells us what it
 * actually heard and that sound is a known substitution. Without that evidence
 * we fall back to a narrow list of the best-attested substitutions plus a floor
 * on the overall word score.
 */

import type { WordAssessment } from './types';

/**
 * Expected phoneme -> substitutions a 4-6 year old routinely makes.
 * Phoneme symbols are Azure's IPA-ish output, lowercased.
 *
 * Deliberately excluded: velar fronting (k→t, g→d). It typically resolves by
 * ~3;6, and keying on /k/ and /g/ forgives a large share of common words
 * (cat, go, come, back) on the strength of one weak phoneme.
 */
export const DEVELOPMENTAL_SUBSTITUTIONS: Record<string, string[]> = {
  // r -> w  ("wabbit")
  r: ['w', 'ʋ', 'ʁ'],
  ɹ: ['w', 'ʋ', 'ʁ'],
  ɝ: ['w', 'ɚ', 'ə'],
  ɚ: ['w', 'ə'],
  // l -> w or y  ("wion", "yion")
  l: ['w', 'j', 'ʋ'],
  ɫ: ['w', 'j', 'ʋ'],
  // th -> f, d, v, s, t  ("fing", "dat", "vis")
  θ: ['f', 's', 't'],
  ð: ['d', 'v', 'z'],
  // s / z lisped (interdental)
  s: ['θ', 'ʃ'],
  z: ['ð', 'ʒ'],
  // affricate softening
  tʃ: ['ʃ', 't', 'ts'],
  dʒ: ['ʒ', 'd', 'dz'],
  ʃ: ['s'],
  ʒ: ['z'],
  // v -> b (stopping)
  v: ['b'],
};

/**
 * The subset we will forgive WITHOUT evidence of the actual substitution.
 * These are the ones where a low score on that phoneme is overwhelmingly likely
 * to be the classic developmental swap rather than a reading failure.
 */
const FORGIVE_WITHOUT_EVIDENCE = new Set(['r', 'ɹ', 'ɝ', 'ɚ', 'θ', 'ð', 'l', 'ɫ']);

/** A phoneme scoring below this is treated as "failed" for leniency purposes. */
export const PHONEME_FAIL_THRESHOLD = 60;

/** Word-level accuracy below this triggers COACH (before leniency). PLAN.md §4. */
export const WORD_FAIL_THRESHOLD = 60;

/** Two consecutive passages at or above this = ENCOURAGE. PLAN.md §4. */
export const WORD_STRONG_THRESHOLD = 80;

/**
 * Below this the word is too far off to be a substitution — the child read a
 * different word, or did not read it at all. Never forgiven.
 */
export const LENIENCY_SCORE_FLOOR = 30;

/**
 * At most this fraction of a word's phonemes may fail and still be forgiven.
 * A word where most sounds are wrong is not a lisp; it is an unknown word.
 */
export const MAX_FORGIVEN_FRACTION = 0.5;

export interface LeniencyVerdict {
  /** True when the word should be treated as correctly read. */
  passed: boolean;
  /** Error type to persist to reading_events. */
  errorType: WordAssessment['errorType'];
  /** Which phonemes were forgiven, for the debug panel. */
  forgiven: string[];
}

/** Is `actual` a known developmental substitution for `expected`? */
function isKnownSubstitution(expected: string, actual: string[] | undefined): boolean {
  const allowed = DEVELOPMENTAL_SUBSTITUTIONS[expected.toLowerCase()];
  if (!allowed) return false;

  // With evidence, require the substitution to actually be one we forgive.
  if (actual && actual.length > 0) {
    return actual.some((a) => allowed.includes(a.toLowerCase()));
  }

  // Without evidence, only the best-attested substitutions get the benefit of
  // the doubt.
  return FORGIVE_WITHOUT_EVIDENCE.has(expected.toLowerCase());
}

/**
 * Decide whether a word that Azure scored as a miss is actually a developmental
 * substitution rather than a reading error.
 */
export function applyLeniency(assessment: WordAssessment): LeniencyVerdict {
  const { accuracyScore, errorType, phonemes } = assessment;

  // Clean read, or a genuine structural error we never forgive.
  if (errorType === 'None' && accuracyScore >= WORD_FAIL_THRESHOLD) {
    return { passed: true, errorType: 'None', forgiven: [] };
  }
  if (errorType === 'Omission' || errorType === 'Insertion') {
    return { passed: false, errorType, forgiven: [] };
  }

  // Too far off to be a substitution — this is a different word entirely.
  if (accuracyScore < LENIENCY_SCORE_FLOOR) {
    return { passed: false, errorType: 'Mispronunciation', forgiven: [] };
  }

  const failing = phonemes.filter((p) => p.accuracyScore < PHONEME_FAIL_THRESHOLD);

  // No phoneme detail (Azure sometimes returns none) — fall back to the word score.
  if (failing.length === 0) {
    const passed = accuracyScore >= WORD_FAIL_THRESHOLD;
    return { passed, errorType: passed ? 'None' : 'Mispronunciation', forgiven: [] };
  }

  // A word where most sounds are wrong is not a lisp.
  if (phonemes.length > 0 && failing.length / phonemes.length > MAX_FORGIVEN_FRACTION) {
    return { passed: false, errorType: 'Mispronunciation', forgiven: [] };
  }

  const allDevelopmental = failing.every((p) => isKnownSubstitution(p.phoneme, p.actual));
  if (allDevelopmental) {
    return {
      passed: true,
      errorType: 'Developmental',
      forgiven: failing.map((p) => p.phoneme),
    };
  }

  return { passed: false, errorType: 'Mispronunciation', forgiven: [] };
}
