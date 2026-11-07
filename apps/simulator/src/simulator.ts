import type { Pool } from '@flightops/db';
import { InvalidFlightTransitionError } from '@flightops/domain';
import {
  CANCELLATION_REASONS,
  DEFAULT_TIMINGS,
  DELAY_MINUTES,
  DELAY_REASONS,
  DIVERSION_REASONS,
  FLIGHT_COLUMNS,
  FlightCommandRejectedError,
  FlightNotFoundError,
  nextLifecycleStep,
  type FlightRecord,
  type FlightService,
  type LifecycleTimings,
  type Rng,
} from '@flightops/flights-core';
import type { Logger } from '@flightops/logger';

/** Average number of each disruption per simulated minute. */
export interface DisruptionRates {
  delaysPerMinute: number;
  gateChangesPerMinute: number;
  cancellationsPerMinute: number;
  diversionsPerMinute: number;
}

export const DEFAULT_RATES: DisruptionRates = {
  delaysPerMinute: 0.3,
  gateChangesPerMinute: 0.2,
  cancellationsPerMinute: 0.01,
  diversionsPerMinute: 0.002,
};

export interface SimulatorOptions {
  pool: Pool;
  flights: FlightService;
  logger: Logger;
  rng: Rng;
  now: () => Date;
  rates?: DisruptionRates;
  timings?: LifecycleTimings;
  /** Upper bound on lifecycle transitions per tick, so catching up after downtime is gradual. */
  maxTransitionsPerTick?: number;
}

export interface TickResult {
  transitions: number;
  gateAssignments: number;
  delays: number;
  gateChanges: number;
  cancellations: number;
  diversions: number;
}

export interface SimulatorStats extends TickResult {
  ticks: number;
  skipped: number;
  simTime: string | null;
}

const ACTIVE = `status NOT IN ('ARRIVED', 'CANCELLED')`;
const EXPECTED_DEPARTURE = 'coalesce(estimated_departure, scheduled_departure)';

function isExpectedConflict(error: unknown): boolean {
  // Another writer (e.g. an ops user via the API) changed the flight between our read and our
  // locked write. The command re-validated against fresh state and refused: skip this flight.
  return (
    error instanceof InvalidFlightTransitionError ||
    error instanceof FlightCommandRejectedError ||
    error instanceof FlightNotFoundError
  );
}

export class FlightSimulator {
  private readonly rates: DisruptionRates;
  private readonly timings: LifecycleTimings;
  private readonly maxTransitionsPerTick: number;
  private gates = new Map<string, string[]>();
  private lastTick: Date | undefined;
  private readonly totals: SimulatorStats = {
    ticks: 0,
    skipped: 0,
    simTime: null,
    transitions: 0,
    gateAssignments: 0,
    delays: 0,
    gateChanges: 0,
    cancellations: 0,
    diversions: 0,
  };

  constructor(private readonly options: SimulatorOptions) {
    this.rates = options.rates ?? DEFAULT_RATES;
    this.timings = options.timings ?? DEFAULT_TIMINGS;
    this.maxTransitionsPerTick = options.maxTransitionsPerTick ?? 500;
  }

  getStats(): SimulatorStats {
    return { ...this.totals };
  }

  /** Load open gates per airport (read-only lookup into the airports context). */
  async loadGates(): Promise<void> {
    const { rows } = await this.options.pool.query<{ airport: string; codes: string[] }>(
      `SELECT airport_iata AS airport, array_agg(code ORDER BY code) AS codes
         FROM airports.gates WHERE is_open GROUP BY airport_iata`,
    );
    this.gates = new Map(rows.map((row) => [row.airport, row.codes]));
  }

  async tick(): Promise<TickResult> {
    const now = this.options.now();
    const elapsedMinutes = this.lastTick ? (now.getTime() - this.lastTick.getTime()) / 60_000 : 0;
    this.lastTick = now;

    const result: TickResult = {
      transitions: await this.advanceLifecycles(now),
      gateAssignments: await this.assignGates(now),
      delays: 0,
      gateChanges: 0,
      cancellations: 0,
      diversions: 0,
    };
    if (elapsedMinutes > 0)
      Object.assign(result, await this.injectDisruptions(now, elapsedMinutes));

    this.totals.ticks += 1;
    this.totals.simTime = now.toISOString();
    for (const key of Object.keys(result) as (keyof TickResult)[]) this.totals[key] += result[key];
    return result;
  }

  recordSkippedTick(): void {
    this.totals.skipped += 1;
  }

