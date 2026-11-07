import type { FlightStatus } from '@flightops/domain';
import type { FlightChanges, FlightRecord } from './flight-record.js';

/**
 * Pure timing rules for how a flight progresses on its own (no disruptions). Shared by the
 * simulator (live) and the seeder (to put historical flights into a realistic state).
 */
export interface LifecycleTimings {
  /** Boarding starts this long before departure. */
  boardingLeadMinutes: number;
  /** Pushback to wheels-up. */
  taxiOutMinutes: number;
  /** Touchdown happens this long before on-block (arrival). */
  landingLeadMinutes: number;
  /** A departure gate is assigned this long before departure. */
  gateAssignmentLeadMinutes: number;
  /** Extra time added to the arrival estimate when a flight diverts. */
  diversionExtraMinutes: number;
}

export const DEFAULT_TIMINGS: LifecycleTimings = {
  boardingLeadMinutes: 40,
  taxiOutMinutes: 15,
  landingLeadMinutes: 10,
  gateAssignmentLeadMinutes: 120,
  diversionExtraMinutes: 45,
};

export type ScheduleFields = Pick<
  FlightRecord,
  | 'status'
  | 'scheduledDeparture'
  | 'scheduledArrival'
  | 'estimatedDeparture'
  | 'estimatedArrival'
  | 'actualDeparture'
>;

export interface LifecycleStep {
  to: FlightStatus;
  /** When the step is due. Used as the event time, so catch-up produces realistic timestamps. */
  at: Date;
}

const MINUTE = 60_000;

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE);
}

/** Scheduled gate-to-gate duration. */
export function blockMinutes(
  flight: Pick<FlightRecord, 'scheduledDeparture' | 'scheduledArrival'>,
) {
  return Math.round(
    (flight.scheduledArrival.getTime() - flight.scheduledDeparture.getTime()) / MINUTE,
  );
}

export function expectedDeparture(flight: ScheduleFields): Date {
  return flight.estimatedDeparture ?? flight.scheduledDeparture;
}

export function expectedArrival(flight: ScheduleFields): Date {
  if (flight.estimatedArrival) return flight.estimatedArrival;
  return addMinutes(flight.actualDeparture ?? expectedDeparture(flight), blockMinutes(flight));
}

export function nextLifecycleStep(
  flight: ScheduleFields,
  timings: LifecycleTimings = DEFAULT_TIMINGS,
): LifecycleStep | null {
  switch (flight.status) {
    case 'SCHEDULED':
    case 'DELAYED':
      return {
        to: 'BOARDING',
        at: addMinutes(expectedDeparture(flight), -timings.boardingLeadMinutes),
      };
    case 'BOARDING':
      return { to: 'DEPARTED', at: expectedDeparture(flight) };
    case 'DEPARTED':
      return {
        to: 'AIRBORNE',
        at: addMinutes(flight.actualDeparture ?? expectedDeparture(flight), timings.taxiOutMinutes),
      };
    case 'AIRBORNE':
    case 'DIVERTED':
      return { to: 'LANDED', at: addMinutes(expectedArrival(flight), -timings.landingLeadMinutes) };
    case 'LANDED':
      return { to: 'ARRIVED', at: expectedArrival(flight) };
    case 'ARRIVED':
    case 'CANCELLED':
      return null;
  }
}

/** Column changes that accompany entering `to` at time `at`. */
export function transitionChanges(
  flight: ScheduleFields,
  to: FlightStatus,
  at: Date,
): FlightChanges {
  switch (to) {
    case 'DEPARTED':
      return {
        status: to,
        actualDeparture: at,
        estimatedArrival: addMinutes(at, blockMinutes(flight)),
      };
    case 'ARRIVED':
      return { status: to, actualArrival: at };
    default:
      return { status: to };
  }
}

/** When the simulator should assign a departure gate. */
export function gateAssignmentDueAt(
  flight: ScheduleFields,
  timings: LifecycleTimings = DEFAULT_TIMINGS,
): Date {
  return addMinutes(expectedDeparture(flight), -timings.gateAssignmentLeadMinutes);
}

/** New estimates after a delay of `totalDelayMinutes` against the schedule. */
export function delayedEstimates(
  flight: Pick<FlightRecord, 'scheduledDeparture' | 'scheduledArrival'>,
  totalDelayMinutes: number,
): { estimatedDeparture: Date; estimatedArrival: Date } {
  return {
    estimatedDeparture: addMinutes(flight.scheduledDeparture, totalDelayMinutes),
    estimatedArrival: addMinutes(flight.scheduledArrival, totalDelayMinutes),
  };
}
