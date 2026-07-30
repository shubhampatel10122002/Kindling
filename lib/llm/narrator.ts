import { generateObject } from 'ai';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import { model } from './client';
import { runSafetyPass } from './safety';
import { checkVocab } from '../vocab';
import { mentionsWord } from '../praise';
import * as T from '../templates';
import type { Child, ChildMemory, SessionPlan } from '../types';

export const narratorSchema = z.object({
  speak_text: z.string().describe('Exactly what the narrator says aloud. 2-3 short sentences.'),
  child_passage: z
    .string()
    .nullable()
    .describe('The 1-2 sentences the child reads next, or null if the child should not read now.'),
  plan_update: z.string().nullable().describe('Optional: revised remaining beats'),
  current_beat_index: z.number().int().min(0),
});

export type NarratorTurn = z.infer<typeof narratorSchema>;

export type NarratorMode =
  | 'OPENING'
  | 'NEXT_BEAT'
  | 'COACH'
  | 'ENCOURAGE'
  | 'SOCRATIC'
  | 'ANSWER_DIRECTLY'
  | 'CHITCHAT'
  | 'REMIX'
  | 'ADAPT'
  | 'CLOSING';

function buildSystemPrompt(args: {
  child: Child;
  memory: ChildMemory;
  plan: SessionPlan;
}): string {
  const { child, memory, plan } = args;
  const canon = memory.canon ?? {};
  const interests = memory.interests
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 6)
    .map((i) => i.topic)
    .join(', ');

  return [
    `You are a warm, playful reading companion telling a story with ${child.name}${
      child.age ? `, who is ${child.age}` : ''
    }.`,
    '',
    '# What you know about this child',
    child.onboarding_notes ? `Parent notes: ${child.onboarding_notes}` : '',
    `Interests: ${interests || 'still learning what they love'}`,
    `Personality notes: ${memory.personality_notes || 'none yet'}`,
    `Story canon (recurring characters): ${(canon.characters ?? []).join(', ') || 'none yet'}`,
    `Open threads from past sessions: ${(canon.open_threads ?? []).join('; ') || 'none yet'}`,
    '',
    '# This session plan',
    `Goal: ${plan.goal}`,
    `Premise: ${plan.premise}`,
    `Characters: ${plan.characters.join(', ')}`,
    `Beats: ${plan.beats.map((b, i) => `${i}. ${b}`).join(' | ')}`,
    `Difficulty: ${plan.difficulty}`,
    `Words to work in naturally: ${plan.vocab_constraints.must_use_words.join(', ')}`,
    `Max words per sentence in the child's passage: ${plan.vocab_constraints.max_sentence_words}`,
    `Allowed spelling patterns: ${plan.vocab_constraints.allowed_patterns}`,
    '',
    '# Hard rules',
    '1. Warm, playful, age-appropriate. Short sentences. Never lecture.',
    '2. Socratic behavior applies ONLY to thinking questions. When in SOCRATIC mode, reply with ONE simpler guiding question and praise the attempt. After at most 3 guiding questions give a strong hint and let the child say the answer. Procedural questions (what a word says, whether they can stop, how the app works) always get a direct, kind answer.',
    "3. The child's passage must obey the vocab constraints and work in the must-use words naturally.",
    '4. Nothing scary, nothing violent, nothing sad about family. No brand or IP content (no Elsa, no Pokemon) even if the child asks — offer an original stand-in instead, e.g. "a snow queen named Elka".',
    '5. Stay inside the story world. Weave any interruption back into the story within one sentence.',
    '6. If told the child is frustrated, get easier and shorter immediately and offer a choice ("Want a brand new story, or should we see what Blue does next?"). Choices give a child back their sense of control.',
    '',
    '# Output',
    'speak_text is read aloud by a text-to-speech voice — write it to be spoken, never with stage directions, markdown, or emoji.',
    "child_passage is displayed for the child to read aloud. Keep it to 1-2 sentences. Set it to null when the child should not be reading (closing, or a pure conversational turn).",
    'current_beat_index is which plan beat you are on.',
  ]
    .filter(Boolean)
    .join('\n');
}

const MODE_INSTRUCTIONS: Record<NarratorMode, string> = {
  OPENING:
    'Open the story. Greet the child by name in one short sentence, then tell the first beat in 2-3 sentences. Then give them their first passage to read.',
  NEXT_BEAT:
    'The child just finished reading their passage well. React to the story (not to their reading), advance to the next beat in 2-3 sentences, then give the next passage.',
  COACH:
    'The child is stuck on a word. Give ONE short, encouraging coaching line that helps them sound it out. Do not re-tell the story. Set child_passage to null.',
  ENCOURAGE:
    'The child has read two passages beautifully. Give ONE short praise line that names something specific they did well, then continue the story with the next beat and passage.',
  SOCRATIC:
    'The child asked a thinking question. Respond with ONE guiding question that helps them find the answer themselves. Praise their curiosity first. Then weave back toward the story in one sentence. Set child_passage to null.',
  ANSWER_DIRECTLY:
    'The child asked a procedural question (what a word says, how something works). Answer it directly and kindly in one or two sentences, then invite them to keep reading. Set child_passage to null.',
  CHITCHAT:
    'The child shared something about their life. Acknowledge it warmly in ONE sentence, connect it to the story in one more sentence, and invite them back to reading. Set child_passage to null.',
  REMIX:
    "The child asked for something different. Acknowledge their idea enthusiastically, then regenerate the NEXT beat and passage with their new theme. Keep the SAME difficulty, the SAME target skills, and the SAME must-use words. The child changes the costume; the lesson stays.",
  ADAPT:
    'The child is struggling. Make this easier immediately: one short sentence for the passage, simplest words possible, and offer them a choice about what happens next. Stay upbeat — never signal that they failed.',
  CLOSING:
    'Wrap the story up warmly in one beat — never on a cliffhanger. Reference something specific the child did today. Set child_passage to null.',
};

