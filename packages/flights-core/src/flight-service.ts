import { withTransaction, type Pool, type PoolClient, type Queryable } from '@flightops/db';
import { hasDeparted, transitionFlight, type FlightStatus } from '@flightops/domain';
import { createFlightEvent, type FlightEvent } from '@flightops/events';
import {
  CHANGE_COLUMNS,
  FLIGHT_COLUMNS,
  type FlightChanges,
  type FlightRecord,
} from './flight-record.js';
import {
  DEFAULT_TIMINGS,
  addMinutes,
  delayedEstimates,
  expectedArrival,
  transitionChanges,
  type LifecycleTimings,
} from './lifecycle.js';

export class FlightNotFoundError extends Error {
  override readonly name = 'FlightNotFoundError';

  constructor(readonly flightId: string) {
    super(`Flight ${flightId} not found`);
  }
}

/** The command is valid in general but not for this flight right now (e.g. gate change after pushback). */
export class FlightCommandRejectedError extends Error {
  override readonly name = 'FlightCommandRejectedError';

  constructor(
    readonly flightId: string,
    reason: string,
  ) {
    super(`Flight ${flightId}: ${reason}`);
  }
}

/** Statuses with their own command because they need extra data (minutes, reason, airport). */
const DEDICATED_COMMANDS: ReadonlySet<FlightStatus> = new Set(['DELAYED', 'CANCELLED', 'DIVERTED']);
const DELAYABLE: ReadonlySet<FlightStatus> = new Set(['SCHEDULED', 'DELAYED', 'BOARDING']);

interface Mutation {
  changes: FlightChanges;
  events: FlightEvent[];
}

export interface FlightServiceOptions {
  clock?: () => Date;
  timings?: LifecycleTimings;
}

function context(flight: FlightRecord) {
  return {
    flightNumber: flight.flightNumber,
    originIata: flight.originIata,
    destinationIata: flight.destinationIata,
  };
}

/**
 * Every state change goes through here: the row is locked, rules are checked against the
 * *current* state, and the update plus its domain events are committed atomically. Events are
 * never published directly; the outbox relay does that after commit.
 */
export class FlightService {
  private readonly clock: () => Date;
  private readonly timings: LifecycleTimings;

  constructor(
    private readonly pool: Pool,
    options: FlightServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.timings = options.timings ?? DEFAULT_TIMINGS;
  }

  async getFlight(flightId: string, db: Queryable = this.pool): Promise<FlightRecord | null> {
    const { rows } = await db.query<FlightRecord>(
      `SELECT ${FLIGHT_COLUMNS} FROM flights.flights WHERE id = $1`,
      [flightId],
    );
    return rows[0] ?? null;
  }

  /** Normal lifecycle progression (BOARDING, DEPARTED, AIRBORNE, LANDED, ARRIVED). */
  transitionStatus(flightId: string, to: FlightStatus, options: { at?: Date } = {}) {
    if (DEDICATED_COMMANDS.has(to)) {
      throw new TypeError(`Use the dedicated command to move a flight to ${to}`);
    }
    return this.mutate(flightId, (flight, now) => {
      transitionFlight(flight.status, to);
      const at = options.at ?? now;
      return {
        changes: transitionChanges(flight, to, at),
        events: [this.statusChanged(flight, to, at)],
      };
    });
  }

  /**
   * Add `additionalMinutes` to the flight's delay. A first delay moves the flight to DELAYED;
   * delaying an already-delayed flight only revises the estimates (no state transition).
   */
  delayFlight(flightId: string, input: { additionalMinutes: number; reason: string }) {
    if (!Number.isInteger(input.additionalMinutes) || input.additionalMinutes <= 0) {
      throw new RangeError('additionalMinutes must be a positive integer');
    }
    return this.mutate(flightId, (flight, now) => {
      if (!DELAYABLE.has(flight.status)) {
        throw new FlightCommandRejectedError(flightId, `cannot delay a ${flight.status} flight`);
      }
      const delayMinutes = flight.delayMinutes + input.additionalMinutes;
      const estimates = delayedEstimates(flight, delayMinutes);
      const events: FlightEvent[] = [];
      if (flight.status !== 'DELAYED') {
        transitionFlight(flight.status, 'DELAYED');
        events.push(this.statusChanged(flight, 'DELAYED', now));
      }
      events.push(
        createFlightEvent(
          'FlightDelayed',
          flight.id,
          {
            ...context(flight),
            delayMinutes,
            previousDelayMinutes: flight.delayMinutes,
            reason: input.reason,
            estimatedDeparture: estimates.estimatedDeparture.toISOString(),
            estimatedArrival: estimates.estimatedArrival.toISOString(),
          },
          { occurredAt: now },
        ),
      );
      return {
        changes: { status: 'DELAYED', delayMinutes, delayReason: input.reason, ...estimates },
        events,
      };
    });
  }

