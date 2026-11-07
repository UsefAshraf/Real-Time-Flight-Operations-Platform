import type { FlightStatus } from '@flightops/domain';

/** A row of flights.flights, as the application sees it. */
export interface FlightRecord {
  id: string;
  flightNumber: string;
  /** UTC date of the scheduled departure, 'YYYY-MM-DD'. */
  serviceDate: string;
  originIata: string;
  destinationIata: string;
  divertedToIata: string | null;
  status: FlightStatus;
  scheduledDeparture: Date;
  scheduledArrival: Date;
  estimatedDeparture: Date | null;
  estimatedArrival: Date | null;
  actualDeparture: Date | null;
  actualArrival: Date | null;
  departureGate: string | null;
  aircraftRegistration: string | null;
  delayMinutes: number;
  delayReason: string | null;
  version: number;
  updatedAt: Date;
}

/** SELECT list that maps snake_case columns straight onto FlightRecord. */
export const FLIGHT_COLUMNS = `
  id,
  flight_number         AS "flightNumber",
  service_date          AS "serviceDate",
  origin_iata           AS "originIata",
  destination_iata      AS "destinationIata",
  diverted_to_iata      AS "divertedToIata",
  status,
  scheduled_departure   AS "scheduledDeparture",
  scheduled_arrival     AS "scheduledArrival",
  estimated_departure   AS "estimatedDeparture",
  estimated_arrival     AS "estimatedArrival",
  actual_departure      AS "actualDeparture",
  actual_arrival        AS "actualArrival",
  departure_gate        AS "departureGate",
  aircraft_registration AS "aircraftRegistration",
  delay_minutes         AS "delayMinutes",
  delay_reason          AS "delayReason",
  version,
  updated_at            AS "updatedAt"`;

/** Fields a command may change. Keys map to columns through a fixed whitelist. */
export type FlightChanges = Partial<
  Pick<
    FlightRecord,
    | 'status'
    | 'estimatedDeparture'
    | 'estimatedArrival'
    | 'actualDeparture'
    | 'actualArrival'
    | 'departureGate'
    | 'delayMinutes'
    | 'delayReason'
    | 'divertedToIata'
  >
>;

export const CHANGE_COLUMNS: Readonly<Record<keyof FlightChanges, string>> = {
  status: 'status',
  estimatedDeparture: 'estimated_departure',
  estimatedArrival: 'estimated_arrival',
  actualDeparture: 'actual_departure',
  actualArrival: 'actual_arrival',
  departureGate: 'departure_gate',
  delayMinutes: 'delay_minutes',
  delayReason: 'delay_reason',
  divertedToIata: 'diverted_to_iata',
};
