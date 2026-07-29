import { NextResponse } from 'next/server';
import { query, one, getDemoChild } from '@/lib/db';
import { describeSkill } from '@/lib/skills';
import type { ChildMemory, Mastery } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** Current child_memory + mastery, for the debug panel. PLAN.md §13. */
export async function GET() {
  try {
    const child = await getDemoChild();
    if (!child) return NextResponse.json({ error: 'No child seeded.' }, { status: 400 });

    const memory =
      (await one<ChildMemory>(
        'SELECT interests, personality_notes, canon, version, updated_at FROM child_memory WHERE child_id = $1',
        [child.id],
      )) ?? { interests: [], personality_notes: '', canon: {}, version: 0 };

    const mastery = await query<Mastery>(
      `SELECT skill_id, p_mastery, last_practiced FROM skill_mastery
       WHERE child_id = $1 ORDER BY p_mastery ASC`,
      [child.id],
    );

    const flags = await query(
      `SELECT f.type, f.detail, f.ts FROM session_flags f
       JOIN sessions s ON s.id = f.session_id
       WHERE s.child_id = $1 AND f.type <> 'interest_signals'
       ORDER BY f.ts DESC LIMIT 25`,
      [child.id],
    );

    const stats = await one<{ sessions: number; events: number }>(
      `SELECT
         (SELECT count(*)::int FROM sessions WHERE child_id = $1) AS sessions,
         (SELECT count(*)::int FROM reading_events WHERE child_id = $1) AS events`,
      [child.id],
    );

    return NextResponse.json({
      child,
      memory,
      mastery: mastery.map((m) => ({ ...m, label: describeSkill(m.skill_id) })),
      flags,
      stats,
    });
  } catch (err) {
    return NextResponse.json({ error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
