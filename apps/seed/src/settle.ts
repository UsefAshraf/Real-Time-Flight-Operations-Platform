import type { FlightStatus } from '@flightops/domain';
import {
  DEFAULT_TIMINGS,
  DELAY_MINUTES,
  DELAY_REASONS,
  delayedEstimates,
  gateAssignmentDueAt,
  nextLifecycleStep,
  transitionChanges,
  type LifecycleTimings,
  type Rng,
} from '@flightops/flights-core';
import type { ScheduledFlight } from './schedule.js';

export interface SeededFlight extends ScheduledFlight {
  status: FlightStatus;
  estimatedDeparture: Date | null;
  estimatedArrival: Date | null;
  actualDeparture: Date | null;
  actualArrival: Date | null;
  departureGate: string | null;
  delayMinutes: number;
  delayReason: string | null;
}

export interface SettleOptions {
  now: Date;
  rng: Rng;
  gatesByAirport: ReadonlyMap<string, readonly string[]>;
  timings?: LifecycleTimings;
  delayProbability?: number;
  cancellationProbability?: number;
}

const HOUR = 3_600_000;

/**
 * Put each flight in the state it would be in at `now`, as if the simulator had been running
 * all along: past flights have arrived (with actual times), some are airborne, some boarding.
 * Disruptions are only decided for flights already inside the operational window.
 */
export function settleFlights(
  flights: readonly ScheduledFlight[],
  options: SettleOptions,
): SeededFlight[] {
  const { now, rng } = options;
  const timings = options.timings ?? DEFAULT_TIMINGS;
  const delayP = options.delayProbability ?? 0.15;
  const cancelP = options.cancellationProbability ?? 0.01;
  const horizon = now.getTime() + 3 * HOUR;

  return flights.map((scheduled) => {
    let flight: SeededFlight = {
      ...scheduled,
      status: 'SCHEDULED',
      estimatedDeparture: null,
      estimatedArrival: null,
      actualDeparture: null,
      actualArrival: null,
      departureGate: null,
      delayMinutes: 0,
      delayReason: null,
    };

    if (scheduled.scheduledDeparture.getTime() <= horizon) {
      const roll = rng.next();
      if (roll < cancelP) return { ...flight, status: 'CANCELLED' };
      if (roll < cancelP + delayP) {
        const delayMinutes = rng.pick(DELAY_MINUTES);
        flight = {
          ...flight,
          status: 'DELAYED',
          delayMinutes,
          delayReason: rng.pick(DELAY_REASONS),
          ...delayedEstimates(flight, delayMinutes),
        };
      }
    }

    const gates = options.gatesByAirport.get(flight.originIata);
    if (gates?.length && gateAssignmentDueAt(flight, timings) <= now) {
      flight.departureGate = rng.pick(gates);
    }

    for (
      let step = nextLifecycleStep(flight, timings);
      step && step.at <= now;
      step = nextLifecycleStep(flight, timings)
    ) {
      flight = { ...flight, ...transitionChanges(flight, step.to, step.at) };
    }
    return flight;
  });
}
