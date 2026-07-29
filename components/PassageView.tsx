'use client';

import type { TrackedWord } from '@/lib/types';

export interface WordState {
  word: string;
  status: TrackedWord['status'];
  score: number | null;
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
            title={w.score !== null ? `accuracy ${Math.round(w.score)}` : undefined}
          >
            {w.word}
          </span>
        );
      })}
    </div>
  );
}
