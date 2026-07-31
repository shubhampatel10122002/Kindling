/**
 * Non-LLM template lines. Used for the fixed sensitive-topic response (PLAN.md §5,
 * which must never be improvised), for the nudge ladder, and as the safe fallback
 * when the narrator's safety pass fails twice (PLAN.md §7).
 */

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Sound out a word letter by letter: "b... l... ue". */
function soundOut(word: string): string {
  return word.replace(/[^a-zA-Z]/g, '').split('').join('... ');
}

export const coachLine = (word: string, attempt: number): string => {
  const clean = word.replace(/[^a-zA-Z']/g, '');
  if (attempt <= 1) {
    return pick([
      `Let's sound it out together: ${soundOut(clean)}. What word is that?`,
      `Try that one again with me. ${soundOut(clean)}.`,
      `Nice try! Look at the letters: ${soundOut(clean)}.`,
    ]);
  }
  return pick([
    `That one is tricky. It says "${clean}". Say it with me: ${clean}.`,
    `This word is "${clean}". You've got it — let's keep going.`,
  ]);
};

export const giveWordLine = (word: string): string => {
  const clean = word.replace(/[^a-zA-Z']/g, '');
  return pick([
    `That word is "${clean}". Great sticking with it. Let's keep reading!`,
    `It says "${clean}". You worked hard on that one. Onward!`,
  ]);
};

/**
 * Fallback only — the acknowledgment between turns is normally model-generated
 * (lib/llm/acknowledge.ts) so it fits what the child just did. These are used
 * when that call fails or returns something unusable.
 */
export const ackFallback = (band: 'flawless' | 'solid' | 'effortful'): string => {
  if (band === 'flawless') return pick(['Perfect!', 'Wow, every word!', 'Beautiful reading!']);
  if (band === 'effortful') return pick(['You stuck with it!', 'Good work on that one!', 'Nice effort!']);
  return pick(['Nice!', 'Great job!', 'Well done!', 'Lovely!']);
};

export const encourageLine = (detail: string): string =>
  pick([
    `Wow, you read ${detail} perfectly! Your reading voice is getting so strong.`,
    `That was beautiful reading — ${detail} came out just right!`,
    `You nailed ${detail}. I could really hear the story!`,
  ]);

export const silenceNudge = (firstWord: string): string => {
  const letter = firstWord.replace(/[^a-zA-Z]/g, '').charAt(0).toLowerCase();
  return `Take your time. The first word starts with ${letter}${letter}${letter}...`;
};

export const stillThereLine = (): string =>
  pick([`Are you still there, friend?`, `Still with me? I'm right here when you're ready.`]);

export const pausedLine = (): string =>
  `I'll wait right here. Tap the owl whenever you want to keep going!`;

export const talkTimeoutLine = (): string =>
  pick([`Tap me when you want to chat!`, `I didn't hear anything — tap me again when you're ready!`]);

export const unclearLine = (): string =>
  `Hmm, I didn't catch that! Want to tell me again, or keep reading?`;

/**
 * FIXED comfort template for sensitive topics. Never LLM-generated. PLAN.md §5.
 */
export const sensitiveTopicLine = (character: string): string =>
  `That's a really big question, and I'm glad you told me. That's a great thing to talk about with your grown-up. They give the best hugs too. Should we find out what happens to ${character}?`;

/** Last-resort narrator line when the safety pass fails twice. */
export const safeFallbackBeat = (character: string): string =>
  `${character} took a big breath and looked around. Something new was about to happen.`;

export const safeFallbackPassage = (): string => `The sun was warm and the path was long.`;

export const openingLine = (name: string): string =>
  `Hi ${name}! I'm so happy you're here. Let's read a story together.`;

export const goodbyeLine = (name: string, detail: string): string =>
  `That was wonderful, ${name}. ${detail} See you next time!`;

// ---------------------------------------------------------------------------
// Absorbing what the child says
// ---------------------------------------------------------------------------

/**
 * Last resort when the absorb call fails. She said something, so she hears
 * something — an unclassified utterance still gets an answer. Deliberately
 * vague rather than wrong: naming a detail we did not actually parse is worse
 * than a warm "hm".
 */
export const absorbFallback = (): string =>
  pick([
    'Hm, I like that. I am keeping it.',
    "Oh! I'm writing that down.",
    'Mm. That one is going in my notebook.',
    'I heard that. Keeping it for later.',
  ]);

/** Said once the doorway closes, so she knows the talking turned into something. */
export const writingLine = (): string =>
  pick(['Okay. I am writing.', "Right — I'm writing your story now.", 'Got it. Writing now.']);

/** The question jar: we do not answer, we promise to find out. PLAN.md §5. */
export const questionJarLine = (): string =>
  pick([
    "I don't know! Let's find out in a story.",
    "You know what? I don't know either. Let's go and see.",
    "Good question. I don't know yet — let's find out by reading.",
  ]);

/** Ollie has no idea who she is yet. */
export const onboardingGreeting = (): string =>
  "Hi! I'm Ollie, and I make stories for you to read. What's your name?";

export const onboardingLikes = (name: string): string =>
  `${name}. That's a good name. Tell me one thing you really like.`;

export const onboardingWriting = (name: string): string =>
  `Okay ${name}, I'm writing you a story right now. Watch.`;

/** After the cliffhanger: exactly one more, or a warm ending. */
export const oneMoreLine = (): string =>
  pick([
    'Want one more bit, or shall we save it for next time?',
    'Should we do one more piece, or stop here?',
    'One more bit, or is that a good place to stop?',
  ]);

/** The recap: one concrete thing she can do now that she could not before. */
export const grewLine = (word: string): string =>
  pick([
    `And you read "${word}" all by yourself today. That one used to be tricky.`,
    `You can read "${word}" now. You couldn't do that before.`,
    `"${word}" used to catch you out, and today it didn't.`,
  ]);
