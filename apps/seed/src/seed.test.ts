import { startPostgres, type TestPostgres } from '@flightops/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SeedRefusedError, seedDatabase, type SeedOptions } from './seed.js';

let pg: TestPostgres;

beforeAll(async () => {
  pg = await startPostgres();
});

afterAll(async () => {
  await pg.stop();
});

const options: SeedOptions = {
  randomSeed: 42,
  startDate: '2026-11-06',
  days: 2,
  flightsPerDay: 200,
  passengers: 1_000,
  bookingsPerFlight: { min: 5, max: 15 },
  now: new Date('2026-11-07T12:00:00Z'),
  reset: false,
};

describe('seedDatabase', () => {
  it('writes a consistent dataset that satisfies every constraint', async () => {
    const summary = await seedDatabase(pg.pool, options);

    const { rows } = await pg.pool.query<Record<string, number>>(`
      SELECT (SELECT count(*) FROM airports.airports)     AS airports,
             (SELECT count(*) FROM airports.gates)        AS gates,
             (SELECT count(*) FROM flights.aircraft)      AS aircraft,
             (SELECT count(*) FROM flights.flights)       AS flights,
             (SELECT count(*) FROM passengers.passengers) AS passengers,
             (SELECT count(*) FROM passengers.bookings)   AS bookings`);
    expect(rows[0]).toEqual({
      airports: summary.airports,
      gates: summary.gates,
      aircraft: summary.aircraft,
      flights: 400,
      passengers: 1_000,
      bookings: summary.bookings,
    });
    expect(summary.flightsByStatus.ARRIVED).toBeGreaterThan(0);
  });

  it('only references airports and flights that exist', async () => {
    const { rows } = await pg.pool.query<{ orphans: number }>(`
      SELECT (SELECT count(*) FROM flights.flights f
               WHERE NOT EXISTS (SELECT 1 FROM airports.airports a WHERE a.iata = f.origin_iata)
                  OR NOT EXISTS (SELECT 1 FROM airports.airports a WHERE a.iata = f.destination_iata))
           + (SELECT count(*) FROM passengers.bookings b
               WHERE NOT EXISTS (SELECT 1 FROM flights.flights f WHERE f.id = b.flight_id))
           + (SELECT count(*) FROM flights.flights f
               WHERE departure_gate IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM airports.gates g
                  WHERE g.airport_iata = f.origin_iata AND g.code = f.departure_gate)) AS orphans`);
    expect(rows[0]?.orphans).toBe(0);
  });

  it('refuses to seed twice without reset, and replaces data with reset', async () => {
    await expect(seedDatabase(pg.pool, options)).rejects.toThrow(SeedRefusedError);
    const summary = await seedDatabase(pg.pool, { ...options, reset: true, flightsPerDay: 100 });
    expect(summary.flights).toBe(200);
    const { rows } = await pg.pool.query<{ count: number }>(
      'SELECT count(*) AS count FROM flights.flights',
    );
    expect(rows[0]?.count).toBe(200);
  });
});
