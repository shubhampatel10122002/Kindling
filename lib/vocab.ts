/**
 * Deterministic vocab-constraint checking. PLAN.md §6 vocab_constraints.
 *
 * This used to be part of the LLM safety rubric, which was a mistake: given a
 * free-text `allowed_patterns` string, Haiku would litigate whether "sniffs" is
 * CVC or CCVC and veto perfectly good passages. Sentence length is arithmetic —
 * deterministic code decides what happens, the LLM only decides what words to say.
 */

import { tokenize } from '../server/tracker';
import type { SessionPlan } from './types';

export interface VocabProblem {
  kind: 'sentence_too_long' | 'missing_must_use';
  detail: string;
}

export interface VocabCheck {
  ok: boolean;
  problems: VocabProblem[];
  /** Feedback to hand back to the narrator on a regeneration attempt. */
  feedback: string;
}

/** Split on sentence-final punctuation, keeping only non-empty fragments. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /[a-zA-Z]/.test(s));
}

/**
 * Check a child passage against the plan's constraints.
 *
 * Deliberately checks only what is objectively checkable. We do NOT try to
 * enforce `allowed_patterns` — it is prose written for the narrator's benefit,
 * not a grammar, and pretending otherwise is what caused the original bug.
 * Passage difficulty is steered by the narrator prompt and corrected by ADAPT.
 */
export function checkVocab(
  passage: string | null,
  constraints: SessionPlan['vocab_constraints'],
): VocabCheck {
  if (!passage || !passage.trim()) {
    return { ok: true, problems: [], feedback: '' };
  }

  const problems: VocabProblem[] = [];
  const max = constraints.max_sentence_words;

  for (const sentence of splitSentences(passage)) {
    const count = tokenize(sentence).length;
    if (count > max) {
      problems.push({
        kind: 'sentence_too_long',
        detail: `"${sentence}" has ${count} words (limit ${max})`,
      });
    }
  }

  const feedback = problems.length
    ? `The child passage broke these constraints: ${problems
        .map((p) => p.detail)
        .join('; ')}. Rewrite the passage so every sentence is at most ${max} words. Keep the same story beat.`
    : '';

  return { ok: problems.length === 0, problems, feedback };
}
