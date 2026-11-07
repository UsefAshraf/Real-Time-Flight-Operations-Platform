import type { Pool, PoolClient } from '@flightops/db';

const SIMULATOR_LOCK_KEY = 7_465_302_912;

/**
 * Leader election with a Postgres session advisory lock: only one simulator instance drives
 * flights; extra replicas stay on standby and take over when the leader's connection drops.
 */
export class LeaderLock {
  private client: PoolClient | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly key = SIMULATOR_LOCK_KEY,
  ) {}

  get isLeader(): boolean {
    return this.client !== undefined;
  }

  async tryAcquire(): Promise<boolean> {
    if (this.client) return true;
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [this.key],
      );
      if (rows[0]?.locked) {
        client.on('error', () => {
          // Connection lost: Postgres releases the lock with the session; so do we.
          if (this.client === client) this.client = undefined;
          client.release(true);
        });
        this.client = client;
        return true;
      }
    } catch (error) {
      client.release(true);
      throw error;
    }
    client.release();
    return false;
  }

  async release(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.client = undefined;
    await client.query('SELECT pg_advisory_unlock($1)', [this.key]).catch(() => undefined);
    client.release();
  }
}
