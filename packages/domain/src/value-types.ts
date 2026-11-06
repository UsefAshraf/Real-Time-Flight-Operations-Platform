export const UserRole = {
  PASSENGER: 'PASSENGER',
  OPS: 'OPS',
  ADMIN: 'ADMIN',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const NotificationChannel = {
  IN_APP: 'IN_APP',
  EMAIL: 'EMAIL',
  PUSH: 'PUSH',
} as const;
export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];

/** Three-letter IATA airport code, e.g. "CAI". */
export type IataAirportCode = string & { readonly __brand: 'IataAirportCode' };

const IATA_AIRPORT = /^[A-Z]{3}$/;

export function isIataAirportCode(value: string): value is IataAirportCode {
  return IATA_AIRPORT.test(value);
}

export function toIataAirportCode(value: string): IataAirportCode {
  const normalized = value.trim().toUpperCase();
  if (!isIataAirportCode(normalized)) {
    throw new TypeError(`Invalid IATA airport code: "${value}"`);
  }
  return normalized;
}

/**
 * Flight designator: 2-character airline code + 1-4 digit number + optional suffix,
 * e.g. "FO123" or "X9 4501A". Whitespace is removed.
 */
export type FlightNumber = string & { readonly __brand: 'FlightNumber' };

// IATA airline codes are two characters with at least one letter (e.g. "FO", "9F", "F1").
const FLIGHT_NUMBER = /^(?:[A-Z]{2}|[A-Z][0-9]|[0-9][A-Z])[0-9]{1,4}[A-Z]?$/;

export function toFlightNumber(value: string): FlightNumber {
  const normalized = value.replace(/\s+/g, '').toUpperCase();
  if (!FLIGHT_NUMBER.test(normalized)) {
    throw new TypeError(`Invalid flight number: "${value}"`);
  }
  return normalized as FlightNumber;
}
