/**
 * Offline verification of the deterministic core — the parts that decide what
 * happens, as opposed to the parts that decide what words to say. Runs with no
 * network and no database.
 *
 * Run: npm run selftest
 */
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { PassageTracker, tokenize } from '../server/tracker';
import { applyLeniency } from '../lib/leniency';
import { updateMastery, pickTargets } from '../lib/pedagogy';
import { skillsForWord, SKILLS } from '../lib/skills';
import { AUDIO } from '../lib/env';
import { floatPcmToWav } from '../lib/wav';
import { pickPraiseWord, mentionsWord } from '../lib/praise';
import { sanitizeAcknowledgment, sanitizeSpokenLine, parseYesNo, summarizeReading } from '../lib/ack';
import { planOpening, rememberLine } from '../lib/opening';
import { pickCameo, pickPlanNotes, generalizeSubject, MAX_SUBJECTS_PER_PLAN } from '../lib/notes';
import { guessName } from '../server/session';
import type { ChildNote, WordAssessment } from '../lib/types';

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function word(
  w: string,
  score: number,
  errorType: WordAssessment['errorType'] = 'None',
  phonemes: WordAssessment['phonemes'] = [],
): WordAssessment {
  return { word: w, accuracyScore: score, errorType, phonemes };
}

console.log('\nPrimer self-test (deterministic core)\n');

// --------------------------------------------------------------------------
console.log('Leniency table (PLAN.md §9.3)');
// --------------------------------------------------------------------------
{
  // "wabbit" for "rabbit": the only failing phoneme is r->w, a developmental
  // substitution. Must be treated as a pass, logged as Developmental.
  const v = applyLeniency(
    word('rabbit', 48, 'Mispronunciation', [
      { phoneme: 'r', accuracyScore: 20 },
      { phoneme: 'æ', accuracyScore: 95 },
      { phoneme: 'b', accuracyScore: 92 },
    ]),
  );
  ok('r→w "wabbit" passes as Developmental', v.passed && v.errorType === 'Developmental', v.errorType);

  // "fing" for "thing": th->f is developmental.
  const th = applyLeniency(
    word('thing', 44, 'Mispronunciation', [
      { phoneme: 'θ', accuracyScore: 18 },
      { phoneme: 'ɪ', accuracyScore: 90 },
    ]),
  );
  ok('th→f "fing" passes as Developmental', th.passed && th.errorType === 'Developmental');

  // A genuine miss on a non-developmental phoneme must still fail.
  const real = applyLeniency(
    word('map', 30, 'Mispronunciation', [
      { phoneme: 'm', accuracyScore: 15 },
      { phoneme: 'æ', accuracyScore: 20 },
    ]),
  );
  ok('genuine mispronunciation still fails', !real.passed && real.errorType === 'Mispronunciation');

  // Omission is never forgiven.
  const om = applyLeniency(word('the', 0, 'Omission'));
  ok('omission is never forgiven', !om.passed && om.errorType === 'Omission');

  // Clean read.
  const clean = applyLeniency(word('cat', 96, 'None'));
  ok('clean read passes', clean.passed && clean.errorType === 'None');

  // Evidence-based: Azure tells us what it actually heard.
  const heardW = applyLeniency(
    word('rabbit', 50, 'Mispronunciation', [
      { phoneme: 'r', accuracyScore: 15, actual: ['w'] },
      { phoneme: 'æ', accuracyScore: 95 },
      { phoneme: 'b', accuracyScore: 90 },
    ]),
  );
  ok('r→w with evidence is forgiven', heardW.passed && heardW.errorType === 'Developmental');

  const heardWrong = applyLeniency(
    word('rabbit', 50, 'Mispronunciation', [
      { phoneme: 'r', accuracyScore: 15, actual: ['g'] },
      { phoneme: 'æ', accuracyScore: 95 },
      { phoneme: 'b', accuracyScore: 90 },
    ]),
  );
  ok('r→g (not a developmental swap) is NOT forgiven', !heardWrong.passed);

  // Velar fronting is excluded — /k/ is too common a phoneme to forgive blindly.
  const velar = applyLeniency(
    word('cat', 45, 'Mispronunciation', [
      { phoneme: 'k', accuracyScore: 20 },
      { phoneme: 'æ', accuracyScore: 92 },
      { phoneme: 't', accuracyScore: 90 },
    ]),
  );
  ok('k→? is NOT forgiven without evidence', !velar.passed);

  // Score floor: too far off to be a substitution.
  const floor = applyLeniency(
    word('rabbit', 12, 'Mispronunciation', [{ phoneme: 'r', accuracyScore: 5 }]),
  );
  ok('word below the score floor is never forgiven', !floor.passed);

  // Majority of phonemes wrong is an unknown word, not a lisp.
  const majority = applyLeniency(
    word('three', 40, 'Mispronunciation', [
      { phoneme: 'θ', accuracyScore: 20, actual: ['f'] },
      { phoneme: 'r', accuracyScore: 20, actual: ['w'] },
      { phoneme: 'i', accuracyScore: 95 },
    ]),
  );
  ok('majority-failing word is not forgiven', !majority.passed);
}