  /** Assign or change the departure gate. A no-op (no event) when the gate is unchanged. */
  changeGate(flightId: string, newGate: string) {
    return this.mutate(flightId, (flight, now) => {
      if (flight.status === 'CANCELLED' || hasDeparted(flight.status)) {
        throw new FlightCommandRejectedError(
          flightId,
          `cannot change gate of a ${flight.status} flight`,
        );
      }
      if (flight.departureGate === newGate) return null;
      return {
        changes: { departureGate: newGate },
        events: [
          createFlightEvent(
            'FlightGateChanged',
            flight.id,
            { ...context(flight), oldGate: flight.departureGate, newGate },
            { occurredAt: now },
          ),
        ],
      };
    });
  }

  cancelFlight(flightId: string, reason: string) {
    return this.mutate(flightId, (flight, now) => {
      transitionFlight(flight.status, 'CANCELLED');
      return {
        changes: { status: 'CANCELLED' },
        events: [
          this.statusChanged(flight, 'CANCELLED', now),
          createFlightEvent(
            'FlightCancelled',
            flight.id,
            { ...context(flight), reason },
            { occurredAt: now },
          ),
        ],
      };
    });
  }

  divertFlight(flightId: string, input: { toIata: string; reason: string }) {
    return this.mutate(flightId, (flight, now) => {
      transitionFlight(flight.status, 'DIVERTED');
      if (input.toIata === flight.destinationIata) {
        throw new FlightCommandRejectedError(flightId, 'diversion airport equals destination');
      }
      const estimatedArrival = addMinutes(
        expectedArrival(flight),
        this.timings.diversionExtraMinutes,
      );
      return {
        changes: { status: 'DIVERTED', divertedToIata: input.toIata, estimatedArrival },
        events: [
          this.statusChanged(flight, 'DIVERTED', now),
          createFlightEvent(
            'FlightDiverted',
            flight.id,
            {
              ...context(flight),
              divertedToIata: input.toIata,
              reason: input.reason,
              estimatedArrival: estimatedArrival.toISOString(),
            },
            { occurredAt: now },
          ),
        ],
      };
    });
  }

  private statusChanged(flight: FlightRecord, to: FlightStatus, at: Date) {
    return createFlightEvent(
      'FlightStatusChanged',
      flight.id,
      { ...context(flight), from: flight.status, to },
      { occurredAt: at },
    );
  }

  private mutate(
    flightId: string,
    decide: (flight: FlightRecord, now: Date) => Mutation | null,
  ): Promise<FlightRecord> {
    return withTransaction(this.pool, async (tx) => {
      const { rows } = await tx.query<FlightRecord>(
        `SELECT ${FLIGHT_COLUMNS} FROM flights.flights WHERE id = $1 FOR UPDATE`,
        [flightId],
      );
      const flight = rows[0];
      if (!flight) throw new FlightNotFoundError(flightId);

      const mutation = decide(flight, this.clock());
      if (!mutation) return flight;

      const updated = await this.applyChanges(tx, flightId, mutation.changes);
      await insertOutboxEvents(tx, mutation.events);
      return updated;
    });
  }

  private async applyChanges(tx: PoolClient, flightId: string, changes: FlightChanges) {
    const keys = Object.keys(changes) as (keyof FlightChanges)[];
    const assignments = keys.map((key, i) => `${CHANGE_COLUMNS[key]} = $${i + 2}`);
    const { rows } = await tx.query<FlightRecord>(
      `UPDATE flights.flights
          SET ${[...assignments, 'version = version + 1', 'updated_at = now()'].join(', ')}
        WHERE id = $1
    RETURNING ${FLIGHT_COLUMNS}`,
      [flightId, ...keys.map((key) => changes[key])],
    );
    return rows[0] as FlightRecord;
  }
}

export async function insertOutboxEvents(
  db: Queryable,
  events: readonly FlightEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await db.query(
    `INSERT INTO flights.outbox_events
       (id, aggregate_type, aggregate_id, event_type, event_version, payload, occurred_at)
     SELECT e.id, 'Flight', e.aggregate_id, e.event_type, e.event_version, e.payload, e.occurred_at
       FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::int[], $5::jsonb[], $6::timestamptz[])
            WITH ORDINALITY AS e(id, aggregate_id, event_type, event_version, payload, occurred_at, n)
      -- keep array order so "sequence" follows the order the events were raised
      ORDER BY e.n`,
    [
      events.map((e) => e.id),
      events.map((e) => e.flightId),
      events.map((e) => e.type),
      events.map((e) => e.version),
      events.map((e) => JSON.stringify(e)),
      events.map((e) => e.occurredAt),
    ],
  );
}
