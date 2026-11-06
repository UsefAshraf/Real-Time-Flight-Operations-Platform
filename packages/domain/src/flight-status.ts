/**
 * Flight lifecycle. A delay is a status *and* a revised estimate: re-delaying an
 * already-delayed flight updates its estimated times, it is not a state transition.
 */
export const FlightStatus = {
  SCHEDULED: 'SCHEDULED',
  DELAYED: 'DELAYED',
  BOARDING: 'BOARDING',
  DEPARTED: 'DEPARTED',
  AIRBORNE: 'AIRBORNE',
  DIVERTED: 'DIVERTED',
  LANDED: 'LANDED',
  ARRIVED: 'ARRIVED',
  CANCELLED: 'CANCELLED',
} as const;

export type FlightStatus = (typeof FlightStatus)[keyof typeof FlightStatus];

export const FLIGHT_STATUSES: readonly FlightStatus[] = Object.values(FlightStatus);

const TRANSITIONS: Readonly<Record<FlightStatus, readonly FlightStatus[]>> = {
  SCHEDULED: ['DELAYED', 'BOARDING', 'CANCELLED'],
  DELAYED: ['BOARDING', 'CANCELLED'],
  BOARDING: ['DELAYED', 'DEPARTED', 'CANCELLED'],
  DEPARTED: ['AIRBORNE'],
  AIRBORNE: ['LANDED', 'DIVERTED'],
  DIVERTED: ['LANDED'],
  LANDED: ['ARRIVED'],
  ARRIVED: [],
  CANCELLED: [],
};

const DEPARTED_STATUSES: ReadonlySet<FlightStatus> = new Set([
  'DEPARTED',
  'AIRBORNE',
  'DIVERTED',
  'LANDED',
  'ARRIVED',
]);

export class InvalidFlightTransitionError extends Error {
  override readonly name = 'InvalidFlightTransitionError';

  constructor(
    readonly from: FlightStatus,
    readonly to: FlightStatus,
  ) {
    super(`Invalid flight status transition: ${from} -> ${to}`);
  }
}

export function isFlightStatus(value: unknown): value is FlightStatus {
  return typeof value === 'string' && (FLIGHT_STATUSES as readonly string[]).includes(value);
}

export function allowedTransitions(from: FlightStatus): readonly FlightStatus[] {
  return TRANSITIONS[from];
}

export function canTransition(from: FlightStatus, to: FlightStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Returns `to` when the transition is legal, otherwise throws. */
export function transitionFlight(from: FlightStatus, to: FlightStatus): FlightStatus {
  if (!canTransition(from, to)) {
    throw new InvalidFlightTransitionError(from, to);
  }
  return to;
}

export function isTerminalStatus(status: FlightStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** The aircraft has left the gate, so gate changes no longer apply. */
export function hasDeparted(status: FlightStatus): boolean {
  return DEPARTED_STATUSES.has(status);
}
