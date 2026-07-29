import { NextResponse } from 'next/server';
import { query, one, getDemoChild } from '@/lib/db';
import { SKILLS } from '@/lib/skills';

export const dynamic = 'force-dynamic';

export async function GET() {
  const child = await getDemoChild();
  return NextResponse.json({ child });
}

/** Create or edit the demo child + onboarding notes. PLAN.md §13. */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      name?: string;
      age?: number;
      onboarding_notes?: string;
    };

    const existing = await getDemoChild();

    if (existing) {
      const updated = await one(
        `UPDATE children SET
           name = COALESCE($2, name),
           age = COALESCE($3, age),
           onboarding_notes = COALESCE($4, onboarding_notes)
         WHERE id = $1
         RETURNING id, name, age, onboarding_notes`,
        [existing.id, body.name ?? null, body.age ?? null, body.onboarding_notes ?? null],
      );
      return NextResponse.json({ child: updated, created: false });
    }

    if (!body.name) {
      return NextResponse.json({ error: 'name is required to create a child' }, { status: 400 });
    }

    const created = await one<{ id: string }>(
      'INSERT INTO children (name, age, onboarding_notes) VALUES ($1,$2,$3) RETURNING id, name, age, onboarding_notes',
      [body.name, body.age ?? null, body.onboarding_notes ?? null],
    );

    // A brand-new child needs a cold-start mastery profile and empty memory.
    for (const skill of SKILLS) {
      await query(
        `INSERT INTO skill_mastery (child_id, skill_id, p_mastery)
         VALUES ($1,$2,0.2) ON CONFLICT DO NOTHING`,
        [created!.id, skill.id],
      );
    }
    await query(
      `INSERT INTO child_memory (child_id, interests, personality_notes, canon)
       VALUES ($1,'[]','', '{}') ON CONFLICT DO NOTHING`,
      [created!.id],
    );
    await query(
      `INSERT INTO consolidation_state (child_id, last_event_id) VALUES ($1,0)
       ON CONFLICT DO NOTHING`,
      [created!.id],
    );

    return NextResponse.json({ child: created, created: true });
  } catch (err) {
    return NextResponse.json({ error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
