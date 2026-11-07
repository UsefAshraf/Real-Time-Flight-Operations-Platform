import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MigrationError,
  dropAllSchemas,
  loadMigrations,
  migrate,
  migrationStatus,
} from './migrator.js';
import { createPool, withTransaction, type Pool } from './pool.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = createPool({ connectionString: container.getConnectionUri(), max: 5 });
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await dropAllSchemas(pool);
});

describe('migrate', () => {
  it('applies every bundled migration and creates all schemas', async () => {
    const result = await migrate(pool);
    expect(result.applied).toEqual((await loadMigrations()).map((m) => m.id));

    const { rows } = await pool.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace WHERE nspname = ANY($1) ORDER BY nspname`,
      [['airports', 'flights', 'passengers', 'notifications']],
    );
    expect(rows.map((r) => r.nspname)).toEqual([
      'airports',
      'flights',
      'notifications',
      'passengers',
    ]);
  });

  it('is idempotent', async () => {
    await migrate(pool);
    const second = await migrate(pool);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toBeGreaterThan(0);
  });

  it('is safe to run concurrently', async () => {
    const results = await Promise.all([migrate(pool), migrate(pool), migrate(pool)]);
    const totalApplied = results.reduce((sum, r) => sum + r.applied.length, 0);
    expect(totalApplied).toBe((await loadMigrations()).length);
  });

  it('reports status', async () => {
    await migrate(pool);
    const status = await migrationStatus(pool);
    expect(status.every((m) => m.applied)).toBe(true);
  });

  describe('with custom migrations', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'migrations-'));
      return () => rm(dir, { recursive: true, force: true });
    });

    it('rolls back a failing migration and keeps earlier ones', async () => {
      await writeFile(join(dir, '0001_ok.sql'), 'CREATE TABLE public.ok_table (id int);');
      await writeFile(
        join(dir, '0002_broken.sql'),
        'CREATE TABLE public.half (id int); SELECT nope;',
      );

      await expect(migrate(pool, { dir })).rejects.toThrow(MigrationError);

      const { rows } = await pool.query<{ name: string | null }>(
        `SELECT to_regclass('public.ok_table')::text AS name
         UNION ALL SELECT to_regclass('public.half')::text`,
      );
      expect(rows.map((r) => r.name)).toEqual(['ok_table', null]);
      await pool.query('DROP TABLE public.ok_table');
    });

    it('refuses to run when an applied migration was edited', async () => {
      await writeFile(join(dir, '0001_t.sql'), 'CREATE TABLE public.edited (id int);');
      await migrate(pool, { dir });
      await writeFile(join(dir, '0001_t.sql'), 'CREATE TABLE public.edited (id bigint);');

      await expect(migrate(pool, { dir })).rejects.toThrow(/was modified/);
      await pool.query('DROP TABLE public.edited');
    });
  });
});

describe('withTransaction', () => {
  it('commits on success and rolls back on error', async () => {
    await pool.query('CREATE TABLE IF NOT EXISTS public.tx_test (v int)');
    await pool.query('TRUNCATE public.tx_test');

    await withTransaction(pool, (tx) => tx.query('INSERT INTO public.tx_test VALUES (1)'));
    await expect(
      withTransaction(pool, async (tx) => {
        await tx.query('INSERT INTO public.tx_test VALUES (2)');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const { rows } = await pool.query<{ v: number }>('SELECT v FROM public.tx_test');
    expect(rows).toEqual([{ v: 1 }]);
    await pool.query('DROP TABLE public.tx_test');
  });
});
