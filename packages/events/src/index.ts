import { randomUUID } from 'node:crypto';
import { FlightStatus } from '@flightops/domain';
import { z } from 'zod';

/** Redis pub/sub channel carrying every flight event (fire-and-forget fan-out). */
export const FLIGHT_EVENTS_CHANNEL = 'flight.events';
/** Redis Stream with the same events, kept for replay after reconnects (Phase 5). */
export const FLIGHT_EVENTS_STREAM = 'flight.events.stream';

const iata = z.string().regex(/^[A-Z]{3}$/);
const timestamp = z.iso.datetime();
const status = z.enum(FlightStatus);

/** Context every flight event carries so consumers can route without a lookup. */
const flightContext = {
  flightNumber: z.string().min(3),
  originIata: iata,
  destinationIata: iata,
};

function eventSchema<const T extends string, P extends z.ZodRawShape>(type: T, payload: P) {
  return z.object({
    id: z.uuid(),
    type: z.literal(type),
    version: z.literal(1),
    flightId: z.uuid(),
    occurredAt: timestamp,
    payload: z.object({ ...flightContext, ...payload }),
  });
}

export const flightStatusChangedSchema = eventSchema('FlightStatusChanged', {
  from: status,
  to: status,
});

export const flightDelayedSchema = eventSchema('FlightDelayed', {
  delayMinutes: z.number().int().positive(),
  previousDelayMinutes: z.number().int().nonnegative(),
  reason: z.string().min(1),
  estimatedDeparture: timestamp,
  estimatedArrival: timestamp,
});

export const flightGateChangedSchema = eventSchema('FlightGateChanged', {
  oldGate: z.string().nullable(),
  newGate: z.string().min(1),
});

export const flightCancelledSchema = eventSchema('FlightCancelled', {
  reason: z.string().min(1),
});

export const flightDivertedSchema = eventSchema('FlightDiverted', {
  divertedToIata: iata,
  reason: z.string().min(1),
  estimatedArrival: timestamp,
});

export const flightEventSchema = z.discriminatedUnion('type', [
  flightStatusChangedSchema,
  flightDelayedSchema,
  flightGateChangedSchema,
  flightCancelledSchema,
  flightDivertedSchema,
]);

export type FlightEvent = z.infer<typeof flightEventSchema>;
export type FlightEventType = FlightEvent['type'];
export type FlightEventOf<T extends FlightEventType> = Extract<FlightEvent, { type: T }>;
export type FlightEventPayload<T extends FlightEventType> = FlightEventOf<T>['payload'];

export const FLIGHT_EVENT_TYPES: readonly FlightEventType[] = flightEventSchema.options.map(
  (option) => option.shape.type.value,
);

export interface CreateEventOptions {
  id?: string;
  occurredAt?: Date;
}

export function createFlightEvent<T extends FlightEventType>(
  type: T,
  flightId: string,
  payload: FlightEventPayload<T>,
  options: CreateEventOptions = {},
): FlightEventOf<T> {
  return {
    id: options.id ?? randomUUID(),
    type,
    version: 1,
    flightId,
    occurredAt: (options.occurredAt ?? new Date()).toISOString(),
    payload,
  } as FlightEventOf<T>;
}

/** Validate an event received from Redis or the database. Accepts a JSON string or object. */
export function parseFlightEvent(input: unknown): FlightEvent {
  return flightEventSchema.parse(typeof input === 'string' ? JSON.parse(input) : input);
}
