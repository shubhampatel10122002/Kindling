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

export async function query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params as any[]);
  return res.rows as T[];
}

export async function one<T = any>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** The MVP is single-child: return the one seeded demo child. */
export async function getDemoChild() {
  return one<{ id: string; name: string; age: number | null; onboarding_notes: string | null }>(
    'SELECT id, name, age, onboarding_notes FROM children ORDER BY name LIMIT 1',
  );
}
