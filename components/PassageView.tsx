'use client';

import type { TrackedWord } from '@/lib/types';

export interface WordState {
  word: string;
  /** 'reading' is provisional — Azure thinks she just said it, nothing is scored yet. */
  status: TrackedWord['status'] | 'reading';
  score: number | null;
}

/**
 * How well a word was read, as depth of colour rather than a number.
 *
 * A six-year-old cannot read "accuracy 72" and should not have to. Deep green
 * means that was right, pale green means close enough, amber means let's try
 * that one again — which is the same three-way judgment the state machine is
 * already making, said in the only language that does not need reading.
 */
function tone(w: WordState): string {
  if (w.status !== 'passed') return '';
  const score = w.score ?? 0;
  if (score >= 90) return 'strong';
  if (score >= 70) return 'fair';
  return 'faint';
}

/** The story text on screen with the current word highlighted. PLAN.md §14 step 11. */
export default function PassageView({
  words,
  cursor,
}: {
  words: WordState[];
  cursor: number;
}) {
  if (words.length === 0) {
    return <div className="empty-passage">Listen to Ollie…</div>;
  }

  return (
    <div className="passage">
      {words.map((w, i) => {
        const status = w.status === 'pending' && i === cursor ? 'current' : w.status;
        return (
          <span
            key={i}
            className="word"
            data-status={status}
            data-tone={tone(w) || undefined}
            title={w.score !== null ? `accuracy ${Math.round(w.score)}` : undefined}
          >
            {w.word}
          </span>
        );
      })}
    </div>
  );
}