// --------------------------------------------------------------------------
console.log('\nPassage tracker (PLAN.md §9.4, §9.5)');
// --------------------------------------------------------------------------
{
  const t = new PassageTracker('The blue dragon sat down.');
  ok('tokenizes to 5 words', t.words.length === 5, String(t.words.length));

  // Straight clean read.
  const r = t.ingest([
    word('The', 95),
    word('blue', 92),
    word('dragon', 90),
    word('sat', 94),
    word('down', 91),
  ]);
  ok('clean read completes the passage', r.complete);
  ok('clean read needs no coaching', r.needsCoaching === null);
  ok('all-strong read reports wasStrong', t.wasStrong());
}
{
  // Best-attempt scoring: a bad first try then a good self-correction.
  const t = new PassageTracker('The cat sat.');
  t.ingest([word('The', 95)]);
  t.ingest([word('cat', 35, 'Mispronunciation', [{ phoneme: 'k', accuracyScore: 20 }])]);
  ok('failed word is marked coaching', t.words[1].status === 'coaching');

  const after = t.ingest([word('cat', 93)]);
  ok('self-correction passes the word', t.words[1].status === 'passed');
  ok('best-attempt score is kept, not the last', t.words[1].bestScore === 93, String(t.words[1].bestScore));
  ok('attempt count reflects the retry', t.words[1].attempts === 2, String(t.words[1].attempts));
  ok('passage still not complete', !after.complete);
}
{
  // Repetition / stutter: "the c... the cat sat"
  const t = new PassageTracker('The cat sat.');
  const r = t.ingest([
    word('The', 90),
    word('the', 88, 'Insertion'),
    word('cat', 91),
    word('sat', 89),
  ]);
  ok('insertion that repeats a prior word is ignored', r.complete);
  ok('insertion did not consume a reference word', t.words.every((w) => w.status === 'passed'));
}
{
  // Reading ahead / skipping: child jumps a word.
  const t = new PassageTracker('The big blue dragon ran.');
  t.ingest([word('The', 92), word('blue', 90), word('dragon', 93), word('ran', 91)]);
  const skipped = t.words[1];
  ok('skipped word is not silently passed', skipped.status !== 'passed', skipped.status);
  ok('words read ahead are still credited', t.words[2].status === 'passed');
}
{
  // Never force a re-read of a passed word.
  const t = new PassageTracker('Go now.');
  t.ingest([word('Go', 95), word('now', 95)]);
  const before = t.words.map((w) => w.status).join(',');
  t.ingest([word('Go', 10, 'Mispronunciation', [{ phoneme: 'ɡ', accuracyScore: 5 }])]);
  ok('a passed word is never downgraded', t.words.map((w) => w.status).join(',') === before);
}
{
  // markGiven advances past a word the narrator supplied.
  const t = new PassageTracker('A hard word.');
  t.ingest([word('A', 95)]);
  t.markGiven(1);
  ok('given word advances the cursor', t.cursor === 2, String(t.cursor));
  ok('given word is excluded from wasStrong', !t.wasStrong());
}

