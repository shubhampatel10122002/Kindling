import { generateObject } from 'ai';
import { z } from 'zod';
import { model } from './client';
import { sanitizeSpokenLine } from '../ack';
import { generalizeSubject } from '../notes';
import * as T from '../templates';
import type { Intent, Mood, NoteKind } from '../types';

/**
 * One call that absorbs whatever the child just said.
 *
 * It does three jobs at once — classify the intent, write the one line Ollie
 * says back, and extract the thing worth keeping — because they are one round
 * trip and the child is waiting through all of it. Two Haiku calls in sequence
 * is two seconds of a five-year-old deciding she was ignored.
 *
 * `ack` is never empty. If she says something, Ollie says something: that is the
 * whole contract of this file. Failure of the model, of the network, of the
 * schema — all of them still produce a line.
 */

const schema = z.object({
  intent: z.enum([
    'help_with_word',
    'question_about_story',
    'question_about_world',
    'change_request',
    'chitchat',
    'want_to_stop',
    'sensitive_topic',
    'unclear',
  ]),
  ack: z
    .string()
    .describe('The one short line Ollie says back, naming her actual detail. Never empty.'),
  note_kind: z.enum(['event', 'interest', 'question', 'person', 'mood', 'none']),
  note_subject: z
    .string()
    .describe('Short noun phrase for the notebook, e.g. "a loose tooth". Empty when nothing.'),
  note_weight: z.number().min(1).max(3),
  mood: z.enum(['tired', 'sad', 'excited', 'none']),
});

export interface Absorbed {
  intent: Intent;
  /** Spoken immediately, before anything else happens. Always present. */
  ack: string;
  note: { kind: NoteKind; subject: string; weight: number } | null;
  mood: Mood | null;
  reasoning: string;
}

/** Where in the session she said it — it changes what Ollie is allowed to say back. */
export type AbsorbContext = 'doorway' | 'reading' | 'wrap';

const ACK_RULES: Record<AbsorbContext, string> = {
  doorway:
    'She is talking before the story starts, so there is room. You may ask ONE short follow-up ' +
    'question about the detail she gave ("A puppy. What colour?"). Do not ask more than one.',
  reading:
    'She is in the middle of reading, so do NOT ask a question and do NOT continue the story. ' +
    'Name her detail back and say you are keeping it, in one short line. ' +
    'Example: "A loose tooth! I am writing that one down."',
  wrap:
    'The session is ending. Acknowledge warmly in one short line. Do not start anything new.',
};

export async function absorb(args: {
  transcript: string;
  context: AbsorbContext;
  childName: string;
  currentPassage?: string | null;
  currentWord?: string | null;
  storyPremise?: string | null;
}): Promise<Absorbed> {
  const { transcript, context, childName } = args;

  if (!transcript || transcript.trim().length < 2) {
    return {
      intent: 'unclear',
      ack: T.unclearLine(),
      note: null,
      mood: null,
      reasoning: 'empty transcript',
    };
  }

  try {
    const { object } = await generateObject({
      model: model.intent(),
      schema,
      system: [
        `You are Ollie, a warm reading companion listening to a child named ${childName}.`,
        'She has just said something out loud. Do three things at once.',
        '',
        '# 1. Classify what she said',
        'help_with_word — she wants to know what a word says or how to read it.',
        'question_about_story — a question about the story in front of her ("why is the dragon sad?").',
        'question_about_world — curiosity about the real world ("why is the sky blue?", "how do planes fly?").',
        'change_request — she wants a different story, topic, or character.',
        'chitchat — she shared something about her life ("my dog is named Max", "I lost a tooth").',
        'want_to_stop — she wants to be done.',
        'sensitive_topic — death, divorce, someone hurting her, or a real-world fear. When torn between this and a story question, choose this.',
        'unclear — babble or genuinely unintelligible.',
        '',
        '# 2. Write the one line Ollie says back',
        'This is the most important field. She must never feel ignored.',
        ACK_RULES[context],
        'Rules for that line:',
        '- ONE sentence, twelve words at most. It is spoken aloud, so no markdown or emoji.',
        '- Warmth comes from being specific, not from volume. Name the actual thing she said.',
        '  "A puppy!" proves you listened. "That is amazing!!" proves nothing.',
        '- Never gush, never stack exclamations, never call her wonderful.',
        '- If she says she is tired or sad, acknowledge it in a few words and move on.',
        '  Do not open a conversation about feelings and do not offer to talk about it.',
        '- If she asked about the world, do NOT answer it. Say you do not know and that you',
        '  will find out together in a story. Curiosity kept beats curiosity resolved.',
        '',
        '# 3. Extract what is worth keeping',
        'note_kind: event (something that happened to her), interest (something she loves),',
        'question (world curiosity, for a future story), person (a family member, friend, or pet),',
        'mood (how she says she feels), or none when there is nothing to keep.',
        'note_subject is a short noun phrase written from the outside: "a loose tooth",',
        '"an alligator at the park", "her cat Pepper", "why the sky is blue".',
        'note_weight: 3 for a real event in her life, 2 for a person or a strong interest, 1 for a passing mention.',
        '',
        '# The naming rule',
        'Things personal to her are kept literally — her cat, her sister, her tooth, her friend.',
        'Brands, public figures and known characters are generalized into their category instead:',
        'not "Elsa" but "a snow queen", not "Pokemon" but "a pocket monster".',
      ].join('\n'),
      prompt: [
        args.storyPremise ? `Story premise: ${args.storyPremise}` : '',
        args.currentPassage ? `Passage she is reading: ${args.currentPassage}` : '',
        args.currentWord ? `Word she is on: ${args.currentWord}` : '',
        '',
        `She said: "${transcript}"`,
      ]
        .filter(Boolean)
        .join('\n'),
    });

    const ack = sanitizeSpokenLine(object.ack) ?? T.absorbFallback();

    const subject = object.note_subject?.trim() ?? '';
    const note =
      object.note_kind !== 'none' && subject.length > 1
        ? {
            kind: object.note_kind as NoteKind,
            subject: generalizeSubject(subject),
            weight: object.note_weight,
          }
        : null;

    return {
      intent: object.intent as Intent,
      ack,
      note,
      mood: object.mood === 'none' ? null : (object.mood as Mood),
      reasoning: `${object.intent} / ${object.note_kind}`,
    };
  } catch (err) {
    console.error('[absorb] failed, acknowledging anyway', err);
    // The classification is expendable. The acknowledgment is not: she spoke, so
    // she gets an answer, and an unclassified utterance simply returns to reading.
    return {
      intent: 'unclear',
      ack: T.absorbFallback(),
      note: null,
      mood: null,
      reasoning: 'absorb error',
    };
  }
}
