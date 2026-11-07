import type { Queryable } from '@flightops/db';
import type { Booking, Passenger } from './people.js';
import type { Aircraft, Airport, Gate, Terminal } from './reference-data.js';
import type { SeededFlight } from './settle.js';

interface Column<T> {
  name: string;
  type: string;
  value: (row: T) => unknown;
}

const BATCH_SIZE = 5_000;

/**
 * Multi-row insert via `unnest`: one round trip and one parse per batch, with a constant
 * number of bind parameters (one array per column) no matter how many rows.
 */
async function bulkInsert<T>(
  db: Queryable,
  table: string,
  columns: Column<T>[],
  rows: readonly T[],
) {
  const names = columns.map((c) => c.name).join(', ');
  const arrays = columns.map((c, i) => `$${i + 1}::${c.type}[]`).join(', ');
  const sql = `INSERT INTO ${table} (${names}) SELECT * FROM unnest(${arrays})`;
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    await db.query(
      sql,
      columns.map((c) => batch.map(c.value)),
    );
  }
}

const col = <T>(name: string, type: string, value: (row: T) => unknown): Column<T> => ({
  name,
  type,
  value,
});

export interface SeedData {
  airports: readonly Airport[];
  terminals: readonly Terminal[];
  gates: readonly Gate[];
  fleet: readonly Aircraft[];
  flights: readonly SeededFlight[];
  passengers: readonly Passenger[];
  bookings: readonly Booking[];
}

export async function truncateSeedTables(db: Queryable): Promise<void> {
  await db.query(`
    TRUNCATE airports.airports, airports.terminals, airports.gates,
             flights.aircraft, flights.flights, flights.outbox_events,
             passengers.passengers, passengers.bookings
    CASCADE`);
}

export async function writeSeedData(db: Queryable, data: SeedData): Promise<void> {
  await bulkInsert(
    db,
    'airports.airports',
    [
      col<Airport>('iata', 'text', (a) => a.iata),
      col<Airport>('icao', 'text', (a) => a.icao),
      col<Airport>('name', 'text', (a) => a.name),
      col<Airport>('city', 'text', (a) => a.city),
      col<Airport>('country_code', 'text', (a) => a.countryCode),
      col<Airport>('timezone', 'text', (a) => a.timezone),
      col<Airport>('latitude', 'float8', (a) => a.latitude),
      col<Airport>('longitude', 'float8', (a) => a.longitude),
    ],
    data.airports,
  );

  await bulkInsert(
    db,
    'airports.terminals',
    [
      col<Terminal>('id', 'uuid', (t) => t.id),
      col<Terminal>('airport_iata', 'text', (t) => t.airportIata),
      col<Terminal>('code', 'text', (t) => t.code),
      col<Terminal>('name', 'text', (t) => t.name),
    ],
    data.terminals,
  );

  await bulkInsert(
    db,
    'airports.gates',
    [
      col<Gate>('id', 'uuid', (g) => g.id),
      col<Gate>('terminal_id', 'uuid', (g) => g.terminalId),
      col<Gate>('airport_iata', 'text', (g) => g.airportIata),
      col<Gate>('code', 'text', (g) => g.code),
    ],
    data.gates,
  );

  await bulkInsert(
    db,
    'flights.aircraft',
    [
      col<Aircraft>('registration', 'text', (a) => a.registration),
      col<Aircraft>('type_code', 'text', (a) => a.typeCode),
      col<Aircraft>('model', 'text', (a) => a.model),
      col<Aircraft>('category', 'text', (a) => a.category),
      col<Aircraft>('seat_count', 'int4', (a) => a.seatCount),
    ],
    data.fleet,
  );

  await bulkInsert(
    db,
    'flights.flights',
    [
      col<SeededFlight>('id', 'uuid', (f) => f.id),
      col<SeededFlight>('flight_number', 'text', (f) => f.flightNumber),
      col<SeededFlight>('service_date', 'date', (f) => f.serviceDate),
      col<SeededFlight>('origin_iata', 'text', (f) => f.originIata),
      col<SeededFlight>('destination_iata', 'text', (f) => f.destinationIata),
      col<SeededFlight>('status', 'text', (f) => f.status),
      col<SeededFlight>('scheduled_departure', 'timestamptz', (f) => f.scheduledDeparture),
      col<SeededFlight>('scheduled_arrival', 'timestamptz', (f) => f.scheduledArrival),
      col<SeededFlight>('estimated_departure', 'timestamptz', (f) => f.estimatedDeparture),
      col<SeededFlight>('estimated_arrival', 'timestamptz', (f) => f.estimatedArrival),
      col<SeededFlight>('actual_departure', 'timestamptz', (f) => f.actualDeparture),
      col<SeededFlight>('actual_arrival', 'timestamptz', (f) => f.actualArrival),
      col<SeededFlight>('departure_gate', 'text', (f) => f.departureGate),
      col<SeededFlight>('aircraft_registration', 'text', (f) => f.aircraftRegistration),
      col<SeededFlight>('delay_minutes', 'int4', (f) => f.delayMinutes),
      col<SeededFlight>('delay_reason', 'text', (f) => f.delayReason),
    ],
    data.flights,
  );

  await bulkInsert(
    db,
    'passengers.passengers',
    [
      col<Passenger>('id', 'uuid', (p) => p.id),
      col<Passenger>('first_name', 'text', (p) => p.firstName),
      col<Passenger>('last_name', 'text', (p) => p.lastName),
      col<Passenger>('email', 'text', (p) => p.email),
      col<Passenger>('phone', 'text', (p) => p.phone),
      col<Passenger>('passport_number', 'text', (p) => p.passportNumber),
      col<Passenger>('nationality', 'text', (p) => p.nationality),
    ],
    data.passengers,
  );

  await bulkInsert(
    db,
    'passengers.bookings',
    [
      col<Booking>('id', 'uuid', (b) => b.id),
      col<Booking>('pnr', 'text', (b) => b.pnr),
      col<Booking>('passenger_id', 'uuid', (b) => b.passengerId),
      col<Booking>('flight_id', 'uuid', (b) => b.flightId),
      col<Booking>('seat', 'text', (b) => b.seat),
      col<Booking>('cabin', 'text', (b) => b.cabin),
      col<Booking>('status', 'text', (b) => b.status),
    ],
    data.bookings,
  );
}
