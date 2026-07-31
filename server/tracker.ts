import { applyLeniency, WORD_STRONG_THRESHOLD } from '../lib/leniency';
import { normalizeWord } from '../lib/skills';
import type { ErrorType, TrackedWord, WordAssessment } from '../lib/types';

/**
 * Follows the child through a passage word by word.
 *
 * Handles the messy reality of how kids actually read (PLAN.md §9.4, §9.5):
 *   - best-attempt scoring: a word is scored by its best attempt, not its last
 *   - self-corrections count as correct (attempt = 2)
 *   - insertions that repeat the previous 1-2 words are ignored, not penalised
 *   - reading ahead is fine; we track the furthest matched word and never make
 *     a child go back to a word they already passed
 */

export interface WordUpdate {
  index: number;
  word: TrackedWord;
  /** Emitted so callers can persist a reading_events row. */
  event: {
    expected_word: string;
    attempt: number;
    error_type: ErrorType;
    accuracy_score: number;
    phonemes: unknown;
    pause_ms: number;
  } | null;
}

export interface IngestResult {
  updates: WordUpdate[];
  /** Word the child needs help with right now, or null. */
  needsCoaching: number | null;
  complete: boolean;
}

/** How far ahead we'll look to realign when a child skips or reads ahead. */
const LOOKAHEAD = 3;

/**
 * An utterance this weak is treated as noise and ingested as nothing.
 *
 * Azure scores audio against the reference text, so unrelated speech still
 * produces per-word results — and a child saying "I went to the park" while the
 * passage reads "the cat sat on the hat" lands a real match on "the". One
 * incidental function word inside a sentence of something else is not reading,
 * and marking it read is how words turn green that were never spoken.
 */
const MIN_HITS_WHEN_MOSTLY_INSERTIONS = 2;

/** Did Azure actually hear audio for this reference word? */
function isHit(a: WordAssessment): boolean {
  return a.errorType !== 'Omission' && a.errorType !== 'Insertion';
}

export class PassageTracker {
  readonly words: TrackedWord[];
  private furthest = 0;
  private lastWordAt = Date.now();

  constructor(public readonly passage: string) {
    this.words = tokenize(passage).map((expected, index) => ({
      index,
      expected,
      bestScore: null,
      errorType: null,
      attempts: 0,
      status: index === 0 ? 'current' : 'pending',
    }));
  }

  get cursor(): number {
    return this.furthest;
  }

  /** Words the child has not yet passed or been given. */
  private firstUnresolved(): number | null {
    const w = this.words.find((x) => x.status !== 'passed' && x.status !== 'given');
    return w ? w.index : null;
  }

  /** Milliseconds since the last accepted word — feeds the pause > 3000ms rule. */
  msSinceProgress(): number {
    return Date.now() - this.lastWordAt;
  }

  markCoaching(index: number) {
    const w = this.words[index];
    if (w && w.status !== 'passed') w.status = 'coaching';
  }

  /** Narrator said the word out loud and moved on. Not a mastery signal. */
  markGiven(index: number) {
    const w = this.words[index];
    if (!w) return;
    w.status = 'given';
    this.advanceCursor();
    this.lastWordAt = Date.now();
  }

  private advanceCursor() {
    const next = this.firstUnresolved();
    this.furthest = next ?? this.words.length;
    for (const w of this.words) {
      if (w.status === 'pending' && w.index === this.furthest) w.status = 'current';
    }
  }

  isComplete(): boolean {
    return this.words.every((w) => w.status === 'passed' || w.status === 'given');
  }

  /** True when every word was read strongly — the ENCOURAGE signal. */
  wasStrong(): boolean {
    return this.words.every(
      (w) => w.status === 'passed' && (w.bestScore ?? 0) >= WORD_STRONG_THRESHOLD,
    );
  }

  summary() {
    return this.words.map((w) => ({
      word: w.expected,
      score: w.bestScore,
      status: w.status,
      errorType: w.errorType,
    }));
  }

  /**
   * Interim hypothesis from Azure -> the word she appears to have just said.
   *
   * Scores nothing and changes no state. It exists so the highlight moves while
   * she is still speaking: the scored result only lands after end-of-utterance
   * silence, which is a second later and feels broken to a child who has already
   * moved on. Partial hypotheses grow word by word, so the last token is the one
   * she said most recently.
   */
  heard(partialText: string): number | null {
    const tokens = tokenize(partialText).map(normalizeWord).filter(Boolean);
    const last = tokens[tokens.length - 1];
    if (!last) return null;

    const from = this.firstUnresolved() ?? this.words.length;
    for (let i = from; i < Math.min(from + LOOKAHEAD + 2, this.words.length); i++) {
      if (normalizeWord(this.words[i].expected) === last) return i;
    }
    return null;
  }

