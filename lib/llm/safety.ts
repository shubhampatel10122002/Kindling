import { generateObject } from 'ai';
import { z } from 'zod';
import { model } from './client';
import type { SessionPlan } from '../types';
import type { NarratorTurn } from './narrator';

/**
 * Safety pass over speak_text + child_passage before TTS. PLAN.md §7.
 *
 * Scope is deliberately narrow. An earlier version also asked the model to
 * enforce `vocab_constraints`, which gave it a free-text rubric and a veto over
 * every turn — it responded by arguing with itself about whether "sniffs" is
 * CVC or CCVC and rejecting good passages, so nothing ever reached the child.
 * Objective constraints are now checked in `lib/vocab.ts`; this pass covers only
 * the genuinely fuzzy judgments an LLM is actually good at.
 *
 * Failures are graded, because "scary content" and "gave the answer away" do not
 * deserve the same response:
 *   - hard: never reaches the child. Regenerate, then fall back to a template.
 *   - soft: worth one retry, but shipping it beats shipping a bland template.
 */

const schema = z.object({
  age_appropriate: z
    .boolean()
    .describe('Nothing scary, violent, or sad about family. Warm, simple language.'),
  no_brand_or_ip: z.boolean().describe('No real-world brands or copyrighted characters.'),
  on_story: z.boolean().describe('Belongs to the story world, or is a natural reply to the child.'),
  unresolved_if_cliffhanger: z
    .boolean()
    .describe(
      'If MODE is CLIFFHANGER, the story stops at a moment of tension with something still ' +
        'about to happen, rather than being wrapped up or resolved. Otherwise true.',
    ),
  reason: z.string().describe('Empty string when everything passed; otherwise the single worst problem.'),
});

export type SafetySeverity = 'ok' | 'soft' | 'hard';

export interface SafetyVerdict {
  ok: boolean;
  severity: SafetySeverity;
  reason: string;
}

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
        'You are a content checker for a reading app used by a young child.',
        'You are given text an AI narrator is about to say aloud, and the passage the child will read.',
        '',
        'Judge ONLY the four checks in the schema. Answer each with a boolean.',
        'Do NOT evaluate reading level, spelling patterns, phonics, word difficulty, or',
        'sentence length — those are checked separately by code, and second-guessing',
        'them here blocks good content.',
        '',
        'Be decisive. Do not deliberate in the reason field: give one short phrase.',
        'Only fail a check for a clear, obvious problem.',
      ].join('\n'),
      prompt: [
        `MODE: ${mode}`,
        `Story premise: ${plan.premise}`,
        `Characters: ${plan.characters.join(', ')}`,
        '',
        `NARRATOR SAYS: ${turn.speak_text}`,
        `CHILD PASSAGE: ${turn.child_passage ?? '(none)'}`,
      ].join('\n'),
    });

    // Content that must never reach a child.
    if (!object.age_appropriate) {
      return { ok: false, severity: 'hard', reason: object.reason || 'not age appropriate' };
    }
    if (!object.no_brand_or_ip) {
      return { ok: false, severity: 'hard', reason: object.reason || 'brand or IP content' };
    }

    // Pedagogy misses: worth one retry, not worth falling back to a template.
    if (!object.unresolved_if_cliffhanger) {
      // A resolved ending is not unsafe, just a worse session — she is meant to
      // leave wanting the next one.
      return { ok: false, severity: 'soft', reason: object.reason || 'resolved the cliffhanger' };
    }
    if (!object.on_story) {
      return { ok: false, severity: 'soft', reason: object.reason || 'off-story' };
    }

    return { ok: true, severity: 'ok', reason: '' };
  } catch (err) {
    // A Haiku outage must not brick a live session. The narrator's own system
    // prompt already carries the same hard rules.
    console.error('[safety] check errored, failing open', err);
    return { ok: true, severity: 'ok', reason: '' };
  }
}