// --------------------------------------------------------------------------
console.log('\nWord detection hardening (words must not light up unspoken)');
// --------------------------------------------------------------------------
{
  // She says something else entirely. Azure still scores the audio against the
  // reference, and "the" in "I went to the park" is a real acoustic match — but
  // one incidental function word inside a sentence of something else is not
  // reading, and marking it read is the bug this gate exists to stop.
  const t = new PassageTracker('The cat sat on the hat.');
  const r = t.ingest([
    word('The', 82),
    word('cat', 0, 'Omission'),
    word('sat', 0, 'Omission'),
    word('on', 0, 'Omission'),
    word('the', 0, 'Omission'),
    word('hat', 0, 'Omission'),
    word('I', 90, 'Insertion'),
    word('went', 88, 'Insertion'),
    word('to', 91, 'Insertion'),
    word('park', 87, 'Insertion'),
  ]);
  ok('unrelated speech scores nothing', r.updates.length === 0, `${r.updates.length} updates`);
  ok('unrelated speech marks no word read', t.words.every((w) => w.status !== 'passed'));
  ok('unrelated speech triggers no coaching', r.needsCoaching === null);
}
{
  // Azure reports the WHOLE reference text on every utterance, so the rest of
  // the sentence comes back as Omission. Those are words she has not reached
  // yet, not words she skipped — coaching her on them is coaching her on a word
  // she was about to read.
  const t = new PassageTracker('The cat sat on the hat.');
  const r = t.ingest([
    word('The', 92),
    word('cat', 90),
    word('sat', 91),
    word('on', 0, 'Omission'),
    word('the', 0, 'Omission'),
    word('hat', 0, 'Omission'),
  ]);
  ok('words she read are credited', t.words.slice(0, 3).every((w) => w.status === 'passed'));
  ok(
    // The word at the cursor is 'current'; the rest are untouched. Neither is
    // an error state, which is the point — she simply has not read them yet.
    'words she has not reached are not marked wrong',
    t.words.slice(3).every((w) => w.status === 'pending' || w.status === 'current'),
    t.words.slice(3).map((w) => w.status).join(','),
  );
  ok('no coaching on an unread word', r.needsCoaching === null, String(r.needsCoaching));
  ok('cursor sits on the next word', t.cursor === 3, String(t.cursor));
}
{
  // A word she genuinely read past is still a skip.
  const t = new PassageTracker('The cat sat on the hat.');
  const r = t.ingest([
    word('The', 92),
    word('cat', 90),
    word('sat', 0, 'Omission'),
    word('on', 0, 'Omission'),
    word('the', 0, 'Omission'),
    word('hat', 88),
  ]);
  ok('a word read past is marked, not ignored', t.words[2].status === 'coaching', t.words[2].status);
  ok('the word she jumped to is credited', t.words[5].status === 'passed');
  ok('coaching points at the skipped word', r.needsCoaching === 2, String(r.needsCoaching));
}
{
  // Silence, or noise that aligned to nothing.
  const t = new PassageTracker('The cat sat.');
  const r = t.ingest([
    word('The', 0, 'Omission'),
    word('cat', 0, 'Omission'),
    word('sat', 0, 'Omission'),
  ]);
  ok('an utterance with no hits changes nothing', r.updates.length === 0);
  ok('silence leaves the passage untouched', t.words.every((w) => w.status !== 'coaching'));
}
{
  // Interim hypotheses move the highlight without scoring anything.
  const t = new PassageTracker('The blue dragon sat.');
  ok('partial finds the word just spoken', t.heard('The blue') === 1, String(t.heard('The blue')));
  ok('partial ignores words that are not in the passage', t.heard('banana') === null);
  ok('partial scores nothing', t.words.every((w) => w.bestScore === null));
  ok('partial does not advance the real cursor', t.cursor === 0, String(t.cursor));
}

