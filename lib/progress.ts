/**
 * Reading history, read back out of `reading_events`.
 *
 * Two things need this. The child needs "you can read *friend* now, and that one
 * used to be tricky" — one concrete thing she can do that she could not before,
 * in plain words, no scores. The parent needs the same history as a shape:
 * which words keep coming back, how much she has read, whether it is going up.
 *
 * All of it comes from first attempts only, because a word read correctly on the
 * third coached try is not yet a word she can read.
 */

import { query } from './db';
import { normalizeWord } from './skills';

/** Words too small to make "you can read this now" feel like an achievement. */
const TRIVIAL = new Set([
  'a', 'i', 'an', 'and', 'the', 'is', 'it', 'in', 'on', 'to', 'at', 'of', 'up',
  'go', 'so', 'we', 'he', 'me', 'my', 'no', 'do', 'was', 'has', 'had', 'her',
  'his', 'she', 'you', 'not', 'but', 'for', 'are',
]);

function substantive(word: string): boolean {
  const w = normalizeWord(word);
  return w.length >= 4 && !TRIVIAL.has(w);
}

const OK = "COALESCE(error_type,'None') IN ('None','Developmental')";

interface FlipRow {
  expected_word: string;
  last_ok: number;
  last_miss: number;
  ok_session: string | null;
}

/**
 * Words she used to miss and now reads on the first try, most recent first.
 *
 * Pass `sessionId` to keep only the ones that flipped during that session —
 * that is the version worth saying out loud at the end of it.
 */
export async function improvedWords(
  childId: string,
  opts: { sessionId?: string; limit?: number } = {},
): Promise<string[]> {
  const rows = await query<FlipRow>(
    `WITH firsts AS (
       SELECT expected_word, id, session_id, ${OK} AS ok
       FROM reading_events
       WHERE child_id = $1 AND attempt = 1 AND expected_word IS NOT NULL
     )
     SELECT expected_word,
            max(id) FILTER (WHERE ok)     AS last_ok,
            max(id) FILTER (WHERE NOT ok) AS last_miss,
            (array_agg(session_id ORDER BY id DESC) FILTER (WHERE ok))[1] AS ok_session
     FROM firsts
     GROUP BY expected_word
     HAVING max(id) FILTER (WHERE ok) IS NOT NULL
        AND max(id) FILTER (WHERE NOT ok) IS NOT NULL
        AND max(id) FILTER (WHERE ok) > max(id) FILTER (WHERE NOT ok)
     ORDER BY max(id) FILTER (WHERE ok) DESC
     LIMIT 40`,
    [childId],
  );

  return rows
    .filter((r) => substantive(r.expected_word))
    .filter((r) => !opts.sessionId || r.ok_session === opts.sessionId)
    .map((r) => r.expected_word.replace(/^[^a-zA-Z']+|[^a-zA-Z']+$/g, ''))
    .slice(0, opts.limit ?? 3);
}

export interface StickyWord {
  word: string;
  misses: number;
  attempts: number;
}

/** Words she keeps stumbling on. The parent view's "worth practising" list. */
export async function stickyWords(childId: string, limit = 8): Promise<StickyWord[]> {
  const rows = await query<{ word: string; misses: number; attempts: number }>(
    `SELECT expected_word AS word,
            count(*) FILTER (WHERE NOT (${OK}))::int AS misses,
            count(*)::int AS attempts
     FROM reading_events
     WHERE child_id = $1 AND attempt = 1 AND expected_word IS NOT NULL
     GROUP BY expected_word
     HAVING count(*) FILTER (WHERE NOT (${OK})) >= 2
     ORDER BY count(*) FILTER (WHERE NOT (${OK})) DESC, count(*) DESC
     LIMIT $2`,
    [childId, limit],
  );
  return rows.filter((r) => substantive(r.word));
}

export interface ReadingSnapshot {
  sessions: number;
  wordsRead: number;
  /** Share of first attempts that were correct, all time. */
  accuracyAllTime: number;
  /** Same, over the ten most recent sessions — the trend line. */
  accuracyRecent: number;
}

export async function readingSnapshot(childId: string): Promise<ReadingSnapshot> {
  const totals = await query<{ words: number; ok: number; sessions: number }>(
    `SELECT count(*)::int AS words,
            count(*) FILTER (WHERE ${OK})::int AS ok,
            count(DISTINCT session_id)::int AS sessions
     FROM reading_events WHERE child_id = $1 AND attempt = 1`,
    [childId],
  );

  const recent = await query<{ words: number; ok: number }>(
    `SELECT count(*)::int AS words, count(*) FILTER (WHERE ${OK})::int AS ok
     FROM reading_events
     WHERE child_id = $1 AND attempt = 1
       AND session_id IN (
         SELECT id FROM sessions WHERE child_id = $1 ORDER BY started_at DESC LIMIT 10
       )`,
    [childId],
  );

  const t = totals[0] ?? { words: 0, ok: 0, sessions: 0 };
  const r = recent[0] ?? { words: 0, ok: 0 };

  return {
    sessions: t.sessions,
    wordsRead: t.words,
    accuracyAllTime: t.words ? t.ok / t.words : 0,
    accuracyRecent: r.words ? r.ok / r.words : 0,
  };
}
