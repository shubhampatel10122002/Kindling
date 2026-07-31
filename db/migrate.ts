import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, query, describeTarget, waitForPostgres, EXPECTED_TABLES } from '../lib/db';

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const reset = process.argv.includes('--reset');

  // Say out loud which database we are about to touch. A migration that lands in
  // a different database than the app reads is otherwise invisible — and an
  // exported DATABASE_URL in your shell silently wins over .env.local.
  console.log(`Target: ${describeTarget()}`);

  // `docker compose up -d` returns before Postgres finishes initialising, so a
  // db:reset run immediately after it would otherwise fail on connect.
  await waitForPostgres();

  if (reset) {
    console.log('Dropping existing tables…');
    await query(`
      DROP TABLE IF EXISTS session_flags, reading_events, child_notes, next_plans,
        consolidation_state, child_memory_history, child_memory, skill_mastery,
        sessions, children CASCADE;
    `);
  }

  const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
  await query(sql);

  // Verify rather than assume. A schema that silently half-applied is the exact
  // failure this script exists to prevent.
  const present = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [EXPECTED_TABLES],
  );
  const found = new Set(present.map((r) => r.table_name));
  const missing = EXPECTED_TABLES.filter((t) => !found.has(t));

  if (missing.length > 0) {
    throw new Error(
      `Schema applied but these tables are missing: ${missing.join(', ')}.\n` +
        'The migration did not take. Check the Target line above — is it the database you expect?',
    );
  }

  console.log(`Schema applied. ${found.size}/${EXPECTED_TABLES.length} tables present.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(`\nMigration failed: ${err?.message ?? err}\n`);
  await pool.end().catch(() => {});
  process.exit(1);
});
