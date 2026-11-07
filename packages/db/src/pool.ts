import type { Logger } from '@flightops/logger';
import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
/** Anything that can run a query: the pool itself or a client inside a transaction. */
export type Queryable = pg.Pool | pg.PoolClient;

// DATE columns come back as 'YYYY-MM-DD' strings. The default parser builds a Date at *local*
// midnight, which silently shifts the day on non-UTC machines.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);
// COUNT(*) and other int8 values as numbers (our magnitudes are far below 2^53).
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));

export interface CreatePoolOptions {
  connectionString: string;
  max?: number;
  applicationName?: string;
  logger?: Logger;
}

export function createPool({
  connectionString,
  max = 10,
  applicationName,
  logger,
}: CreatePoolOptions): Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    application_name: applicationName,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  // Without a listener, an error on an idle client (e.g. Postgres restart) crashes the process.
  pool.on('error', (error) => {
    logger?.error({ err: error }, 'idle postgres client error');
  });
  return pool;
}

/** Run `fn` inside BEGIN/COMMIT, rolling back on any error. */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true; // connection is unusable; destroy it instead of returning it to the pool
    }
    throw error;
  } finally {
    client.release(broken);
  }
}

export async function checkDatabase(db: Queryable): Promise<void> {
  await db.query('SELECT 1');
}
