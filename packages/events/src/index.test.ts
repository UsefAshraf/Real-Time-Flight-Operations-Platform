import { describe, expect, it } from 'vitest';
import { FLIGHT_EVENT_TYPES, createFlightEvent, parseFlightEvent } from './index.js';

const FLIGHT_ID = '0b7a3c2e-5d1f-4e8a-9c6b-2f4d8e1a7b3c';
const context = { flightNumber: 'FO101', originIata: 'CAI', destinationIata: 'LHR' };

describe('flight events', () => {
  it('creates a valid versioned envelope', () => {
    const event = createFlightEvent('FlightGateChanged', FLIGHT_ID, {
      ...context,
      oldGate: 'A12',
      newGate: 'B04',
    });
    expect(event).toMatchObject({ type: 'FlightGateChanged', version: 1, flightId: FLIGHT_ID });
    expect(parseFlightEvent(JSON.stringify(event))).toEqual(event);
  });

  it('narrows the payload type by event type', () => {
    const event = parseFlightEvent(
      createFlightEvent('FlightStatusChanged', FLIGHT_ID, {
        ...context,
        from: 'BOARDING',
        to: 'DEPARTED',
      }),
    );
    if (event.type === 'FlightStatusChanged') {
      expect(event.payload.to).toBe('DEPARTED');
    } else {
      expect.unreachable();
    }
  });

  it('uses the given id and timestamp', () => {
    const occurredAt = new Date('2026-11-06T18:30:00Z');
    const event = createFlightEvent(
      'FlightCancelled',
      FLIGHT_ID,
      { ...context, reason: 'Weather' },
      { id: '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b', occurredAt },
    );
    expect(event.id).toBe('6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b');
    expect(event.occurredAt).toBe('2026-11-06T18:30:00.000Z');
  });

  it.each([
    ['unknown type', { type: 'FlightTeleported' }],
    [
      'bad status',
      { type: 'FlightStatusChanged', payload: { ...context, from: 'FLYING', to: 'LANDED' } },
    ],
    [
      'bad airport',
      { type: 'FlightCancelled', payload: { ...context, originIata: 'cairo', reason: 'x' } },
    ],
    [
      'wrong version',
      { type: 'FlightCancelled', version: 2, payload: { ...context, reason: 'x' } },
    ],
  ])('rejects %s', (_label, override) => {
    const base = createFlightEvent('FlightCancelled', FLIGHT_ID, { ...context, reason: 'Weather' });
    expect(() => parseFlightEvent({ ...base, ...override })).toThrow();
  });

  it('lists every event type', () => {
    expect(FLIGHT_EVENT_TYPES).toEqual([
      'FlightStatusChanged',
      'FlightDelayed',
      'FlightGateChanged',
      'FlightCancelled',
      'FlightDiverted',
    ]);
  });
});