// --------------------------------------------------------------------------
console.log('\nSession opening (time of day, time since last session)');
// --------------------------------------------------------------------------
{
  // Whether to onboard is decided by whether a child row exists, not here. A
  // null gap means we know her but have never read together — the seeded demo
  // child, and anyone whose first session ended before it saved. She still gets
  // asked something.
  const firstStory = planOpening({ hoursSinceLast: null, localHour: 9, rand: 0 });
  ok('no history yet → the first-story opening', firstStory.shape === 'first_story', firstStory.shape);
  ok('she is still asked something', firstStory.question.length > 0, firstStory.question);
  ok('and given room to answer', firstStory.maxTurns > 0);

  const quick = planOpening({ hoursSinceLast: 1, localHour: 15, rand: 0 });
  ok('back within the hour → quick return', quick.shape === 'quick_return');
  ok('a quick return asks for one thing at most', quick.maxTurns === 1, String(quick.maxTurns));

  ok('later the same day → same day', planOpening({ hoursSinceLast: 8, localHour: 18 }).shape === 'same_day');

  const morning = planOpening({ hoursSinceLast: 24, localHour: 8, rand: 0 });
  ok('next morning asks about yesterday', /yesterday/i.test(morning.question), morning.question);

  const evening = planOpening({ hoursSinceLast: 24, localHour: 20, rand: 0 });
  ok('evening asks about today', /your day/i.test(evening.question), evening.question);

  ok('days away → long gap', planOpening({ hoursSinceLast: 100, localHour: 11 }).shape === 'long_gap');

  // Same shape, different words — the opening must not be the same every day.
  const variants = new Set(
    [0, 0.4, 0.9].map((r) => planOpening({ hoursSinceLast: 24, localHour: 8, rand: r }).question),
  );
  ok('the opening varies within a shape', variants.size > 1, `${variants.size} variants`);
}
{
  ok(
    'what she said last time beats an open story thread',
    /alligator/.test(rememberLine({ lastNoteSubject: 'an alligator at the park', openThread: 'the lost bell', rand: 0 }) ?? ''),
  );
  ok(
    'an open thread is used when she said nothing',
    /bell/.test(rememberLine({ lastNoteSubject: null, openThread: 'the lost bell', rand: 0 }) ?? ''),
  );
  ok('nothing remembered means nothing said', rememberLine({}) === null);
}

// --------------------------------------------------------------------------
console.log('\nThe notebook (what she volunteered, and when it surfaces)');
// --------------------------------------------------------------------------
{
  const note = (id: number, kind: ChildNote['kind'], subject: string, weight = 1): ChildNote => ({
    id,
    kind,
    subject,
    detail: null,
    weight,
    status: 'queued',
  });

  const queued = [
    note(1, 'interest', 'dragons', 2),
    note(2, 'question', 'why the sky is blue'),
    note(3, 'event', 'a loose tooth', 3),
    note(4, 'mood', 'tired'),
  ];

  const cameo = pickCameo(queued, 0);
  ok('a cameo picks something you can picture', cameo?.subject === 'a loose tooth', cameo?.subject);
  ok('one cameo per session, and no more', pickCameo(queued, 1) === null);
  ok(
    'moods and questions never become cameos',
    pickCameo([note(9, 'mood', 'tired'), note(10, 'question', 'why is grass green')], 0) === null,
  );

  const plan = pickPlanNotes(queued);
  ok('the story is built from at most two details', plan.material.length <= MAX_SUBJECTS_PER_PLAN);
  ok('the heaviest detail leads', plan.material[0]?.subject === 'a loose tooth', plan.material[0]?.subject);
  ok('the question jar hands back a question', plan.question?.subject === 'why the sky is blue');
  ok('moods are absorbed, not turned into stories', !plan.material.some((n) => n.kind === 'mood'));

  const spent = [{ ...note(5, 'event', 'a birthday'), status: 'used' as const }];
  ok('a detail already used is not reused', pickPlanNotes(spent).material.length === 0);

  // She mentions the same thing across sessions; it must not eat both slots.
  const repeated = pickPlanNotes([
    note(6, 'event', 'a loose tooth', 3),
    note(7, 'event', 'A Loose Tooth', 3),
    note(8, 'interest', 'dragons', 2),
  ]);
  ok('a repeated subject only takes one slot', repeated.material.length === 2, String(repeated.material.length));
  ok('the second slot goes to something else', repeated.material[1]?.subject === 'dragons');
}
{
  ok('a known character is generalized', generalizeSubject('Elsa') === 'a snow queen', generalizeSubject('Elsa'));
  ok('a brand is generalized', /building game/.test(generalizeSubject('minecraft')));
  ok('her own cat is kept literally', generalizeSubject('her cat Pepper') === 'her cat Pepper');
}

