import type { Pool, PoolClient } from '@flightops/db';
import { FLIGHT_EVENTS_CHANNEL, FLIGHT_EVENTS_STREAM } from '@flightops/events';
import type { Logger } from '@flightops/logger';
import type { Redis } from 'ioredis';

export interface OutboxRelayOptions {
  pool: Pool;
  redis: Redis;
  logger: Logger;
  batchSize?: number;
  /** Safety-net poll; LISTEN/NOTIFY normally wakes the relay within milliseconds. */
  pollIntervalMs?: number;
  /** Approximate cap on the replay stream length. */
  streamMaxLength?: number;
  /** Published rows older than this are deleted. */
  retentionHours?: number;
  channel?: string;
  stream?: string;
}

export interface RelayStats {
  published: number;
  failures: number;
  lastPublishedAt: string | null;
  listening: boolean;
}

interface OutboxRow {
  id: string;
  payload: unknown;
}

export const OUTBOX_NOTIFY_CHANNEL = 'flights_outbox';

/**
 * Transactional-outbox relay. Delivery is at-least-once: if Redis accepts a batch but the
 * commit marking it published fails, the batch is sent again, so consumers dedupe by event id.
 *
 * `FOR UPDATE SKIP LOCKED` lets several relay instances share the work without double-sending.
 * Strict per-flight ordering across instances is not guaranteed; run one instance (or shard by
 * aggregate id) when ordering matters.
 */
export class OutboxRelay {
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly streamMaxLength: number;
  private readonly retentionHours: number;
  private readonly channel: string;
  private readonly stream: string;

  private listener: PoolClient | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private cleanupTimer: NodeJS.Timeout | undefined;
  private draining: Promise<unknown> | undefined;
  private rerun = false;
  private stopped = false;
  private readonly stats: RelayStats = {
    published: 0,
    failures: 0,
    lastPublishedAt: null,
    listening: false,
  };

  constructor(private readonly options: OutboxRelayOptions) {
    this.batchSize = options.batchSize ?? 200;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.streamMaxLength = options.streamMaxLength ?? 100_000;
    this.retentionHours = options.retentionHours ?? 72;
    this.channel = options.channel ?? FLIGHT_EVENTS_CHANNEL;
    this.stream = options.stream ?? FLIGHT_EVENTS_STREAM;
  }

  getStats(): RelayStats {
    return { ...this.stats };
  }

  async start(): Promise<void> {
    await this.listen();
    this.pollTimer = setInterval(() => {
      this.trigger();
    }, this.pollIntervalMs);
    this.cleanupTimer = setInterval(() => {
      this.cleanup().catch((error: unknown) => {
        this.options.logger.warn({ err: error }, 'outbox cleanup failed');
      });
    }, 3_600_000);
    this.cleanupTimer.unref();
    this.trigger();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearInterval(this.cleanupTimer);
    await this.draining;
    if (this.listener) {
      const listener = this.listener;
      this.listener = undefined;
      await listener.query(`UNLISTEN ${OUTBOX_NOTIFY_CHANNEL}`).catch(() => undefined);
      listener.release();
    }
  }

  /** Request a drain; coalesces concurrent requests into at most one follow-up run. */
  trigger(): void {
    if (this.stopped) return;
    if (this.draining) {
      this.rerun = true;
      return;
    }
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      if (this.rerun) {
        this.rerun = false;
        this.trigger();
      }
    });
  }

  /** Publish until the outbox is empty. Returns the number of events published. */
  async drain(): Promise<number> {
    let total = 0;
    try {
      for (;;) {
        const count = await this.publishBatch();
        total += count;
        if (count < this.batchSize || this.stopped) break;
      }
    } catch (error) {
      this.stats.failures += 1;
      this.options.logger.error({ err: error }, 'outbox publish failed; will retry');
    }
    return total;
  }

  /** Publish one batch inside a transaction. Exposed for tests. */
  async publishBatch(): Promise<number> {
    const client = await this.options.pool.connect();
    let rows: OutboxRow[] = [];
    try {
      await client.query('BEGIN');
      ({ rows } = await client.query<OutboxRow>(
        `SELECT id, payload
           FROM flights.outbox_events
          WHERE published_at IS NULL
          ORDER BY sequence
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      ));
      if (rows.length === 0) {
        await client.query('COMMIT');
        return 0;
      }

      const tx = this.options.redis.multi();
      for (const row of rows) {
        const json = JSON.stringify(row.payload);
        tx.xadd(this.stream, 'MAXLEN', '~', this.streamMaxLength, '*', 'event', json);
        tx.publish(this.channel, json);
      }
      const results = await tx.exec();
      if (!results) throw new Error('Redis transaction was aborted');
      for (const [error] of results) {
        if (error) throw error;
      }

      await client.query(
        `UPDATE flights.outbox_events
            SET published_at = now(), publish_attempts = publish_attempts + 1, last_error = NULL
          WHERE id = ANY($1::uuid[])`,
        [rows.map((row) => row.id)],
      );
      await client.query('COMMIT');

      this.stats.published += rows.length;
      this.stats.lastPublishedAt = new Date().toISOString();
      this.options.logger.debug({ count: rows.length }, 'published outbox batch');
      return rows.length;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      await this.recordFailure(rows, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Delete published events past the retention window. */
  async cleanup(): Promise<number> {
    const result = await this.options.pool.query(
      `DELETE FROM flights.outbox_events
        WHERE published_at IS NOT NULL
          AND published_at < now() - make_interval(hours => $1)`,
      [this.retentionHours],
    );
    return result.rowCount ?? 0;
  }

  private async recordFailure(rows: OutboxRow[], error: unknown): Promise<void> {
    if (rows.length === 0) return;
    const message = error instanceof Error ? error.message : String(error);
    await this.options.pool
      .query(
        `UPDATE flights.outbox_events
            SET publish_attempts = publish_attempts + 1, last_error = $2
          WHERE id = ANY($1::uuid[])`,
        [rows.map((row) => row.id), message.slice(0, 1_000)],
      )
      .catch(() => undefined);
  }

  private async listen(): Promise<void> {
    const client = await this.options.pool.connect();
    client.on('notification', () => {
      this.trigger();
    });
    client.on('error', (error) => {
      this.options.logger.warn({ err: error }, 'outbox LISTEN connection lost; reconnecting');
      this.stats.listening = false;
      if (this.listener === client) this.listener = undefined;
      client.release(error);
      if (!this.stopped) {
        setTimeout(() => {
          this.listen().catch((err: unknown) => {
            this.options.logger.error({ err }, 'outbox LISTEN reconnect failed; polling only');
          });
        }, 1_000);
      }
    });
    await client.query(`LISTEN ${OUTBOX_NOTIFY_CHANNEL}`);
    this.listener = client;
    this.stats.listening = true;
  }
}
