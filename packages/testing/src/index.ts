import { randomUUID } from 'node:crypto';
import { createPool, migrate, type Pool, type Queryable } from '@flightops/db';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';

export const POSTGRES_IMAGE = 'postgres:16-alpine';
export const REDIS_IMAGE = 'redis:7-alpine';

export interface TestPostgres {
  pool: Pool;
  url: string;
  stop: () => Promise<void>;
}

/** Disposable Postgres with every migration applied. */
export async function startPostgres(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
  const pool = createPool({ connectionString: url, max: 10 });
  await migrate(pool);
  return {
    pool,
    url,
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}

export interface TestRedis {
  url: string;
  stop: () => Promise<void>;
}

export async function startRedis(): Promise<TestRedis> {
  const container = await new RedisContainer(REDIS_IMAGE).start();
  return {
    url: container.getConnectionUrl(),
    stop: async () => {
      await container.stop();
    },
  };
}

/** Empty every table that tests write to. */
export async function truncateAll(db: Queryable): Promise<void> {
  await db.query(`
    TRUNCATE flights.outbox_events, flights.flights, flights.aircraft,
             passengers.bookings, passengers.passengers,
             airports.gates, airports.terminals, airports.airports
    CASCADE`);
}

export interface TestFlightInput {
  id?: string;
  flightNumber?: string;
  originIata?: string;
  destinationIata?: string;
  status?: string;
  scheduledDeparture?: Date;
  /** Defaults to 3 hours after departure. */
  scheduledArrival?: Date;
  estimatedDeparture?: Date | null;
  actualDeparture?: Date | null;
  departureGate?: string | null;
}

let flightCounter = 100;

/** Insert one flight row directly (bypassing commands) and return its id. */
export async function insertFlight(db: Queryable, input: TestFlightInput = {}): Promise<string> {
  const id = input.id ?? randomUUID();
  const departure = input.scheduledDeparture ?? new Date(Date.now() + 3 * 3_600_000);
  const arrival = input.scheduledArrival ?? new Date(departure.getTime() + 3 * 3_600_000);
  flightCounter += 1;
  await db.query(
    `INSERT INTO flights.flights
       (id, flight_number, service_date, origin_iata, destination_iata, status,
        scheduled_departure, scheduled_arrival, estimated_departure, actual_departure, departure_gate)
     VALUES ($1, $2, ($3::timestamptz AT TIME ZONE 'UTC')::date, $4, $5, $6, $3, $7, $8, $9, $10)`,
    [
      id,
      input.flightNumber ?? `FO${flightCounter}`,
      departure,
      input.originIata ?? 'CAI',
      input.destinationIata ?? 'LHR',
      input.status ?? 'SCHEDULED',
      arrival,
      input.estimatedDeparture ?? null,
      input.actualDeparture ?? null,
      input.departureGate ?? null,
    ],
  );
  return id;
}

export interface OutboxRow {
  eventType: string;
  payload: { type: string; payload: Record<string, unknown> };
  publishedAt: Date | null;
}

export async function outboxEvents(db: Queryable, flightId?: string): Promise<OutboxRow[]> {
  const { rows } = await db.query<OutboxRow>(
    `SELECT event_type AS "eventType", payload, published_at AS "publishedAt"
       FROM flights.outbox_events
      WHERE $1::uuid IS NULL OR aggregate_id = $1
      ORDER BY sequence`,
    [flightId ?? null],
  );
  return rows;
}
