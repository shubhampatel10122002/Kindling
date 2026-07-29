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
import type { WordAssessment } from '../lib/types';

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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