// --------------------------------------------------------------------------
console.log('\nSpoken lines back to the child');
// --------------------------------------------------------------------------
{
  ok(
    'a short specific line survives',
    sanitizeSpokenLine('A loose tooth! I am keeping that one.') ===
      'A loose tooth! I am keeping that one.',
  );
  ok('a naked line gets punctuation for the voice', sanitizeSpokenLine('Nice') === 'Nice!');
  ok('emoji are stripped before TTS', sanitizeSpokenLine('Wow 🎉 nice.') === 'Wow nice.');
  ok('stage directions are stripped', sanitizeSpokenLine('(warmly) That is lovely.') === 'That is lovely.');
  ok('a whole paragraph is rejected', sanitizeSpokenLine('a '.repeat(30)) === null);
  ok(
    'three sentences is a conversation, not an acknowledgment',
    sanitizeSpokenLine('Oh! That is nice. Tell me more. I love it.') === null,
  );
  ok('nothing in, nothing out', sanitizeSpokenLine('') === null);
  // Unlike the between-turns acknowledgment, this one is allowed to name things.
  ok('naming her detail is the whole point', sanitizeSpokenLine('A puppy. What colour?') !== null);
}
{
  ok('yes means one more', parseYesNo('yes please') === true);
  ok('yeah means one more', parseYesNo('yeah!') === true);
  ok('no means stop', parseYesNo('no thanks') === false);
  ok('the decisive word leads', parseYesNo("no, I'm done") === false);
  ok('a mumble is not a yes', parseYesNo('um') === null);
  ok('silence is not a yes', parseYesNo(null) === null);
}
{
  ok('a name is pulled out of a sentence', guessName('my name is Maya') === 'Maya');
  ok('filler before the name is dropped', guessName("um, I'm sam") === 'Sam');
  ok('a bare name works', guessName('Rosie') === 'Rosie');
  ok('no speech means no guess', guessName(null) === null);
}

// --------------------------------------------------------------------------
console.log('\nWord → skill mapping');
// --------------------------------------------------------------------------
{
  ok('"blue" maps to blend_bl', skillsForWord('blue').includes('blend_bl'));
  ok('"cat" maps to short_a', skillsForWord('cat').includes('short_a'));
  ok('"ship" maps to digraph_sh', skillsForWord('ship').includes('digraph_sh'));
  ok('"because" maps to its sight word', skillsForWord('because').includes('sight_because'));
  ok('punctuation is stripped', skillsForWord('cat,').includes('short_a'));
  ok('silent-e word is not scored as a short vowel', !skillsForWord('cake').includes('short_a'));
}

// --------------------------------------------------------------------------
console.log('\nPedagogy (PLAN.md §11)');
// --------------------------------------------------------------------------
{
  const start = [{ skill_id: 'short_a', p_mastery: 0.2, last_practiced: null }];

  const up = updateMastery(
    [{ expected_word: 'cat', attempt: 1, error_type: 'None', accuracy_score: 95 }],
    start,
  );
  const shortA = up.find((u) => u.skill_id === 'short_a')!;
  ok('correct read raises mastery by 0.15*(1-p)', Math.abs(shortA.p_mastery - 0.32) < 1e-6, String(shortA.p_mastery));

  const down = updateMastery(
    [{ expected_word: 'cat', attempt: 1, error_type: 'Mispronunciation', accuracy_score: 20 }],
    start,
  );
  ok(
    'error lowers mastery by 0.2*p',
    Math.abs(down.find((u) => u.skill_id === 'short_a')!.p_mastery - 0.16) < 1e-6,
  );

  const dev = updateMastery(
    [{ expected_word: 'cat', attempt: 1, error_type: 'Developmental', accuracy_score: 45 }],
    start,
  );
  ok(
    'Developmental counts as correct',
    Math.abs(dev.find((u) => u.skill_id === 'short_a')!.p_mastery - 0.32) < 1e-6,
  );

  const retry = updateMastery(
    [{ expected_word: 'cat', attempt: 2, error_type: 'None', accuracy_score: 99 }],
    start,
  );
  ok('coached retries do not inflate mastery', retry.length === 0);
}
{
  const mastery = SKILLS.map((s) => ({
    skill_id: s.id,
    p_mastery: s.id === 'short_a' ? 0.9 : 0.2,
    last_practiced: null,
  }));
  const targets = pickTargets(mastery);
  ok('pickTargets returns exactly 3', targets.length === 3, String(targets.length));
  ok('targets are unique', new Set(targets).size === targets.length);
  ok('a mastered skill is offered for review', targets.includes('short_a'));
}

