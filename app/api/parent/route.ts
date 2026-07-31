import { NextResponse } from 'next/server';
import { query, getDemoChild } from '@/lib/db';
import { improvedWords, stickyWords, readingSnapshot } from '@/lib/progress';
import { SKILL_BY_ID } from '@/lib/skills';
import type { ChildMemory, ChildNote, Mastery, TranscriptEntry } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Everything the parent view shows, in one call.
 *
 * Read-only by construction: this route never writes, so looking at the
 * dashboard can never change what the tutor believes about the child.
 */
export async function GET() {
  const child = await getDemoChild();
  if (!child) return NextResponse.json({ child: null });

  const [memoryRow] = await query<ChildMemory>(
    'SELECT interests, personality_notes, canon, version FROM child_memory WHERE child_id = $1',
    [child.id],
  );

  const mastery = await query<Mastery>(
    'SELECT skill_id, p_mastery, last_practiced FROM skill_mastery WHERE child_id = $1 ORDER BY p_mastery DESC',
    [child.id],
  );

  const notes = await query<ChildNote>(
    `SELECT id, kind, subject, detail, weight, status, ts FROM child_notes
     WHERE child_id = $1 ORDER BY id DESC LIMIT 60`,
    [child.id],
  );

  const sessions = await query<{
    id: string;
    started_at: string;
    ended_at: string | null;
    transcript: TranscriptEntry[];
  }>(
    `SELECT id, started_at, ended_at, transcript FROM sessions
     WHERE child_id = $1 ORDER BY started_at DESC LIMIT 10`,
    [child.id],
  );

  const flags = await query<{ type: string; detail: string; ts: string }>(
    `SELECT type, detail, ts FROM session_flags
     WHERE session_id IN (SELECT id FROM sessions WHERE child_id = $1)
       AND type IN ('sensitive_topic', 'frustration', 'early_exit')
     ORDER BY ts DESC LIMIT 20`,
    [child.id],
  );

  const [snapshot, improved, sticky] = await Promise.all([
    readingSnapshot(child.id),
    improvedWords(child.id, { limit: 8 }),
    stickyWords(child.id),
  ]);

  return NextResponse.json({
    child,
    memory: memoryRow ?? { interests: [], personality_notes: '', canon: {} },
    snapshot,
    improved,
    sticky,
    notes,
    flags,
    skills: mastery.map((m) => ({
      ...m,
      description: SKILL_BY_ID.get(m.skill_id)?.description ?? m.skill_id,
    })),
    // Just the shape of each session, not the whole transcript: the parent view
    // shows what she read and what she talked about, not a recording of her.
    sessions: sessions.map((s) => ({
      id: s.id,
      started_at: s.started_at,
      ended_at: s.ended_at,
      passages: (s.transcript ?? []).filter((e) => e.kind === 'child_passage').length,
      said: (s.transcript ?? []).filter((e) => e.kind === 'child_talk').map((e) => e.text).slice(0, 6),
    })),
  });
}
