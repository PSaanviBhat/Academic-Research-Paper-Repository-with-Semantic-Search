import { Pool, types, type PoolClient } from "pg";

// pg returns BIGINT (e.g. count(*)) as a string because it can exceed
// JavaScript's safe integer range. Our counts are small, so parse them as numbers.
types.setTypeParser(20, (v) => Number(v)); // 20 = int8 / BIGINT
types.setTypeParser(1700, (v) => Number(v)); // 1700 = NUMERIC (round(avg(...), 2))

// One connection pool for the whole server. In development Next.js reloads
// modules on every change, so the pool is kept on globalThis; otherwise each
// reload would open new connections until Postgres runs out.
const globalForPool = globalThis as unknown as { pgPool?: Pool };

export const pool =
  globalForPool.pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
  });

if (process.env.NODE_ENV !== "production") globalForPool.pgPool = pool;

/** Run one parameterised query. Values are sent separately ($1, $2, ...), never pasted into the SQL, so SQL injection is impossible. */
export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

/**
 * Run several statements as ONE transaction on one connection:
 * BEGIN, then fn, then COMMIT; any error triggers ROLLBACK and is re-thrown.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
