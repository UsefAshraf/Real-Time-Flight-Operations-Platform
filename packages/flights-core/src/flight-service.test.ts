import { InvalidFlightTransitionError } from '@flightops/domain';
import { parseFlightEvent } from '@flightops/events';
import {
  insertFlight,
  outboxEvents,
  startPostgres,
  truncateAll,
  type TestPostgres,
} from '@flightops/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FlightCommandRejectedError,
  FlightNotFoundError,
  FlightService,
} from './flight-service.js';

let db: TestPostgres;
let service: FlightService;
const NOW = new Date('2026-11-06T08:00:00Z');
const STD = new Date('2026-11-06T10:00:00Z');
const STA = new Date('2026-11-06T15:00:00Z');

beforeAll(async () => {
  db = await startPostgres();
  service = new FlightService(db.pool, { clock: () => NOW });
});

afterAll(async () => {
  await db.stop();
});

beforeEach(async () => {
  await truncateAll(db.pool);
});

const newFlight = (overrides: Parameters<typeof insertFlight>[1] = {}) =>
  insertFlight(db.pool, { scheduledDeparture: STD, scheduledArrival: STA, ...overrides });

describe('FlightService', () => {
  it('transitions status and writes a valid event to the outbox atomically', async () => {
    const id = await newFlight();
    const updated = await service.transitionStatus(id, 'BOARDING');

    expect(updated).toMatchObject({ status: 'BOARDING', version: 2 });
    const events = await outboxEvents(db.pool, id);
    expect(events.map((e) => e.eventType)).toEqual(['FlightStatusChanged']);
    expect(events[0]?.publishedAt).toBeNull();
    expect(parseFlightEvent(events[0]?.payload)).toMatchObject({
      flightId: id,
      payload: { from: 'SCHEDULED', to: 'BOARDING', flightNumber: expect.any(String) as string },
    });
  });

  it('records actual departure and recomputes the arrival estimate', async () => {
    const id = await newFlight({ status: 'BOARDING' });
    const pushback = new Date('2026-11-06T10:20:00Z');
    const updated = await service.transitionStatus(id, 'DEPARTED', { at: pushback });
    expect(updated.actualDeparture).toEqual(pushback);
    expect(updated.estimatedArrival).toEqual(new Date('2026-11-06T15:20:00Z'));
  });

  it('rejects an invalid transition and writes nothing', async () => {
    const id = await newFlight();
    await expect(service.transitionStatus(id, 'LANDED')).rejects.toThrow(
      InvalidFlightTransitionError,
    );
    expect(await outboxEvents(db.pool, id)).toEqual([]);
    expect((await service.getFlight(id))?.version).toBe(1);
  });

  it('requires dedicated commands for DELAYED, CANCELLED and DIVERTED', () => {
    expect(() => service.transitionStatus('x', 'CANCELLED')).toThrow(TypeError);
  });

  it('throws FlightNotFoundError for unknown flights', async () => {
    await expect(
      service.transitionStatus('00000000-0000-4000-8000-000000000000', 'BOARDING'),
    ).rejects.toThrow(FlightNotFoundError);
  });

  describe('delayFlight', () => {
    it('moves to DELAYED on the first delay and emits two events', async () => {
      const id = await newFlight();
      const updated = await service.delayFlight(id, { additionalMinutes: 45, reason: 'Weather' });

      expect(updated).toMatchObject({
        status: 'DELAYED',
        delayMinutes: 45,
        delayReason: 'Weather',
      });
      expect(updated.estimatedDeparture).toEqual(new Date('2026-11-06T10:45:00Z'));
      expect(updated.estimatedArrival).toEqual(new Date('2026-11-06T15:45:00Z'));
      expect((await outboxEvents(db.pool, id)).map((e) => e.eventType)).toEqual([
        'FlightStatusChanged',
        'FlightDelayed',
      ]);
    });

    it('only revises estimates when already delayed', async () => {
      const id = await newFlight();
      await service.delayFlight(id, { additionalMinutes: 30, reason: 'ATC' });
      const updated = await service.delayFlight(id, { additionalMinutes: 15, reason: 'ATC' });

      expect(updated.delayMinutes).toBe(45);
      const events = await outboxEvents(db.pool, id);
      expect(events.map((e) => e.eventType)).toEqual([
        'FlightStatusChanged',
        'FlightDelayed',
        'FlightDelayed',
      ]);
      expect(events[2]?.payload.payload).toMatchObject({
        delayMinutes: 45,
        previousDelayMinutes: 30,
      });
    });

    it('rejects delaying a departed flight', async () => {
      const id = await newFlight({ status: 'AIRBORNE', actualDeparture: STD });
      await expect(service.delayFlight(id, { additionalMinutes: 10, reason: 'x' })).rejects.toThrow(
        FlightCommandRejectedError,
      );
    });

    it('validates the minutes', () => {
      expect(() => service.delayFlight('x', { additionalMinutes: 0, reason: 'x' })).toThrow(
        RangeError,
      );
    });
  });

  describe('changeGate', () => {
    it('emits old and new gate', async () => {
      const id = await newFlight({ departureGate: 'A12' });
      await service.changeGate(id, 'B04');
      const [event] = await outboxEvents(db.pool, id);
      expect(event?.payload.payload).toMatchObject({ oldGate: 'A12', newGate: 'B04' });
    });

    it('is a no-op for the same gate', async () => {
      const id = await newFlight({ departureGate: 'A12' });
      const result = await service.changeGate(id, 'A12');
      expect(result.version).toBe(1);
      expect(await outboxEvents(db.pool, id)).toEqual([]);
    });

    it('is rejected after departure', async () => {
      const id = await newFlight({ status: 'DEPARTED', actualDeparture: STD });
      await expect(service.changeGate(id, 'C01')).rejects.toThrow(FlightCommandRejectedError);
    });
  });

  it('cancels with a reason', async () => {
    const id = await newFlight();
    const updated = await service.cancelFlight(id, 'Technical fault');
    expect(updated.status).toBe('CANCELLED');
    expect((await outboxEvents(db.pool, id)).map((e) => e.eventType)).toEqual([
      'FlightStatusChanged',
      'FlightCancelled',
    ]);
  });

  it('diverts an airborne flight and extends the arrival estimate', async () => {
    const id = await newFlight({ status: 'AIRBORNE', actualDeparture: STD });
    const updated = await service.divertFlight(id, {
      toIata: 'AMS',
      reason: 'Weather at destination',
    });
    expect(updated).toMatchObject({ status: 'DIVERTED', divertedToIata: 'AMS' });
    expect(updated.estimatedArrival).toEqual(new Date('2026-11-06T15:45:00Z'));
  });

  it('serialises concurrent commands on the same flight', async () => {
    const id = await newFlight();
    const results = await Promise.allSettled([
      service.delayFlight(id, { additionalMinutes: 10, reason: 'a' }),
      service.delayFlight(id, { additionalMinutes: 20, reason: 'b' }),
      service.delayFlight(id, { additionalMinutes: 30, reason: 'c' }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const flight = await service.getFlight(id);
    expect(flight).toMatchObject({ delayMinutes: 60, version: 4 });
  });
});
