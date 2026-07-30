import { generateText } from 'ai';
import { model } from './client';
import { sanitizeAcknowledgment, summarizeReading, MAX_ACK_WORDS, type ReadingQuality } from '../ack';
import * as T from '../templates';
import type { TrackedWord } from '../types';

/**
 * One very short spoken acknowledgment to bridge the child's turn and the
 * narrator's, e.g. "Nice!" or "You stuck with that one!".
 *
 * Haiku rather than Sonnet, and generateText rather than generateObject: this is
 * two words on the critical path between the child finishing and the story
 * continuing, so latency is the whole design constraint.
 *
 * It is told how the reading went but never which words were read — naming a
 * word is how the narrator ended up praising "glad" for a child who read
 * "glides", and an interjection has no need for it.
 */
export async function generateAcknowledgment(args: {
  childName: string;
  words: TrackedWord[];
}): Promise<{ text: string; quality: ReadingQuality; source: 'model' | 'template' }> {
  const quality = summarizeReading(args.words);

  const guidance: Record<ReadingQuality['band'], string> = {
    flawless: 'They read every word correctly on the first try. Be delighted.',
    solid: 'They read it well, with one small wobble. Be warm and matter-of-fact.',
    effortful:
      'They found it hard and needed help on some words. Acknowledge the effort, not the accuracy. Never imply they got it wrong.',
  };

  try {
    const { text } = await generateText({
      model: model.intent(), // Haiku — speed matters more than eloquence here
      system: [
        `You are a warm reading companion talking to a child named ${args.childName}.`,
        'The child has just finished reading a passage aloud.',
        '',
        `Reply with ONE very short spoken acknowledgment — ${MAX_ACK_WORDS} words maximum.`,
        'Examples of the right shape: "Nice!", "Great job!", "Wow!", "You got it!",',
        '"That was smooth!", "You stuck with that one!"',
        '',
        'Rules:',
        '- Output ONLY the acknowledgment. No quotes, no explanation, no emoji.',
        '- Do NOT name or spell any specific word.',
        '- Do NOT continue the story or add any new information.',
        '- Vary your wording; do not always say the same thing.',
        '- Praise the reading or the effort, never the child as a person.',
        '  Say "That was smooth!", not "You are wonderful!".',
        '- Never mention what they missed, or that they only got part of it.',
      ].join('\n'),
      prompt: [
        `Words in the passage: ${quality.total}`,
        `Read correctly first try: ${quality.cleanFirstTry}`,
        `Needed coaching: ${quality.coached}`,
        `Given by the narrator: ${quality.given}`,
        '',
        guidance[quality.band],
      ].join('\n'),
    });

    const clean = sanitizeAcknowledgment(text);
    if (clean) return { text: clean, quality, source: 'model' };
    console.warn(`[ack] rejected model output ${JSON.stringify(text)}, using template`);
  } catch (err) {
    console.error('[ack] generation failed, using template', err);
  }

  return { text: T.ackFallback(quality.band), quality, source: 'template' };
}
