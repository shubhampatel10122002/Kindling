import { NextResponse } from 'next/server';
import { getDemoChild, resetChild } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Forget everything about the child and start over.
 *
 * There is nothing to undo afterwards, so the confirmation lives in the UI and
 * the child's name has to be typed to match. This route only checks that the
 * caller meant it.
 */
export async function POST(req: Request) {
  try {
    const child = await getDemoChild();
    if (!child) {
      // Already nothing to forget. The next session onboards either way, so
      // this is a success, not an error.
      return NextResponse.json({ ok: true, alreadyEmpty: true });
    }

    const body = (await req.json().catch(() => ({}))) as { confirmName?: string };
    if ((body.confirmName ?? '').trim().toLowerCase() !== child.name.trim().toLowerCase()) {
      return NextResponse.json(
        { error: `To erase this profile, confirm with the child's name: ${child.name}` },
        { status: 400 },
      );
    }

    const deleted = await resetChild(child.id);
    console.log(`[reset] erased ${child.name} (${child.id})`, deleted);

    return NextResponse.json({ ok: true, name: child.name, deleted });
  } catch (err) {
    console.error('[reset] failed', err);
    return NextResponse.json({ error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
