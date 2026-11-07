import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from '@flightops/config';
import type { Rng } from '@flightops/flights-core';

/** The network is hub-and-spoke around Cairo. */
export const HUB_IATA = 'CAI';
/** Fictional airline used for all seeded flights. */
export const AIRLINE_CODE = 'FO';

const airportSchema = z.object({
  iata: z.string().regex(/^[A-Z]{3}$/),
  icao: z.string().regex(/^[A-Z]{4}$/),
  name: z.string(),
  city: z.string(),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  timezone: z.string(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export type Airport = z.infer<typeof airportSchema>;

export const AIRPORTS_FILE = fileURLToPath(new URL('../data/airports.json', import.meta.url));

/** Curated subset of the public OurAirports dataset (coordinates rounded). */
export async function loadAirports(file = AIRPORTS_FILE): Promise<Airport[]> {
  const airports = z.array(airportSchema).parse(JSON.parse(await readFile(file, 'utf8')));
  if (!airports.some((a) => a.iata === HUB_IATA)) throw new Error(`Hub ${HUB_IATA} missing`);
  return airports;
}

export interface Terminal {
  id: string;
  airportIata: string;
  code: string;
  name: string;
}

export interface Gate {
  id: string;
  terminalId: string;
  airportIata: string;
  code: string;
}

/** The hub gets three terminals of 20 gates; outstations one terminal of 8-16 gates. */
export function generateTerminalsAndGates(airports: readonly Airport[], rng: Rng) {
  const terminals: Terminal[] = [];
  const gates: Gate[] = [];
  for (const airport of airports) {
    const isHub = airport.iata === HUB_IATA;
    const layout = isHub
      ? [
          { code: 'T1', piers: ['A'], gates: 20 },
          { code: 'T2', piers: ['B'], gates: 20 },
          { code: 'T3', piers: ['C'], gates: 20 },
        ]
      : [{ code: 'T1', piers: ['A'], gates: rng.int(8, 16) }];
    for (const t of layout) {
      const terminal: Terminal = {
        id: rng.uuid(),
        airportIata: airport.iata,
        code: t.code,
        name: `Terminal ${t.code.slice(1)}`,
      };
      terminals.push(terminal);
      for (const pier of t.piers) {
        for (let n = 1; n <= t.gates; n++) {
          gates.push({
            id: rng.uuid(),
            terminalId: terminal.id,
            airportIata: airport.iata,
            code: `${pier}${String(n).padStart(2, '0')}`,
          });
        }
      }
    }
  }
  return { terminals, gates };
}

export type AircraftCategory = 'REGIONAL' | 'NARROWBODY' | 'WIDEBODY';

export interface Aircraft {
  registration: string;
  typeCode: string;
  model: string;
  category: AircraftCategory;
  seatCount: number;
}

interface FleetSpec extends Omit<Aircraft, 'registration'> {
  count: number;
  prefix: string;
}

const FLEET: readonly FleetSpec[] = [
  {
    typeCode: 'E190',
    model: 'Embraer E190',
    category: 'REGIONAL',
    seatCount: 100,
    count: 12,
    prefix: 'E',
  },
  {
    typeCode: 'A20N',
    model: 'Airbus A320neo',
    category: 'NARROWBODY',
    seatCount: 168,
    count: 30,
    prefix: 'N',
  },
  {
    typeCode: 'B38M',
    model: 'Boeing 737 MAX 8',
    category: 'NARROWBODY',
    seatCount: 174,
    count: 20,
    prefix: 'M',
  },
  {
    typeCode: 'A333',
    model: 'Airbus A330-300',
    category: 'WIDEBODY',
    seatCount: 301,
    count: 10,
    prefix: 'A',
  },
  {
    typeCode: 'B789',
    model: 'Boeing 787-9',
    category: 'WIDEBODY',
    seatCount: 290,
    count: 8,
    prefix: 'D',
  },
  {
    typeCode: 'B77W',
    model: 'Boeing 777-300ER',
    category: 'WIDEBODY',
    seatCount: 346,
    count: 6,
    prefix: 'W',
  },
];

/** Fictional registrations such as FO-N07. */
export function generateFleet(): Aircraft[] {
  return FLEET.flatMap(({ count, prefix, ...spec }) =>
    Array.from({ length: count }, (_, i) => ({
      ...spec,
      registration: `FO-${prefix}${String(i + 1).padStart(2, '0')}`,
    })),
  );
}

const SEAT_LAYOUT: Record<AircraftCategory, { letters: string; businessRows: number }> = {
  REGIONAL: { letters: 'ACDF', businessRows: 3 },
  NARROWBODY: { letters: 'ABCDEF', businessRows: 3 },
  WIDEBODY: { letters: 'ABCDEFGHK', businessRows: 6 },
};

export interface Seat {
  seat: string;
  cabin: 'BUSINESS' | 'ECONOMY';
}

export function seatMap(aircraft: Pick<Aircraft, 'category' | 'seatCount'>): Seat[] {
  const { letters, businessRows } = SEAT_LAYOUT[aircraft.category];
  const seats: Seat[] = [];
  for (let row = 1; seats.length < aircraft.seatCount; row++) {
    for (const letter of letters) {
      if (seats.length === aircraft.seatCount) break;
      seats.push({ seat: `${row}${letter}`, cabin: row <= businessRows ? 'BUSINESS' : 'ECONOMY' });
    }
  }
  return seats;
}
