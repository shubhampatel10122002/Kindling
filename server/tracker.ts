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
   * Fold one utterance's worth of Azure word results into the tracker.
   */
  ingest(assessments: WordAssessment[]): IngestResult {
    const updates: WordUpdate[] = [];
    let pointer = this.firstUnresolved() ?? this.words.length;
    const recentlyExpected: string[] = [];

    for (const a of assessments) {
      const spoken = normalizeWord(a.word);
      if (!spoken) continue;

      // Insertions: a repetition of the last 1-2 expected words is a stutter or a
      // run-up, not an error. Anything else unmatched is treated as noise. §9.4/§9.6
      if (a.errorType === 'Insertion') {
        continue;
      }

      // Align by matching the reference word. With enableMiscue Azure returns
      // Words[] in reference order (including Omissions), so `Word` is the
      // reference token — a normalized match is the reliable signal.
      //
      // We search the whole passage, preferring the nearest match at or after
      // the cursor, so a child who reads ahead is credited correctly. If nothing
      // matches, we skip the result rather than scoring it against whatever word
      // happens to be under the cursor — crediting or penalising the wrong word
      // is far worse than ignoring one utterance (§9.6 noise gating).
      let target = -1;
      for (let i = pointer; i < Math.min(pointer + LOOKAHEAD + 1, this.words.length); i++) {
        if (normalizeWord(this.words[i].expected) === spoken) {
          target = i;
          break;
        }
      }
      if (target < 0) {
        // Re-reading a word already resolved (a self-correction that arrived
        // late, or the run-up to the current word). Harmless — ignore it.
        continue;
      }

      const word = this.words[target];
      if (!word || word.status === 'passed' || word.status === 'given') {
        pointer = this.firstUnresolved() ?? this.words.length;
        continue;
      }

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

      recentlyExpected.push(spoken);
      if (recentlyExpected.length > 2) recentlyExpected.shift();

      pointer = this.firstUnresolved() ?? this.words.length;
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