/**
 * One narrator conversation per session. The state machine decides the mode;
 * the narrator only decides the words.
 */
export class Narrator {
  private history: ModelMessage[] = [];
  private system: string;

  constructor(
    private child: Child,
    private memory: ChildMemory,
    private plan: SessionPlan,
  ) {
    this.system = buildSystemPrompt({ child, memory, plan });
  }

  /** Replaces the plan after a REMIX/ADAPT rewrite so later turns stay consistent. */
  updatePlan(plan: SessionPlan) {
    this.plan = plan;
    this.system = buildSystemPrompt({ child: this.child, memory: this.memory, plan });
  }

  async turn(
    mode: NarratorMode,
    context: string,
    opts: { mustMention?: string | null } = {},
  ): Promise<NarratorTurn> {
    const mustMention = opts.mustMention?.trim() || null;

    const userMessage = [
      `MODE: ${mode}`,
      MODE_INSTRUCTIONS[mode],
      context ? `\nCONTEXT: ${context}` : '',
      mustMention
        ? `\nHARD CONSTRAINT: the child read the word "${mustMention}". Praise that exact word, spelled exactly that way. Do NOT name any other word the child read, and do NOT substitute a similar-looking word — you have other words in your context that the child did not read.`
        : '',
    ].join('\n');

    const attempt = async (extra?: string): Promise<NarratorTurn> => {
      const { object } = await generateObject({
        model: model.narrator(),
        schema: narratorSchema,
        system: this.system,
        messages: [
          ...this.history,
          { role: 'user', content: extra ? `${userMessage}\n\n${extra}` : userMessage },
        ],
      });
      return object;
    };

    let turn: NarratorTurn;
    try {
      turn = await attempt();
    } catch (err) {
      console.error('[narrator] generation failed', err);
      return this.fallback(mode);
    }

    // Objective constraints first — arithmetic, not an LLM judgment call.
    const vocab = checkVocab(turn.child_passage, this.plan.vocab_constraints);

    // Did it praise the word the child actually read? Checked in code, because
    // the model reaching for a similar word from its context is the exact
    // failure this constraint exists to prevent.
    const wrongWord = mustMention !== null && !mentionsWord(turn.speak_text, mustMention);

    // Then the fuzzy safety judgments. Run in parallel with nothing else; this is
    // the only LLM call in the hot path besides the narrator itself.
    let verdict = await runSafetyPass({ turn, plan: this.plan, mode });

    const needsRetry = !verdict.ok || !vocab.ok || wrongWord;
    if (needsRetry) {
      const why = [
        verdict.ok ? '' : verdict.reason,
        vocab.feedback,
        wrongWord
          ? `You praised a word the child did not read. The only word you may name is "${mustMention}".`
          : '',
      ]
        .filter(Boolean)
        .join(' ');
      console.warn(`[narrator] retrying (${verdict.severity}): ${why}`);
      try {
        const retry = await attempt(`Your previous draft had a problem: ${why} Fix it and try again.`);
        const retryVerdict = await runSafetyPass({ turn: retry, plan: this.plan, mode });

        if (retryVerdict.severity === 'hard') {
          // Two strikes on genuine safety — this is what templates are for.
          console.error('[narrator] hard safety failure twice, using template:', retryVerdict.reason);
          return this.fallback(mode);
        }

        // Still crediting the wrong word after being told twice? Do not let it
        // reach the child — a template that names the right word is strictly
        // better than fluent praise for something they never said.
        if (mustMention !== null && !mentionsWord(retry.speak_text, mustMention)) {
          console.error(
            `[narrator] still praising the wrong word after a retry; using template for "${mustMention}"`,
          );
          return {
            ...retry,
            speak_text: T.encourageLine(`"${mustMention}"`),
          };
        }

        // Otherwise take the retry. A slightly long sentence is better pedagogy
        // than the fallback template, and the child hears a real story.
        turn = retry;
        verdict = retryVerdict;
      } catch (err) {
        console.error('[narrator] regeneration failed, keeping first draft', err);
        // Only refuse the first draft if it was a hard safety failure.
        if (verdict.severity === 'hard') return this.fallback(mode);
        if (wrongWord && mustMention !== null) {
          return { ...turn, speak_text: T.encourageLine(`"${mustMention}"`) };
        }
      }
    }

    this.history.push({ role: 'user', content: userMessage });
    this.history.push({ role: 'assistant', content: JSON.stringify(turn) });
    // Keep the conversation from growing without bound over a 15 minute session.
    if (this.history.length > 40) this.history = this.history.slice(-40);

    return turn;
  }

  private fallback(mode: NarratorMode): NarratorTurn {
    const character = this.plan.characters[0] ?? 'our friend';
    const needsPassage = mode === 'OPENING' || mode === 'NEXT_BEAT' || mode === 'ENCOURAGE';
    return {
      speak_text: T.safeFallbackBeat(character),
      child_passage: needsPassage ? T.safeFallbackPassage() : null,
      plan_update: null,
      current_beat_index: 0,
    };
  }
}
