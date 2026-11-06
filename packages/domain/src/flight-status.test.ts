import { describe, expect, it } from 'vitest';
import {
  FLIGHT_STATUSES,
  FlightStatus,
  InvalidFlightTransitionError,
  allowedTransitions,
  canTransition,
  hasDeparted,
  isFlightStatus,
  isTerminalStatus,
  transitionFlight,
} from './flight-status.js';

describe('flight status state machine', () => {
  it('follows the happy path from SCHEDULED to ARRIVED', () => {
    const path: FlightStatus[] = ['BOARDING', 'DEPARTED', 'AIRBORNE', 'LANDED', 'ARRIVED'];
    let current: FlightStatus = FlightStatus.SCHEDULED;
    for (const next of path) {
      current = transitionFlight(current, next);
    }
    expect(current).toBe(FlightStatus.ARRIVED);
  });

  it('supports delay, diversion and cancellation paths', () => {
    expect(canTransition('SCHEDULED', 'DELAYED')).toBe(true);
    expect(canTransition('DELAYED', 'BOARDING')).toBe(true);
    expect(canTransition('BOARDING', 'DELAYED')).toBe(true);
    expect(canTransition('AIRBORNE', 'DIVERTED')).toBe(true);
    expect(canTransition('DIVERTED', 'LANDED')).toBe(true);
    expect(canTransition('SCHEDULED', 'CANCELLED')).toBe(true);
  });

  it.each([
    ['DEPARTED', 'CANCELLED'],
    ['AIRBORNE', 'BOARDING'],
    ['ARRIVED', 'SCHEDULED'],
    ['CANCELLED', 'SCHEDULED'],
    ['DELAYED', 'DELAYED'],
    ['SCHEDULED', 'ARRIVED'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => transitionFlight(from, to)).toThrow(InvalidFlightTransitionError);
  });

  it('exposes from/to on the error', () => {
    const error = (() => {
      try {
        transitionFlight('ARRIVED', 'BOARDING');
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(InvalidFlightTransitionError);
    expect(error).toMatchObject({ from: 'ARRIVED', to: 'BOARDING' });
  });

  it('has exactly two terminal states', () => {
    expect(FLIGHT_STATUSES.filter(isTerminalStatus).sort()).toEqual(['ARRIVED', 'CANCELLED']);
  });

  it('makes every status reachable from SCHEDULED', () => {
    const seen = new Set<FlightStatus>(['SCHEDULED']);
    const queue: FlightStatus[] = ['SCHEDULED'];
    for (let current = queue.shift(); current; current = queue.shift()) {
      for (const next of allowedTransitions(current)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...FLIGHT_STATUSES].sort());
  });

  it('classifies departed statuses', () => {
    expect(hasDeparted('BOARDING')).toBe(false);
    expect(hasDeparted('DEPARTED')).toBe(true);
    expect(hasDeparted('CANCELLED')).toBe(false);
  });

  it('validates unknown input', () => {
    expect(isFlightStatus('BOARDING')).toBe(true);
    expect(isFlightStatus('boarding')).toBe(false);
    expect(isFlightStatus(42)).toBe(false);
  });
});
