import pg from 'pg';
import { env } from './env';

// Postgres returns NUMERIC/BIGINT as strings by default; we want numbers.
pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // int8
pg.types.setTypeParser(1700, (v) => parseFloat(v)); // numeric

declare global {
  // eslint-disable-next-line no-var
  var __primerPool: pg.Pool | undefined;
}

export const pool: pg.Pool =
  globalThis.__primerPool ??
  new pg.Pool({ connectionString: env.databaseUrl, max: 8, idleTimeoutMillis: 30_000 });

if (process.env.NODE_ENV !== 'production') globalThis.__primerPool = pool;

/** Every table db/schema.sql is expected to create. */
export const EXPECTED_TABLES = [
  'children',
  'sessions',
  'reading_events',
  'skill_mastery',
  'child_memory',
  'child_memory_history',
  'session_flags',
  'next_plans',
  'consolidation_state',
] as const;

/** Human-readable connection target with the password stripped. */
export function describeTarget(): string {
  try {
    const u = new URL(env.databaseUrl);
    const db = u.pathname.replace(/^\//, '') || '(default)';
    return `${u.username}@${u.hostname}:${u.port || 5432}/${db}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

const SETUP_HINT =
  'The database is reachable but empty — the schema was never applied to it.\n' +
  '`docker compose up -d` creates the database automatically, which is why the\n' +
  'connection succeeds. Apply the schema with:\n\n' +
  '    npm run db:reset\n';

/**
 * Translate the handful of Postgres failures that actually happen during setup
 * into instructions. "relation \"children\" does not exist" is technically
 * accurate and completely unhelpful when what you need to be told is
 * "run npm run db:reset".
 */
function explain(err: unknown): Error {
  const e = err as { code?: string; message?: string };
  const target = describeTarget();

  switch (e?.code) {
    case '42P01': // undefined_table
      return new Error(`${e.message}\n\n${SETUP_HINT}\nConnected to: ${target}`);
    case '3D000': // invalid_catalog_name
      return new Error(
        `Database does not exist (connected to ${target}).\n\n` +
          'Start Postgres and create it:\n\n    docker compose up -d\n    npm run db:reset\n',
      );
    case '28P01': // invalid_password
      return new Error(
        `Password authentication failed for ${target}.\n` +
          'Check DATABASE_URL in .env.local — note an exported DATABASE_URL in your\n' +
          'shell takes precedence over the file.\n',
      );
    case 'ECONNREFUSED':
      return new Error(
        `Cannot reach Postgres at ${target}.\n\n` +
          'Start it with:\n\n    docker compose up -d\n\n' +
          'If a local Postgres is already using port 5432, stop it or point\n' +
          'DATABASE_URL at that instance instead.\n',
      );
    default:
      return err instanceof Error ? err : new Error(String(err));
  }
}

export async function query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  try {
    const res = await pool.query(text, params as any[]);
    return res.rows as T[];
  } catch (err) {
    throw explain(err);
  }
}

export async function one<T = any>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Block until Postgres accepts connections. `docker compose up -d` returns as
 * soon as the container starts, well before the server is ready, so anything
 * scripted straight after it needs to wait.
 */
export async function waitForPostgres(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  let announced = false;

  while (Date.now() < deadline) {
    try {
      await pool.query('SELECT 1');
      if (announced) console.log('Postgres is ready.');
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as { code?: string })?.code;
      // Only connection-level failures are worth waiting out.
      if (code !== 'ECONNREFUSED' && code !== '57P03' && code !== 'ENOTFOUND') {
        throw explain(err);
      }
      if (!announced) {
        process.stdout.write('Waiting for Postgres to accept connections… ');
        announced = true;
      }
      await new Promise((r) => setTimeout(r, 750));
    }
  }
  throw explain(lastErr);
}

/** True when the schema has been applied. */
export async function schemaIsReady(): Promise<{ ready: boolean; missing: string[] }> {
  const rows = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [EXPECTED_TABLES as unknown as string[]],
  );
  const found = new Set(rows.map((r) => r.table_name));
  const missing = EXPECTED_TABLES.filter((t) => !found.has(t));
  return { ready: missing.length === 0, missing: missing as unknown as string[] };
}

/** The MVP is single-child: return the one seeded demo child. */
export async function getDemoChild() {
  return one<{ id: string; name: string; age: number | null; onboarding_notes: string | null }>(
    'SELECT id, name, age, onboarding_notes FROM children ORDER BY name LIMIT 1',
  );
}
