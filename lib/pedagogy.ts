/** Pedagogy module. Pure TS, no LLM calls. PLAN.md §11. */

import { SKILLS, SKILL_BY_ID, skillsForWord } from './skills';
import type { Mastery } from './types';

export interface ReadingEventRow {
  expected_word: string;
  attempt: number;
  error_type: string | null;
  accuracy_score: number | null;
}

export interface MasteryUpdate {
  skill_id: string;
  p_mastery: number;
  last_practiced: Date;
}

const CORRECT_GAIN = 0.15;
const ERROR_LOSS = 0.2;

/**
 * Simplified Bayesian-ish mastery update.
 *   correct: p += 0.15 * (1 - p)
 *   error:   p -= 0.2  * p
 * 'Developmental' counts as correct. Only attempt = 1 results update mastery,
 * so coached retries can't inflate it.
 */
export function updateMastery(
  events: ReadingEventRow[],
  current: Mastery[],
  now: Date = new Date(),
): MasteryUpdate[] {
  const p = new Map<string, number>();
  const touched = new Map<string, Date>();
  for (const m of current) p.set(m.skill_id, m.p_mastery);

  for (const e of events) {
    if (e.attempt !== 1) continue;

    const skills = skillsForWord(e.expected_word ?? '');
    if (skills.length === 0) continue;

    const correct = e.error_type === 'None' || e.error_type === 'Developmental' || e.error_type === null;

    for (const skillId of skills) {
      const prior = p.get(skillId) ?? 0.2;
      const next = correct ? prior + CORRECT_GAIN * (1 - prior) : prior - ERROR_LOSS * prior;
      p.set(skillId, Math.min(0.99, Math.max(0.01, next)));
      touched.set(skillId, now);
    }
  }

  return [...touched.keys()].map((skill_id) => ({
    skill_id,
    p_mastery: p.get(skill_id)!,
    last_practiced: touched.get(skill_id)!,
  }));
}

const MASTERED = 0.7;

/**
 * Pick 3 target skills: the lowest-mastery skills whose prerequisites are met
 * (p > 0.7), plus one review skill (high mastery, oldest last_practiced).
 */
export function pickTargets(mastery: Mastery[]): string[] {
  const byId = new Map(mastery.map((m) => [m.skill_id, m]));
  const p = (id: string) => byId.get(id)?.p_mastery ?? 0.2;

  const eligible = SKILLS.filter((s) => s.prerequisites.every((pre) => p(pre) > MASTERED));

  const growth = eligible
    .filter((s) => p(s.id) <= MASTERED)
    .sort((a, b) => p(a.id) - p(b.id))
    .slice(0, 2)
    .map((s) => s.id);

  const reviewPool = SKILLS.filter((s) => p(s.id) > MASTERED);
  const review = reviewPool
    .sort((a, b) => {
      const at = byId.get(a.id)?.last_practiced;
      const bt = byId.get(b.id)?.last_practiced;
      return new Date(at ?? 0).getTime() - new Date(bt ?? 0).getTime();
    })
    .slice(0, 1)
    .map((s) => s.id);

  const picked = [...growth, ...review];

  // Always return 3, even on a cold-start profile with nothing practiced yet.
  for (const s of eligible) {
    if (picked.length >= 3) break;
    if (!picked.includes(s.id)) picked.push(s.id);
  }
  return picked.slice(0, 3);
}

/** Skills the child can already handle — feeds vocab_constraints.allowed_patterns. */
export function comfortableSkills(mastery: Mastery[], threshold = 0.5): string[] {
  return mastery.filter((m) => m.p_mastery > threshold).map((m) => m.skill_id);
}

/** Interest decay applied at consolidation: weights *= 0.9, mentions get +0.3. */
export function decayInterests<T extends { topic: string; weight: number }>(interests: T[]): T[] {
  return interests
    .map((i) => ({ ...i, weight: Math.round(i.weight * 0.9 * 100) / 100 }))
    .filter((i) => i.weight > 0.05);
}

export function describeTargets(ids: string[]): string {
  return ids.map((id) => SKILL_BY_ID.get(id)?.description ?? id).join(', ');
}