  /** Move every flight whose next step is due, possibly several steps when catching up. */
  private async advanceLifecycles(now: Date): Promise<number> {
    const { rows } = await this.options.pool.query<FlightRecord>(
      `SELECT ${FLIGHT_COLUMNS} FROM flights.flights
        WHERE ${ACTIVE}
          AND ${EXPECTED_DEPARTURE} <= $1::timestamptz + make_interval(mins => $2)
        ORDER BY scheduled_departure
        LIMIT $3`,
      [now, this.timings.boardingLeadMinutes, this.maxTransitionsPerTick],
    );

    let transitions = 0;
    for (let flight of rows) {
      for (
        let step = nextLifecycleStep(flight, this.timings);
        step && step.at <= now && transitions < this.maxTransitionsPerTick;
        step = nextLifecycleStep(flight, this.timings)
      ) {
        try {
          flight = await this.options.flights.transitionStatus(flight.id, step.to, { at: step.at });
          transitions += 1;
        } catch (error) {
          if (!isExpectedConflict(error)) throw error;
          break;
        }
      }
    }
    return transitions;
  }

  private async assignGates(now: Date): Promise<number> {
    const { rows } = await this.options.pool.query<{ id: string; originIata: string }>(
      `SELECT id, origin_iata AS "originIata" FROM flights.flights
        WHERE status IN ('SCHEDULED', 'DELAYED', 'BOARDING')
          AND departure_gate IS NULL
          AND ${EXPECTED_DEPARTURE} <= $1::timestamptz + make_interval(mins => $2)
        LIMIT 500`,
      [now, this.timings.gateAssignmentLeadMinutes],
    );
    let assigned = 0;
    for (const row of rows) {
      const gates = this.gates.get(row.originIata);
      if (!gates?.length) continue;
      if (
        await this.attempt(() =>
          this.options.flights.changeGate(row.id, this.options.rng.pick(gates)),
        )
      ) {
        assigned += 1;
      }
    }
    return assigned;
  }

  private async injectDisruptions(now: Date, minutes: number) {
    const { rng } = this.options;
    const count = (rate: number) => rng.poisson(rate * minutes);

    const delays = await this.forEachCandidate(
      count(this.rates.delaysPerMinute),
      `status IN ('SCHEDULED', 'DELAYED', 'BOARDING')
         AND ${EXPECTED_DEPARTURE} BETWEEN $1::timestamptz AND $1::timestamptz + interval '3 hours'`,
      now,
      (f) =>
        this.options.flights.delayFlight(f.id, {
          additionalMinutes: rng.pick(DELAY_MINUTES),
          reason: rng.pick(DELAY_REASONS),
        }),
    );

    const gateChanges = await this.forEachCandidate(
      count(this.rates.gateChangesPerMinute),
      `status IN ('SCHEDULED', 'DELAYED', 'BOARDING')
         AND departure_gate IS NOT NULL
         AND ${EXPECTED_DEPARTURE} BETWEEN $1::timestamptz AND $1::timestamptz + interval '2 hours'`,
      now,
      async (f) => {
        const options = (this.gates.get(f.originIata) ?? []).filter((g) => g !== f.departureGate);
        if (options.length === 0) return;
        await this.options.flights.changeGate(f.id, rng.pick(options));
      },
    );

    const cancellations = await this.forEachCandidate(
      count(this.rates.cancellationsPerMinute),
      `status IN ('SCHEDULED', 'DELAYED')
         AND ${EXPECTED_DEPARTURE} BETWEEN $1::timestamptz + interval '1 hour'
                                       AND $1::timestamptz + interval '6 hours'`,
      now,
      (f) => this.options.flights.cancelFlight(f.id, rng.pick(CANCELLATION_REASONS)),
    );

    const diversions = await this.forEachCandidate(
      count(this.rates.diversionsPerMinute),
      `status = 'AIRBORNE'`,
      now,
      async (f) => {
        const alternates = [...this.gates.keys()].filter(
          (iata) => iata !== f.destinationIata && iata !== f.originIata,
        );
        if (alternates.length === 0) return;
        await this.options.flights.divertFlight(f.id, {
          toIata: rng.pick(alternates),
          reason: rng.pick(DIVERSION_REASONS),
        });
      },
    );

    return { delays, gateChanges, cancellations, diversions };
  }

  private async forEachCandidate(
    count: number,
    where: string,
    now: Date,
    action: (flight: FlightRecord) => Promise<unknown>,
  ): Promise<number> {
    if (count <= 0) return 0;
    const { rows } = await this.options.pool.query<FlightRecord>(
      `SELECT ${FLIGHT_COLUMNS} FROM flights.flights WHERE ${where} ORDER BY random() LIMIT $2`,
      [now, count],
    );
    let done = 0;
    for (const flight of rows) {
      if (await this.attempt(() => action(flight))) done += 1;
    }
    return done;
  }

  private async attempt(action: () => Promise<unknown>): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (error) {
      if (isExpectedConflict(error)) {
        this.options.logger.debug({ err: error }, 'skipped conflicting simulator command');
        return false;
      }
      throw error;
    }
  }
}