  /**
   * Resolve each Azure result to the passage word it refers to, without touching
   * any state. Separating this from applying it is what makes the guards below
   * possible: they need to see the whole utterance before deciding any of it.
   */
  private align(assessments: WordAssessment[]): { a: WordAssessment; target: number }[] {
    const resolved: { a: WordAssessment; target: number }[] = [];
    let pointer = this.firstUnresolved() ?? this.words.length;

    for (const a of assessments) {
      const spoken = normalizeWord(a.word);
      if (!spoken) continue;

      // Insertions are stutters, run-ups, or speech that is not in the passage
      // at all. Never an error, never a match. §9.4/§9.6
      if (a.errorType === 'Insertion') continue;

      // Align by matching the reference word. With enableMiscue Azure returns
      // Words[] in reference order (including Omissions), so `Word` is the
      // reference token — a normalized match is the reliable signal.
      //
      // The window starts at the pointer and only moves forward, so a child who
      // reads ahead is credited while a stray word cannot reach back and claim
      // something already behind her. Nothing matched means we ignore the result
      // rather than score it against whatever happens to be under the cursor:
      // crediting the wrong word is far worse than ignoring one utterance.
      let target = -1;
      for (let i = pointer; i < Math.min(pointer + LOOKAHEAD + 1, this.words.length); i++) {
        if (normalizeWord(this.words[i].expected) === spoken) {
          target = i;
          break;
        }
      }
      if (target < 0) continue;

      resolved.push({ a, target });
      pointer = target + 1;
    }

    return resolved;
  }

  /**
   * Fold one utterance's worth of Azure word results into the tracker.
   */
  ingest(assessments: WordAssessment[]): IngestResult {
    const updates: WordUpdate[] = [];
    const resolved = this.align(assessments);

    const hits = resolved.filter((r) => isHit(r.a));
    const insertions = assessments.filter((a) => a.errorType === 'Insertion').length;

    // Noise gate (§9.6). Nothing in this utterance was actually heard against the
    // passage, or she was mostly saying something else and one incidental word
    // happened to line up. Either way this is not reading, so it scores nothing.
    if (hits.length === 0) {
      return { updates, needsCoaching: null, complete: this.isComplete() };
    }
    if (insertions > hits.length && hits.length < MIN_HITS_WHEN_MOSTLY_INSERTIONS) {
      return { updates, needsCoaching: null, complete: this.isComplete() };
    }

    // Azure reports the WHOLE reference text on every utterance, so every word
    // she has not reached yet comes back as an Omission. Those are not skips —
    // they are the rest of the sentence. A word only counts as skipped when she
    // demonstrably read past it, which means a later word in this same utterance
    // was actually heard.
    const lastHeard = Math.max(...hits.map((r) => r.target));

    for (const { a, target } of resolved) {
      if (a.errorType === 'Omission' && target > lastHeard) continue;

      const word = this.words[target];
      if (!word || word.status === 'passed' || word.status === 'given') continue;

      const verdict = applyLeniency(a);
      word.attempts += 1;
      // Best-attempt scoring: never let a worse retry pull the score down.
      word.bestScore = Math.max(word.bestScore ?? 0, a.accuracyScore);
      word.errorType = verdict.errorType;

      if (verdict.passed) {
        word.status = 'passed';
        this.lastWordAt = Date.now();
      } else {
        word.status = 'coaching';
      }

      updates.push({
        index: word.index,
        word,
        event: {
          expected_word: word.expected,
          attempt: word.attempts,
          error_type: verdict.errorType,
          accuracy_score: a.accuracyScore,
          phonemes: a.phonemes,
          pause_ms: 0,
        },
      });
    }

    this.advanceCursor();

    const unresolved = this.firstUnresolved();
    const needsCoaching =
      unresolved !== null && this.words[unresolved].status === 'coaching' ? unresolved : null;

    return { updates, needsCoaching, complete: this.isComplete() };
  }
}

/** Split a passage into readable word tokens, preserving display punctuation. */
export function tokenize(passage: string): string[] {
  return passage
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && /[a-zA-Z]/.test(w));
}
