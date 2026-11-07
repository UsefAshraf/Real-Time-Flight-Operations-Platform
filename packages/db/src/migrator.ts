import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './pool.js';

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

/** Schemas owned by the platform, one per bounded context. */
export const APP_SCHEMAS = ['airports', 'flights', 'passengers', 'notifications'] as const;

/** Arbitrary constant: only one migrator may run at a time, across all processes. */
const MIGRATION_LOCK_KEY = 7_465_302_911;
const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

export interface Migration {
  id: string;
  sql: string;
  checksum: string;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: number;
}

export interface MigrationStatus {
  id: string;
  applied: boolean;
  appliedAt: Date | null;
}

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

export async function loadMigrations(dir = DEFAULT_MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((file) => FILE_PATTERN.test(file)).sort();
  return Promise.all(
    files.map(async (file) => {
      const sql = await readFile(join(dir, file), 'utf8');
      return { id: file.replace(/\.sql$/, ''), sql, checksum: checksum(sql) };
    }),
  );
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS public.schema_migrations (
    id text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;

/**
 * Apply pending migrations in order. Each migration runs in its own transaction; a session
 * advisory lock makes concurrent runs (e.g. several pods starting at once) safe.
 * Applied migrations are immutable: editing one is reported instead of silently ignored.
 */
export async function migrate(
  pool: Pool,
  options: { dir?: string; migrations?: Migration[] } = {},
): Promise<MigrateResult> {
  const migrations = options.migrations ?? (await loadMigrations(options.dir));
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(CREATE_TABLE);
    const { rows } = await client.query<{ id: string; checksum: string }>(
      'SELECT id, checksum FROM public.schema_migrations',
    );
    const done = new Map(rows.map((row) => [row.id, row.checksum]));

    for (const migration of migrations) {
      const appliedChecksum = done.get(migration.id);
      if (appliedChecksum !== undefined && appliedChecksum !== migration.checksum) {
        throw new MigrationError(
          `Migration ${migration.id} was modified after it was applied. ` +
            'Add a new migration instead of editing an applied one.',
        );
      }
    }

    const applied: string[] = [];
    for (const migration of migrations) {
      if (done.has(migration.id)) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO public.schema_migrations (id, checksum) VALUES ($1, $2)', [
          migration.id,
          migration.checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        const reason = error instanceof Error ? error.message : String(error);
        throw new MigrationError(`Migration ${migration.id} failed: ${reason}`, { cause: error });
      }
      applied.push(migration.id);
    }
    return { applied, alreadyApplied: done.size };
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    client.release();
  }
}

export async function migrationStatus(
  pool: Pool,
  options: { dir?: string } = {},
): Promise<MigrationStatus[]> {
  const migrations = await loadMigrations(options.dir);
  await pool.query(CREATE_TABLE);
  const { rows } = await pool.query<{ id: string; applied_at: Date }>(
    'SELECT id, applied_at FROM public.schema_migrations',
  );
  const applied = new Map(rows.map((row) => [row.id, row.applied_at]));
  return migrations.map((m) => ({
    id: m.id,
    applied: applied.has(m.id),
    appliedAt: applied.get(m.id) ?? null,
  }));
}

/** Development only: drop every platform schema and the migration history. */
export async function dropAllSchemas(pool: Pool): Promise<void> {
  const schemas = APP_SCHEMAS.join(', ');
  await pool.query(`DROP SCHEMA IF EXISTS ${schemas} CASCADE`);
  await pool.query('DROP TABLE IF EXISTS public.schema_migrations');
}
