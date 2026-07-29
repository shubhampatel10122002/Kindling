import { NextResponse } from 'next/server';
import { query, one, getDemoChild } from '@/lib/db';
import { updateMastery, pickTargets, decayInterests, type ReadingEventRow } from '@/lib/pedagogy';
import { consolidateMemory, diffMemory } from '@/lib/llm/consolidate';
import { generateSessionPlan, fallbackPlan } from '@/lib/llm/planner';
import type { ChildMemory, Mastery, TranscriptEntry } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** PLAN.md §12. The button. Runs in order; returns a memory diff for the debug panel. */
export async function POST() {
  try {
    const child = await getDemoChild();
    if (!child) {
      return NextResponse.json({ error: 'No child seeded. Run npm run db:reset.' }, { status: 400 });
    }

    // ---- 1. Archive current memory ----------------------------------------
    const currentRow = await one<ChildMemory>(
      'SELECT interests, personality_notes, canon, version FROM child_memory WHERE child_id = $1',
      [child.id],
    );
    const before: ChildMemory = currentRow ?? {
      interests: [],
      personality_notes: '',
      canon: {},
      version: 0,
    };

    if (currentRow) {
      await query(
        `INSERT INTO child_memory_history (child_id, interests, personality_notes, canon, updated_at, version)
         SELECT child_id, interests, personality_notes, canon, updated_at, version
         FROM child_memory WHERE child_id = $1`,
        [child.id],
      );
    }

    // ---- 2. Fold new reading_events into mastery --------------------------
    const state = await one<{ last_event_id: number }>(
      'SELECT last_event_id FROM consolidation_state WHERE child_id = $1',
      [child.id],
    );
    const watermark = state?.last_event_id ?? 0;

    const events = await query<ReadingEventRow & { id: number }>(
      `SELECT id, expected_word, attempt, error_type, accuracy_score
       FROM reading_events WHERE child_id = $1 AND id > $2 ORDER BY id`,
      [child.id, watermark],
    );

    const priorMastery = await query<Mastery>(
      'SELECT skill_id, p_mastery, last_practiced FROM skill_mastery WHERE child_id = $1',
      [child.id],
    );

    const updates = updateMastery(events, priorMastery);
    for (const u of updates) {
      await query(
        `INSERT INTO skill_mastery (child_id, skill_id, p_mastery, last_practiced, updated_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (child_id, skill_id)
         DO UPDATE SET p_mastery = EXCLUDED.p_mastery,
                       last_practiced = EXCLUDED.last_practiced,
                       updated_at = now()`,
        [child.id, u.skill_id, u.p_mastery, u.last_practiced],
      );
    }

    const newWatermark = events.length ? events[events.length - 1].id : watermark;
    await query(
      `INSERT INTO consolidation_state (child_id, last_event_id, last_run_at)
       VALUES ($1,$2,now())
       ON CONFLICT (child_id) DO UPDATE SET last_event_id = $2, last_run_at = now()`,
      [child.id, newWatermark],
    );

    // ---- 3. Sonnet updates the memory model -------------------------------
    const sessions = await query<{ transcript: TranscriptEntry[] }>(
      `SELECT transcript FROM sessions
       WHERE child_id = $1 AND ended_at IS NOT NULL
       ORDER BY started_at DESC LIMIT 1`,
      [child.id],
    );
    const transcript = sessions[0]?.transcript ?? [];

    const signalRows = await query<{ detail: string }>(
      `SELECT detail FROM session_flags
       WHERE type = 'interest_signals'
         AND session_id IN (SELECT id FROM sessions WHERE child_id = $1
                            ORDER BY started_at DESC LIMIT 1)`,
      [child.id],
    );
    const interestSignals = signalRows.flatMap((r) => r.detail.split(',').map((s) => s.trim()));

    // Decay before the model sees them; the prompt tells it this already happened.
    const decayed: ChildMemory = { ...before, interests: decayInterests(before.interests ?? []) };

    let after: ChildMemory;
    try {
      after = await consolidateMemory({
        child,
        current: decayed,
        transcript,
        interestSignals,
      });
    } catch (err) {
      console.error('[consolidate] LLM step failed, keeping decayed memory', err);
      after = decayed;
    }

    // ---- 4. Write updated memory, bump version ----------------------------
    const nextVersion = (before.version ?? 0) + 1;
    await query(
      `INSERT INTO child_memory (child_id, interests, personality_notes, canon, updated_at, version)
       VALUES ($1,$2,$3,$4,now(),$5)
       ON CONFLICT (child_id) DO UPDATE
         SET interests = EXCLUDED.interests,
             personality_notes = EXCLUDED.personality_notes,
             canon = EXCLUDED.canon,
             updated_at = now(),
             version = EXCLUDED.version`,
      [
        child.id,
        JSON.stringify(after.interests ?? []),
        after.personality_notes ?? '',
        JSON.stringify(after.canon ?? {}),
        nextVersion,
      ],
    );

    // ---- 5. Pick next targets and pre-generate the next session plan -------
    const mastery = await query<Mastery>(
      'SELECT skill_id, p_mastery, last_practiced FROM skill_mastery WHERE child_id = $1',
      [child.id],
    );
    const targets = pickTargets(mastery);

    let nextPlan;
    try {
      nextPlan = await generateSessionPlan({ child, memory: after, mastery, targetSkills: targets });
    } catch (err) {
      console.error('[consolidate] planner failed, using fallback', err);
      nextPlan = fallbackPlan(child, targets);
    }

    await query(
      `INSERT INTO next_plans (child_id, plan, created_at) VALUES ($1,$2,now())
       ON CONFLICT (child_id) DO UPDATE SET plan = EXCLUDED.plan, created_at = now()`,
      [child.id, JSON.stringify(nextPlan)],
    );

    // ---- 6. Return the diff — the demo centrepiece ------------------------
    return NextResponse.json({
      ok: true,
      eventsProcessed: events.length,
      masteryUpdated: updates.map((u) => ({
        skill_id: u.skill_id,
        p_mastery: Number(u.p_mastery.toFixed(3)),
      })),
      targets,
      diff: diffMemory(before, after),
      before,
      after: { ...after, version: nextVersion },
      nextPlan,
    });
  } catch (err) {
    console.error('[consolidate] failed', err);
    return NextResponse.json({ error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
