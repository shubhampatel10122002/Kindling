import { generateObject } from 'ai';
import { z } from 'zod';
import { model } from './client';
import type { Intent } from '../types';

const schema = z.object({
  intent: z.enum([
    'help_with_word',
    'question_about_story_or_world',
    'change_request',
    'chitchat',
    'want_to_stop',
    'sensitive_topic',
    'unclear',
  ]),
  /** For chitchat: the topic worth remembering as an interest signal. */
  interest_topic: z.string().nullable(),
  reasoning: z.string(),
});

/** One Haiku call classifies the child's talk-mode utterance into exactly one intent. */
export async function classifyIntent(args: {
  transcript: string;
  currentPassage: string | null;
  currentWord: string | null;
  storyPremise: string;
}): Promise<{ intent: Intent; interestTopic: string | null; reasoning: string }> {
  const { transcript, currentPassage, currentWord, storyPremise } = args;

  if (!transcript || transcript.trim().length < 2) {
    return { intent: 'unclear', interestTopic: null, reasoning: 'empty transcript' };
  }

  try {
    const { object } = await generateObject({
      model: model.intent(),
      schema,
      system: [
        'You classify what a young child said to an AI reading companion. Choose exactly one intent.',
        '',
        'help_with_word — they want to know what a word says or how to read it. Procedural help.',
        'question_about_story_or_world — a thinking question ("why is the dragon sad?", "why is the sky blue?").',
        'change_request — they want a different story, topic, or character ("this is boring, I want trucks").',
        'chitchat — they shared something about their life ("my dog is named Max!"). Set interest_topic to the thing they care about.',
        'want_to_stop — they want to be done ("I\'m done", "can I go?").',
        'sensitive_topic — death, divorce, someone hurting them, or a real-world fear. When in doubt between this and a story question, choose this.',
        'unclear — babble, silence, or genuinely unintelligible.',
      ].join('\n'),
      prompt: [
        `Story premise: ${storyPremise}`,
        currentPassage ? `Passage they are reading: ${currentPassage}` : '',
        currentWord ? `Word they are on: ${currentWord}` : '',
        '',
        `The child said: "${transcript}"`,
      ]
        .filter(Boolean)
        .join('\n'),
    });

    return {
      intent: object.intent as Intent,
      interestTopic: object.interest_topic,
      reasoning: object.reasoning,
    };
  } catch (err) {
    console.error('[intent] classification failed', err);
    return { intent: 'unclear', interestTopic: null, reasoning: 'classifier error' };
  }
}
