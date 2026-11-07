import { withTransaction, type Pool } from '@flightops/db';
import { createRng } from '@flightops/flights-core';
import { generateBookings, generatePassengers } from './people.js';
import { generateFleet, generateTerminalsAndGates, loadAirports } from './reference-data.js';
import { generateSchedule } from './schedule.js';
import { settleFlights } from './settle.js';
import { truncateSeedTables, writeSeedData } from './writer.js';

export interface SeedOptions {
  randomSeed: number;
  /** First UTC service day, 'YYYY-MM-DD'. */
  startDate: string;
  days: number;
  flightsPerDay: number;
  passengers: number;
  bookingsPerFlight: { min: number; max: number };
  /** Flights are settled into the state they would be in at this moment. */
  now: Date;
  /** Wipe existing data first. Without it, seeding a non-empty database is refused. */
  reset: boolean;
}

export interface SeedSummary {
  airports: number;
  terminals: number;
  gates: number;
  aircraft: number;
  flights: number;
  passengers: number;
  bookings: number;
  flightsByStatus: Record<string, number>;
}

export class SeedRefusedError extends Error {
  override readonly name = 'SeedRefusedError';
}

export async function seedDatabase(pool: Pool, options: SeedOptions): Promise<SeedSummary> {
  const rng = createRng(options.randomSeed);

  const airports = await loadAirports();
  const { terminals, gates } = generateTerminalsAndGates(airports, rng);
  const fleet = generateFleet();
  const schedule = generateSchedule({
    airports,
    fleet,
    startDate: options.startDate,
    days: options.days,
    flightsPerDay: options.flightsPerDay,
    rng,
  });

  const gatesByAirport = new Map<string, string[]>();
  for (const gate of gates) {
    gatesByAirport.set(gate.airportIata, [
      ...(gatesByAirport.get(gate.airportIata) ?? []),
      gate.code,
    ]);
  }
  const flights = settleFlights(schedule, { now: options.now, rng, gatesByAirport });
  const passengers = generatePassengers(options.passengers, rng);
  const bookings = generateBookings({
    flights,
    aircraft: fleet,
    passengerIds: passengers.map((p) => p.id),
    minPerFlight: options.bookingsPerFlight.min,
    maxPerFlight: options.bookingsPerFlight.max,
    rng,
  });

  await withTransaction(pool, async (tx) => {
    if (options.reset) {
      await truncateSeedTables(tx);
    } else {
      const { rows } = await tx.query<{ count: number }>(
        'SELECT count(*) AS count FROM flights.flights',
      );
      if ((rows[0]?.count ?? 0) > 0) {
        throw new SeedRefusedError(
          'Database already has flights. Re-run with --reset to replace them.',
        );
      }
    }
    await writeSeedData(tx, { airports, terminals, gates, fleet, flights, passengers, bookings });
  });

  const flightsByStatus: Record<string, number> = {};
  for (const f of flights) flightsByStatus[f.status] = (flightsByStatus[f.status] ?? 0) + 1;

  return {
    airports: airports.length,
    terminals: terminals.length,
    gates: gates.length,
    aircraft: fleet.length,
    flights: flights.length,
    passengers: passengers.length,
    bookings: bookings.length,
    flightsByStatus,
  };
}
