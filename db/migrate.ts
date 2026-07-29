import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, query } from '../lib/db';

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const reset = process.argv.includes('--reset');

  if (reset) {
    console.log('Dropping existing tables…');
    await query(`
      DROP TABLE IF EXISTS session_flags, reading_events, next_plans, consolidation_state,
        child_memory_history, child_memory, skill_mastery, sessions, children CASCADE;
    `);
  }

  const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
  await query(sql);
  console.log('Schema applied.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
