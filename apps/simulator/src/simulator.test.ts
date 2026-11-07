import { FlightService, createRng, type FlightRecord } from '@flightops/flights-core';
import { createLogger } from '@flightops/logger';
import {
  insertFlight,
  outboxEvents,
  startPostgres,
  truncateAll,
  type TestPostgres,
} from '@flightops/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SimClock } from './clock.js';
import { LeaderLock } from './leader.js';
import { DEFAULT_RATES, FlightSimulator, type DisruptionRates } from './simulator.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const HOUR = 3_600_000;
const MINUTE = 60_000;
const NO_DISRUPTIONS: DisruptionRates = {
  delaysPerMinute: 0,
  gateChangesPerMinute: 0,
  cancellationsPerMinute: 0,
  diversionsPerMinute: 0,
};

let pg: TestPostgres;
let now: Date;

beforeAll(async () => {
  pg = await startPostgres();
});

afterAll(async () => {
  await pg.stop();
});

beforeEach(async () => {
  await truncateAll(pg.pool);
  now = new Date('2026-11-06T12:00:00Z');
  await pg.pool.query(`
    INSERT INTO airports.airports (iata, icao, name, city, country_code, timezone, latitude, longitude)
    VALUES ('CAI', 'HECA', 'Cairo International', 'Cairo', 'EG', 'Africa/Cairo', 30.12, 31.41),
           ('LHR', 'EGLL', 'Heathrow', 'London', 'GB', 'Europe/London', 51.47, -0.45),
           ('AMS', 'EHAM', 'Schiphol', 'Amsterdam', 'NL', 'Europe/Amsterdam', 52.31, 4.77)`);
  await pg.pool.query(`
    WITH t AS (
      INSERT INTO airports.terminals (airport_iata, code, name)
      VALUES ('CAI', 'T3', 'Terminal 3'), ('LHR', 'T5', 'Terminal 5'), ('AMS', 'T1', 'Terminal 1')
      RETURNING id, airport_iata
    )
    INSERT INTO airports.gates (terminal_id, airport_iata, code)
    SELECT t.id, t.airport_iata, g.code FROM t CROSS JOIN (VALUES ('A1'), ('A2'), ('A3')) AS g(code)`);
});

function createSimulator(rates: DisruptionRates = NO_DISRUPTIONS, seed = 1) {
  const clock = () => now;
  const flights = new FlightService(pg.pool, { clock });
  return new FlightSimulator({
    pool: pg.pool,
    flights,
    logger,
    rng: createRng(seed),
    now: clock,
    rates,
  });
}

async function getFlight(id: string): Promise<FlightRecord> {
  return (await new FlightService(pg.pool).getFlight(id)) as FlightRecord;
}

describe('FlightSimulator', () => {
  it('starts boarding and assigns a gate when due', async () => {
    const id = await insertFlight(pg.pool, {
      scheduledDeparture: new Date(now.getTime() + 30 * MINUTE),
    });
    const simulator = createSimulator();
    await simulator.loadGates();

    const result = await simulator.tick();

    expect(result).toMatchObject({ transitions: 1, gateAssignments: 1 });
    const flight = await getFlight(id);
    expect(flight.status).toBe('BOARDING');
    expect(['A1', 'A2', 'A3']).toContain(flight.departureGate);
    expect((await outboxEvents(pg.pool, id)).map((e) => e.eventType).sort()).toEqual([
      'FlightGateChanged',
      'FlightStatusChanged',
    ]);
  });

  it('leaves future flights alone', async () => {
    const id = await insertFlight(pg.pool, {
      scheduledDeparture: new Date(now.getTime() + 5 * HOUR),
    });
    const simulator = createSimulator();
    await simulator.loadGates();
    expect(await simulator.tick()).toMatchObject({ transitions: 0, gateAssignments: 0 });
    expect((await getFlight(id)).status).toBe('SCHEDULED');
  });

  it('catches up a stale flight through every step with historical timestamps', async () => {
    const departure = new Date(now.getTime() - 10 * HOUR);
    const id = await insertFlight(pg.pool, {
      scheduledDeparture: departure,
      scheduledArrival: new Date(departure.getTime() + 4 * HOUR),
    });
    const simulator = createSimulator();

    expect((await simulator.tick()).transitions).toBe(5);
    const flight = await getFlight(id);
    expect(flight).toMatchObject({ status: 'ARRIVED', actualDeparture: departure });
    const statuses = (await outboxEvents(pg.pool, id)).map((e) => e.payload.payload.to);
    expect(statuses).toEqual(['BOARDING', 'DEPARTED', 'AIRBORNE', 'LANDED', 'ARRIVED']);
  });

  it('progresses an in-flight aircraft as time passes', async () => {
    const departure = new Date(now.getTime() - 20 * MINUTE);
    const id = await insertFlight(pg.pool, {
      status: 'BOARDING',
      scheduledDeparture: departure,
      scheduledArrival: new Date(departure.getTime() + 2 * HOUR),
    });
    const simulator = createSimulator();

    await simulator.tick();
    expect((await getFlight(id)).status).toBe('AIRBORNE');

    now = new Date(now.getTime() + 2 * HOUR);
    await simulator.tick();
    expect((await getFlight(id)).status).toBe('ARRIVED');
  });

  it('injects disruptions according to the rates', async () => {
    const ids = await Promise.all(
      [10, 30, 50].map((m) =>
        insertFlight(pg.pool, {
          scheduledDeparture: new Date(now.getTime() + m * MINUTE + 2 * HOUR),
          departureGate: 'A1',
        }),
      ),
    );
    const simulator = createSimulator({ ...NO_DISRUPTIONS, delaysPerMinute: 100 });
    await simulator.loadGates();
    await simulator.tick(); // first tick establishes the time base

    now = new Date(now.getTime() + MINUTE);
    const result = await simulator.tick();

    expect(result.delays).toBe(3);
    for (const id of ids) {
      expect((await getFlight(id)).status).toBe('DELAYED');
    }
  });

  it('accumulates stats', async () => {
    const simulator = createSimulator(DEFAULT_RATES);
    await simulator.tick();
    simulator.recordSkippedTick();
    expect(simulator.getStats()).toMatchObject({
      ticks: 1,
      skipped: 1,
      simTime: now.toISOString(),
    });
  });
});

describe('LeaderLock', () => {
  it('lets exactly one instance lead and hands over on release', async () => {
    const a = new LeaderLock(pg.pool, 42);
    const b = new LeaderLock(pg.pool, 42);

    expect(await a.tryAcquire()).toBe(true);
    expect(await b.tryAcquire()).toBe(false);

    await a.release();
    expect(await b.tryAcquire()).toBe(true);
    await b.release();
  });
});

describe('SimClock', () => {
  it('runs at the configured speed', () => {
    let real = 1_000;
    const clock = new SimClock(60, new Date('2026-11-06T00:00:00Z'), () => real);
    real += 1_000; // one real second
    expect(clock.now().toISOString()).toBe('2026-11-06T00:01:00.000Z');
  });

  it('rejects a non-positive speed', () => {
    expect(() => new SimClock(0)).toThrow(RangeError);
  });
});
