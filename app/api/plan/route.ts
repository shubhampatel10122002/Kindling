import { NextResponse } from 'next/server';
import { one, query, getDemoChild } from '@/lib/db';
import { pickTargets } from '@/lib/pedagogy';
import { describeSkill } from '@/lib/skills';
import type { Mastery, SessionPlan } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** The plan the next session will run. PLAN.md §13. */
export async function GET() {
  try {
    const child = await getDemoChild();
    if (!child) return NextResponse.json({ error: 'No child seeded.' }, { status: 400 });

    const stored = await one<{ plan: SessionPlan; created_at: string }>(
      'SELECT plan, created_at FROM next_plans WHERE child_id = $1',
      [child.id],
    );

    const mastery = await query<Mastery>(
      'SELECT skill_id, p_mastery, last_practiced FROM skill_mastery WHERE child_id = $1',
      [child.id],
    );
    const targets = pickTargets(mastery);

    return NextResponse.json({
      plan: stored?.plan ?? null,
      createdAt: stored?.created_at ?? null,
      targets: targets.map((id) => ({ id, label: describeSkill(id) })),
      source: stored ? 'consolidation' : 'not yet generated — will be planned at session start',
    });
  } catch (err) {
    return NextResponse.json({ error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
