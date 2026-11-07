import type { FlightStatus } from '@flightops/domain';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMINGS,
  addMinutes,
  blockMinutes,
  delayedEstimates,
  expectedArrival,
  nextLifecycleStep,
  transitionChanges,
  type ScheduleFields,
} from './lifecycle.js';

const STD = new Date('2026-11-06T10:00:00Z');
const STA = new Date('2026-11-06T15:00:00Z');

function flight(overrides: Partial<ScheduleFields> = {}): ScheduleFields {
  return {
    status: 'SCHEDULED',
    scheduledDeparture: STD,
    scheduledArrival: STA,
    estimatedDeparture: null,
    estimatedArrival: null,
    actualDeparture: null,
    ...overrides,
  };
}

/** Run the lifecycle until `until`, like the seeder does. */
function settle(start: ScheduleFields, until: Date) {
  let current = start;
  const path: FlightStatus[] = [];
  for (
    let step = nextLifecycleStep(current);
    step && step.at <= until;
    step = nextLifecycleStep(current)
  ) {
    current = { ...current, ...transitionChanges(current, step.to, step.at) };
    path.push(step.to);
  }
  return { current, path };
}

describe('lifecycle', () => {
  it('computes block time', () => {
    expect(blockMinutes(flight())).toBe(300);
  });

  it('starts boarding 40 minutes before departure', () => {
    expect(nextLifecycleStep(flight())).toEqual({ to: 'BOARDING', at: addMinutes(STD, -40) });
  });

  it('uses the estimated departure once delayed', () => {
    const delayed = flight({ status: 'DELAYED', ...delayedEstimates(flight(), 60) });
    expect(nextLifecycleStep(delayed)?.at).toEqual(addMinutes(STD, 60 - 40));
  });

  it('walks the full happy path with realistic timestamps', () => {
    const { current, path } = settle(flight(), addMinutes(STA, 60));
    expect(path).toEqual(['BOARDING', 'DEPARTED', 'AIRBORNE', 'LANDED', 'ARRIVED']);
    expect(current.actualDeparture).toEqual(STD);
    expect(current.estimatedArrival).toEqual(STA);
    expect(nextLifecycleStep(current)).toBeNull();
  });

  it('stops at the right state mid-flight', () => {
    const { current } = settle(flight(), addMinutes(STD, 90));
    expect(current.status).toBe('AIRBORNE');
  });

  it('bases arrival on the actual departure time', () => {
    const late = flight({ status: 'AIRBORNE', actualDeparture: addMinutes(STD, 25) });
    expect(expectedArrival(late)).toEqual(addMinutes(STA, 25));
    expect(nextLifecycleStep(late)).toEqual({
      to: 'LANDED',
      at: addMinutes(STA, 25 - DEFAULT_TIMINGS.landingLeadMinutes),
    });
  });

  it.each(['ARRIVED', 'CANCELLED'] as const)('has no step after %s', (status) => {
    expect(nextLifecycleStep(flight({ status }))).toBeNull();
  });
});