// --------------------------------------------------------------------------
console.log('\nAzure SDK usage (offline object construction)');
// --------------------------------------------------------------------------
{
  // Validates our API usage without touching the network — construction and
  // applyTo are entirely local; only startContinuousRecognitionAsync connects.
  const config = sdk.SpeechConfig.fromSubscription('dummy-key', 'eastus');
  config.speechRecognitionLanguage = 'en-US';

  const format = sdk.AudioStreamFormat.getWaveFormatPCM(AUDIO.micSampleRate, 16, 1);
  const push = sdk.AudioInputStream.createPushStream(format);
  const audioConfig = sdk.AudioConfig.fromStreamInput(push);
  const recognizer = new sdk.SpeechRecognizer(config, audioConfig);

  const pa = new sdk.PronunciationAssessmentConfig(
    'The blue dragon sat down.',
    sdk.PronunciationAssessmentGradingSystem.HundredMark,
    sdk.PronunciationAssessmentGranularity.Phoneme,
    true,
  );
  pa.applyTo(recognizer);

  const json = JSON.parse(pa.toJSON());
  ok('referenceText is set', json.referenceText === 'The blue dragon sat down.');
  ok('gradingSystem is HundredMark', json.gradingSystem === 'HundredMark');
  ok('granularity is Phoneme', json.granularity === 'Phoneme');
  ok('enableMiscue is true', json.enableMiscue === true);

  // The push stream must accept the exact buffer shape onAudio() forwards.
  push.write(new ArrayBuffer(640 * 2));
  ok('push stream accepts a 40ms PCM16 frame', true);

  push.close();
  recognizer.close();
}

// --------------------------------------------------------------------------
console.log('\nAudio framing');
// --------------------------------------------------------------------------
{
  ok('mic rate is 16kHz for Azure', AUDIO.micSampleRate === 16000);
  ok('TTS rate is 44.1kHz for Web Audio', AUDIO.ttsSampleRate === 44100);
  ok('half-duplex tail is 300ms', AUDIO.gateTailMs === 300);
  ok('tokenizer drops pure punctuation', tokenize('Hi -- there!').length === 2);
}

// --------------------------------------------------------------------------
console.log('\nPraise word selection (never credit an unspoken word)');
// --------------------------------------------------------------------------
{
  // The reported failure: child read "The frog glides and hops.", narrator
  // praised "glad" — a blend_gl example word sitting in its plan context.
  const t = new PassageTracker('The frog glides and hops.');
  t.ingest([
    word('The', 96),
    word('frog', 88),
    word('glides', 93),
    word('and', 95),
    word('hops', 90),
  ]);

  const picked = pickPraiseWord(t.words);
  ok('picks a word actually in the passage', picked !== null && /^(frog|glides|hops)$/.test(picked!), String(picked));
  ok('picks the highest-scoring substantive word', picked === 'glides', String(picked));
  ok('never picks a trivial sight word', picked !== 'The' && picked !== 'and');

  ok('mentionsWord accepts the exact word', mentionsWord('You read glides so smoothly!', 'glides'));
  ok('mentionsWord rejects the hallucinated word', !mentionsWord('You read glad so smoothly!', 'glides'));
  ok('mentionsWord is not fooled by a prefix', !mentionsWord('You read glide well', 'glides'));
  ok('mentionsWord ignores case', mentionsWord('GLIDES was great', 'glides'));
  ok('mentionsWord tolerates quoting', mentionsWord('You read "glides" well', 'glides'));
}
{
  // A coached word is not praiseworthy — it took more than one attempt.
  const t = new PassageTracker('The dragon roared loudly.');
  t.ingest([word('The', 95)]);
  t.ingest([word('dragon', 30, 'Mispronunciation', [{ phoneme: 'd', accuracyScore: 10 }])]);
  t.ingest([word('dragon', 91)]);
  t.ingest([word('roared', 94), word('loudly', 92)]);
  const picked = pickPraiseWord(t.words);
  ok('skips a word that needed coaching', picked !== 'dragon', String(picked));
  ok('still returns a real word', picked === 'roared' || picked === 'loudly', String(picked));
}
{
  // Punctuation must not reach the narrator as part of the word.
  const t = new PassageTracker('Blue went home.');
  t.ingest([word('Blue', 90), word('went', 92), word('home', 97)]);
  ok('strips trailing punctuation', pickPraiseWord(t.words) === 'home', String(pickPraiseWord(t.words)));
}
{
  // Nothing passed — must return null rather than invent something.
  const t = new PassageTracker('Xylophone zebra.');
  ok('returns null when nothing was read', pickPraiseWord(t.words) === null);
}

