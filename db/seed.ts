import { pool, query, one } from '../lib/db';
import { SKILLS } from '../lib/skills';

/** Seeds the single demo child, a cold-start mastery profile, and empty memory. */
async function main() {
  const name = process.env.SEED_CHILD_NAME || 'Maya';
  const age = Number(process.env.SEED_CHILD_AGE || 5);
  const notes =
    process.env.SEED_CHILD_NOTES ||
    'Loves dragons and building things. Has a cat named Pepper and a big brother, Sam. Gets shy when she makes a mistake.';

  let child = await one<{ id: string }>('SELECT id FROM children WHERE name = $1', [name]);
  if (!child) {
    child = await one<{ id: string }>(
      'INSERT INTO children (name, age, onboarding_notes) VALUES ($1,$2,$3) RETURNING id',
      [name, age, notes],
    );
    console.log(`Created child ${name} (${child!.id})`);
  } else {
    await query('UPDATE children SET age=$2, onboarding_notes=$3 WHERE id=$1', [
      child.id,
      age,
      notes,
    ]);
    console.log(`Child ${name} already exists (${child.id})`);
  }

  const childId = child!.id;

  // Cold-start mastery: everything at the 0.2 prior, a couple of easy wins
  // pre-seeded so pickTargets has prerequisites to work with on day one.
  const warm = new Set(['short_a', 'short_i', 'sight_the', 'sight_and']);
  for (const skill of SKILLS) {
    await query(
      `INSERT INTO skill_mastery (child_id, skill_id, p_mastery, last_practiced)
       VALUES ($1,$2,$3,NULL)
       ON CONFLICT (child_id, skill_id) DO NOTHING`,
      [childId, skill.id, warm.has(skill.id) ? 0.75 : 0.2],
    );
  }
  console.log(`Seeded ${SKILLS.length} skills.`);

  await query(
    `INSERT INTO child_memory (child_id, interests, personality_notes, canon)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (child_id) DO NOTHING`,
    [
      childId,
      JSON.stringify([
        { topic: 'dragons', weight: 1.0, last_seen: new Date().toISOString() },
        { topic: 'building things', weight: 0.8, last_seen: new Date().toISOString() },
        { topic: 'cats', weight: 0.6, last_seen: new Date().toISOString() },
      ]),
      'Enjoys stories with a brave animal friend. Quiet when unsure — responds well to being offered a choice.',
      JSON.stringify({
        characters: ['Blue the dragon'],
        past_summaries: [],
        open_threads: ['Blue lost his bell somewhere in the garden'],
      }),
    ],
  );

  await query(
    `INSERT INTO consolidation_state (child_id, last_event_id) VALUES ($1, 0)
     ON CONFLICT (child_id) DO NOTHING`,
    [childId],
  );

  console.log('Seed complete.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
