import { generateObject } from 'ai';
import { z } from 'zod';
import { model } from './client';
import type { SessionPlan } from '../types';
import type { NarratorTurn } from './narrator';

const schema = z.object({
  age_appropriate: z.boolean(),
  on_story: z.boolean(),
  obeys_vocab_constraints: z.boolean(),
  withheld_answer_if_socratic: z.boolean(),
  no_brand_or_ip: z.boolean(),
  reason: z.string().describe('Empty string when everything passed; otherwise the single worst problem.'),
});

export interface SafetyVerdict {
  ok: boolean;
  reason: string;
}

/**
 * Yes/no rubric run over speak_text + child_passage before TTS. PLAN.md §7.
 * Fails open on transport errors — a Haiku outage must not brick a live session,
 * and the narrator prompt already carries the same hard rules.
 */
export async function runSafetyPass(args: {
  turn: NarratorTurn;
  plan: SessionPlan;
  mode: string;
}): Promise<SafetyVerdict> {
  const { turn, plan, mode } = args;

  try {
    const { object } = await generateObject({
      model: model.safety(),
      schema,
      system: [
        'You are a strict safety and pedagogy checker for a reading app used by a young child.',
        'You are given text an AI narrator is about to say aloud, and the passage the child will read.',
        'Answer each check honestly. A single failure means the text must be regenerated.',
        '',
        'Checks:',
        '- age_appropriate: nothing scary, violent, or sad about family; warm and simple language.',
        '- on_story: it belongs to the story world described by the plan (or is a natural response to the child).',
        '- obeys_vocab_constraints: the CHILD PASSAGE (ignore the narrator text for this check) stays within the max sentence length and uses the allowed spelling patterns. If child_passage is null, this check passes.',
        '- withheld_answer_if_socratic: if MODE is SOCRATIC, the narrator asked a guiding question instead of just giving the answer. If MODE is not SOCRATIC, this check passes.',
        '- no_brand_or_ip: no real-world brands or copyrighted characters (Elsa, Pokemon, Marvel, Disney, etc).',
      ].join('\n'),
      prompt: [
        `MODE: ${mode}`,
        `PLAN premise: ${plan.premise}`,
        `PLAN characters: ${plan.characters.join(', ')}`,
        `Max sentence words: ${plan.vocab_constraints.max_sentence_words}`,
        `Allowed patterns: ${plan.vocab_constraints.allowed_patterns}`,
        '',
        `NARRATOR SAYS: ${turn.speak_text}`,
        `CHILD PASSAGE: ${turn.child_passage ?? '(none)'}`,
      ].join('\n'),
    });

    const failures: string[] = [];
    if (!object.age_appropriate) failures.push('not age appropriate');
    if (!object.on_story) failures.push('off-story');
    if (!object.obeys_vocab_constraints) failures.push('violates vocab constraints');
    if (!object.withheld_answer_if_socratic) failures.push('gave away the answer in SOCRATIC mode');
    if (!object.no_brand_or_ip) failures.push('contains brand or IP content');

    if (failures.length === 0) return { ok: true, reason: '' };
    return { ok: false, reason: object.reason || failures.join('; ') };
  } catch (err) {
    console.error('[safety] check errored, failing open', err);
    return { ok: true, reason: '' };
  }
}
