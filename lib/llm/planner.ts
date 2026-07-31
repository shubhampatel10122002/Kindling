import { generateObject } from 'ai';
import { z } from 'zod';
import { model } from './client';
import { describeTargets, comfortableSkills } from '../pedagogy';
import type { ChildMemory, ChildNote, Mastery, SessionPlan, Child } from '../types';

const planSchema = z.object({
  goal: z.string().describe('One line: which skills this session practices and reviews'),
  target_skills: z.array(z.string()),
  premise: z.string().describe('One sentence describing the story'),
  characters: z.array(z.string()),
  beats: z.array(z.string()).min(3).max(7).describe('Story beats in order, one short phrase each'),
  difficulty: z.number().int().min(1).max(5),
  vocab_constraints: z.object({
    must_use_words: z.array(z.string()).min(3).max(8),
    max_sentence_words: z.number().int().min(4).max(12),
    allowed_patterns: z.string(),
  }),
});

export async function generateSessionPlan(args: {
  child: Child;
  memory: ChildMemory;
  mastery: Mastery[];
  targetSkills: string[];
  /** What she told us last time, and the question she is still waiting on. */
  notes?: { material: ChildNote[]; question: ChildNote | null };
}): Promise<SessionPlan> {
  const { child, memory, mastery, targetSkills } = args;
  const material = args.notes?.material ?? [];
  const question = args.notes?.question ?? null;

  const interests = memory.interests
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 6)
    .map((i) => `${i.topic} (${i.weight})`)
    .join(', ');

  const canon = memory.canon ?? {};

  const { object } = await generateObject({
    model: model.planner(),
    schema: planSchema,
    system: [
      'You plan a ~15 minute read-aloud session for a beginning reader.',
      'The child reads short passages aloud; an AI narrator reads the story beats.',
      'Design a warm, playful story that naturally exercises the target reading skills.',
      'Hard rules:',
      '- Nothing scary, violent, or sad about family.',
      '- No brand or IP content (no Elsa, no Pokemon). Invent original stand-ins.',
      '- must_use_words must be decodable words that exercise the target skills.',
      '- Reuse characters and open threads from canon when they exist. Continuity delights kids.',
      '- beats are short planning notes for the narrator, not final prose.',
      '',
      'If the child told us things last time, one of them becomes what this story is ABOUT —',
      'named, with a role, not a passing mention. A child seeing her own week turn up in a book',
      'is the strongest hook this product has. Use at most two of them: a story stuffed with',
      'everything she has ever said reads like a list, not a story. Leave the rest for later.',
      'Never mention that she told you — the detail is simply there in the world.',
      '',
      'If she asked a question, the story ANSWERS it by showing rather than explaining: she asked',
      'why the sky is blue, so someone climbs up to see. She should finish the session knowing',
      'more than she did and never have been lectured.',
      '',
      'Her own life is used literally — her cat, her sister, her tooth. Brands, public figures and',
      'known characters are replaced by an original stand-in of the same kind.',
    ].join('\n'),
    prompt: [
      `Child: ${child.name}${child.age ? `, age ${child.age}` : ''}`,
      child.onboarding_notes ? `Parent notes: ${child.onboarding_notes}` : '',
      `Interests (weighted): ${interests || 'none recorded yet'}`,
      `Personality notes: ${memory.personality_notes || 'none yet'}`,
      `Canon characters: ${(canon.characters ?? []).join(', ') || 'none yet'}`,
      `Open threads: ${(canon.open_threads ?? []).join('; ') || 'none yet'}`,
      `Past story summaries: ${(canon.past_summaries ?? []).slice(-3).join(' | ') || 'none yet'}`,
      '',
      material.length
        ? `Things ${child.name} told us recently — build the story around one of these: ` +
          material.map((n) => `${n.subject} (${n.kind})`).join('; ')
        : '',
      question ? `A question she is waiting on an answer to: ${question.subject}` : '',
      material.length || question ? '' : '',
      `Target skills for this session: ${describeTargets(targetSkills)}`,
      `Target skill ids (copy these verbatim into target_skills): ${targetSkills.join(', ')}`,
      `Skills the child is already comfortable with: ${
        comfortableSkills(mastery).join(', ') || 'none recorded yet — assume a true beginner'
      }`,
      '',
      'Produce the session plan.',
    ]
      .filter(Boolean)
      .join('\n'),
  });

  // Trust our own skill ids over the model's echo of them.
  return { ...object, target_skills: targetSkills } as SessionPlan;
}

/** Deterministic fallback so a planner outage can never block a demo. */
export function fallbackPlan(child: Child, targetSkills: string[]): SessionPlan {
  return {
    goal: `practice ${targetSkills.join(', ')}`,
    target_skills: targetSkills,
    premise: `${child.name} and Blue the dragon look for the lost bell`,
    characters: ['Blue the dragon', child.name],
    beats: [
      `${child.name} finds a torn map in the garden`,
      'They cross the wobbly bridge',
      'The bell is found inside the old clock',
    ],
    difficulty: 2,
    vocab_constraints: {
      must_use_words: ['blue', 'map', 'bell', 'friend'],
      max_sentence_words: 7,
      allowed_patterns: 'short vowels and simple blends only',
    },
  };
}
