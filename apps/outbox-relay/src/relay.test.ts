import { FLIGHT_EVENTS_CHANNEL, FLIGHT_EVENTS_STREAM, parseFlightEvent } from '@flightops/events';
import { FlightService } from '@flightops/flights-core';
import { createLogger } from '@flightops/logger';
import {
  insertFlight,
  outboxEvents,
  startPostgres,
  startRedis,
  truncateAll,
  type TestPostgres,
  type TestRedis,
} from '@flightops/testing';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboxRelay } from './relay.js';

const logger = createLogger({ service: 'test', level: 'silent' });
let pg: TestPostgres;
let redisServer: TestRedis;
let redis: Redis;
let subscriber: Redis;
let service: FlightService;
let relay: OutboxRelay;

beforeAll(async () => {
  [pg, redisServer] = await Promise.all([startPostgres(), startRedis()]);
  redis = new Redis(redisServer.url);
  subscriber = new Redis(redisServer.url);
  service = new FlightService(pg.pool);
});

afterAll(async () => {
  await Promise.all([redis.quit(), subscriber.quit()]);
  await Promise.all([pg.stop(), redisServer.stop()]);
});

beforeEach(async () => {
  await truncateAll(pg.pool);
  await redis.del(FLIGHT_EVENTS_STREAM);
  relay = new OutboxRelay({ pool: pg.pool, redis, logger, batchSize: 3, pollIntervalMs: 50 });
});

afterEach(async () => {
  await relay.stop();
});

describe('OutboxRelay', () => {
  it('publishes pending events to the channel and stream, then marks them published', async () => {
    const id = await insertFlight(pg.pool);
    await service.delayFlight(id, { additionalMinutes: 30, reason: 'Weather' });

    const received: unknown[] = [];
    subscriber.on('message', (_channel: string, message: string) =>
      received.push(JSON.parse(message)),
    );
    await subscriber.subscribe(FLIGHT_EVENTS_CHANNEL);

    expect(await relay.drain()).toBe(2);

    await expect.poll(() => received.length).toBe(2);
    expect(received.map((e) => parseFlightEvent(e).type)).toEqual([
      'FlightStatusChanged',
      'FlightDelayed',
    ]);
    expect(await redis.xlen(FLIGHT_EVENTS_STREAM)).toBe(2);
    expect((await outboxEvents(pg.pool, id)).every((e) => e.publishedAt !== null)).toBe(true);
    expect(await relay.drain()).toBe(0);

    await subscriber.unsubscribe(FLIGHT_EVENTS_CHANNEL);
    subscriber.removeAllListeners('message');
  });

  it('drains in batches', async () => {
    for (let i = 0; i < 4; i++) {
      const id = await insertFlight(pg.pool);
      await service.delayFlight(id, { additionalMinutes: 10, reason: 'ATC' }); // 2 events each
    }
    expect(await relay.drain()).toBe(8);
    expect(await redis.xlen(FLIGHT_EVENTS_STREAM)).toBe(8);
  });

  it('wakes up via LISTEN/NOTIFY when new events are committed', async () => {
    await relay.start();
    const id = await insertFlight(pg.pool);
    await service.changeGate(id, 'B04');

    await expect.poll(() => redis.xlen(FLIGHT_EVENTS_STREAM), { timeout: 5_000 }).toBe(1);
    expect(relay.getStats()).toMatchObject({ published: 1, listening: true });
  });

  it('keeps events unpublished and records the error when Redis fails', async () => {
    const id = await insertFlight(pg.pool);
    await service.changeGate(id, 'A01');

    const broken = new Redis(redisServer.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });
    broken.disconnect();
    const failing = new OutboxRelay({ pool: pg.pool, redis: broken, logger });

    await expect(failing.publishBatch()).rejects.toThrow();
    const [row] = await pg.pool
      .query<{ published_at: Date | null; publish_attempts: number; last_error: string }>(
        'SELECT published_at, publish_attempts, last_error FROM flights.outbox_events',
      )
      .then((r) => r.rows);
    expect(row).toMatchObject({ published_at: null, publish_attempts: 1 });
    expect(row?.last_error).toBeTruthy();

    // A healthy relay picks the same event up afterwards.
    expect(await relay.drain()).toBe(1);
  });

  it('deletes published events past retention', async () => {
    const id = await insertFlight(pg.pool);
    await service.changeGate(id, 'A01');
    await relay.drain();
    await pg.pool.query(
      `UPDATE flights.outbox_events SET published_at = now() - interval '100 hours'`,
    );
    expect(await relay.cleanup()).toBe(1);
  });
});