// --------------------------------------------------------------------------
console.log('\nTurn-transition acknowledgment');
// --------------------------------------------------------------------------
{
  ok('accepts a plain interjection', sanitizeAcknowledgment('Nice!') === 'Nice!');
  ok('adds punctuation for TTS prosody', sanitizeAcknowledgment('Great job') === 'Great job!');
  ok('strips wrapping quotes', sanitizeAcknowledgment('"Wow!"') === 'Wow!');
  ok('strips markdown', sanitizeAcknowledgment('**Lovely!**') === 'Lovely!');
  ok('strips emoji', sanitizeAcknowledgment('Nice! 🎉') === 'Nice!');
  ok('collapses whitespace', sanitizeAcknowledgment('  You   got  it! ') === 'You got it!');

  ok('rejects empty', sanitizeAcknowledgment('') === null);
  ok('rejects null', sanitizeAcknowledgment(null) === null);
  ok(
    'rejects anything too long to be a transition',
    sanitizeAcknowledgment('That was a really wonderful piece of reading my friend') === null,
  );
  ok(
    'rejects a word citation (the "glad" bug class)',
    sanitizeAcknowledgment('You read "glides" well!') === null,
  );
  ok('rejects digits', sanitizeAcknowledgment('All 5 words!') === null);
  ok(
    'rejects continuing the story',
    sanitizeAcknowledgment('Nice! Blue flew away over the hills.') === null,
  );

  // Band classification drives the tone the model is asked for.
  const flawless = new PassageTracker('The frog hops fast.');
  flawless.ingest([word('The', 96), word('frog', 92), word('hops', 90), word('fast', 94)]);
  ok('flawless read is banded flawless', summarizeReading(flawless.words).band === 'flawless');

  const effortful = new PassageTracker('The dragon roared.');
  effortful.ingest([word('The', 95)]);
  effortful.markGiven(1);
  effortful.ingest([word('roared', 88)]);
  ok('a given word makes it effortful', summarizeReading(effortful.words).band === 'effortful');

  const solid = new PassageTracker('The cat sat down.');
  solid.ingest([word('The', 95)]);
  solid.ingest([word('cat', 40, 'Mispronunciation', [{ phoneme: 'k', accuracyScore: 20 }])]);
  solid.ingest([word('cat', 90), word('sat', 92), word('down', 91)]);
  ok('one wobble is banded solid', summarizeReading(solid.words).band === 'solid', summarizeReading(solid.words).band);
}

// --------------------------------------------------------------------------
console.log('\nWAV encoding (audio-check isolation path)');
// --------------------------------------------------------------------------
{
  // One second of 440Hz at 44.1kHz as float32 LE, the shape Cartesia streams.
  const n = 44100;
  const pcm = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) pcm.writeFloatLE(Math.sin((2 * Math.PI * 440 * i) / n) * 0.5, i * 4);

  const wav = floatPcmToWav(pcm, 44100);

  ok('RIFF magic', wav.toString('ascii', 0, 4) === 'RIFF');
  ok('WAVE magic', wav.toString('ascii', 8, 12) === 'WAVE');
  ok('format is PCM (1)', wav.readUInt16LE(20) === 1);
  ok('mono', wav.readUInt16LE(22) === 1);
  ok('sample rate 44100', wav.readUInt32LE(24) === 44100);
  ok('16 bits per sample', wav.readUInt16LE(34) === 16);
  ok('byte rate matches', wav.readUInt32LE(28) === 44100 * 2);
  ok('block align matches', wav.readUInt16LE(32) === 2);
  ok('data chunk size matches sample count', wav.readUInt32LE(40) === n * 2);
  ok('total length = 44 + data', wav.length === 44 + n * 2);
  ok('RIFF size field = length - 8', wav.readUInt32LE(4) === wav.length - 8);
  // Clipping must saturate, not wrap around to the opposite sign.
  const loud = Buffer.alloc(8);
  loud.writeFloatLE(2.5, 0);
  loud.writeFloatLE(-2.5, 4);
  const clipped = floatPcmToWav(loud, 44100);
  ok('positive clipping saturates', clipped.readInt16LE(44) === 32767, String(clipped.readInt16LE(44)));
  ok('negative clipping saturates', clipped.readInt16LE(46) === -32768, String(clipped.readInt16LE(46)));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
