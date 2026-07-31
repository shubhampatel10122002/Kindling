import { NextResponse } from 'next/server';
import { one, getDemoChild, createChildWithDefaults } from '@/lib/db';

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

    // A brand-new child needs a cold-start mastery profile and empty memory.
    const created = await createChildWithDefaults({
      name: body.name,
      age: body.age ?? null,
      notes: body.onboarding_notes ?? null,
    });

    return NextResponse.json({ child: created, created: true });
  } catch (err) {
    return NextResponse.json({ error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
