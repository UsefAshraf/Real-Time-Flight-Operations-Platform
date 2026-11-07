import type { FlightStatus } from '@flightops/domain';
import type { Rng } from '@flightops/flights-core';
import { seatMap, type Aircraft, type Seat } from './reference-data.js';

const FIRST_NAMES = [
  'Ahmed',
  'Mohamed',
  'Omar',
  'Youssef',
  'Mahmoud',
  'Karim',
  'Hassan',
  'Mostafa',
  'Ali',
  'Tarek',
  'Nour',
  'Fatma',
  'Mariam',
  'Salma',
  'Yasmin',
  'Hana',
  'Laila',
  'Aya',
  'Rana',
  'Dina',
  'James',
  'Emma',
  'Lucas',
  'Sofia',
  'Noah',
  'Olivia',
  'Liam',
  'Mia',
  'Elias',
  'Chloe',
  'Arjun',
  'Priya',
  'Kenji',
  'Yuki',
  'Amara',
  'Kwame',
  'Lina',
  'Mateo',
  'Ines',
  'Leon',
];

const LAST_NAMES = [
  'Hassan',
  'Mostafa',
  'Ibrahim',
  'Abdelrahman',
  'Elsayed',
  'Farouk',
  'Mansour',
  'Salem',
  'Khalil',
  'Nasser',
  'Fawzy',
  'Gamal',
  'Saleh',
  'Haddad',
  'Aziz',
  'Rashid',
  'Smith',
  'Müller',
  'Rossi',
  'Dubois',
  'Garcia',
  'Jansen',
  'Novak',
  'Kowalski',
  'Sharma',
  'Tanaka',
  'Okafor',
  'Mensah',
  'Silva',
  'Andersson',
  'Petrov',
  'Yilmaz',
];

/** Weighted towards the hub's home market. */
const NATIONALITIES = [
  'EG',
  'EG',
  'EG',
  'EG',
  'EG',
  'SA',
  'AE',
  'JO',
  'GB',
  'DE',
  'FR',
  'IT',
  'US',
  'IN',
  'NG',
  'KE',
];

export interface Passenger {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  passportNumber: string;
  nationality: string;
}

const ascii = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function generatePassengers(count: number, rng: Rng): Passenger[] {
  return Array.from({ length: count }, (_, i) => {
    const firstName = rng.pick(FIRST_NAMES);
    const lastName = rng.pick(LAST_NAMES);
    return {
      id: rng.uuid(),
      firstName,
      lastName,
      // The index keeps emails unique; example.com is reserved for documentation (RFC 2606).
      email: `${ascii(firstName)}.${ascii(lastName)}.${i + 1}@example.com`,
      phone: `+20 1${rng.int(0, 2)}${rng.int(0, 9)} ${rng.int(100, 999)} ${rng.int(1000, 9999)}`,
      passportNumber: `${String.fromCharCode(65 + rng.int(0, 25))}${rng.int(10_000_000, 99_999_999)}`,
      nationality: rng.pick(NATIONALITIES),
    };
  });
}

export interface Booking {
  id: string;
  pnr: string;
  passengerId: string;
  flightId: string;
  seat: string;
  cabin: Seat['cabin'];
  status: 'CONFIRMED' | 'CHECKED_IN' | 'BOARDED';
}

export interface BookableFlight {
  id: string;
  status: FlightStatus;
  aircraftRegistration: string;
}

const PNR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.split(''); // ASCII only; no 0/O or 1/I

function pnr(rng: Rng): string {
  return Array.from({ length: 6 }, () => rng.pick(PNR_ALPHABET)).join('');
}

const BOARDED: ReadonlySet<FlightStatus> = new Set([
  'DEPARTED',
  'AIRBORNE',
  'DIVERTED',
  'LANDED',
  'ARRIVED',
]);

function bookingStatus(flight: BookableFlight): Booking['status'] {
  if (BOARDED.has(flight.status)) return 'BOARDED';
  if (flight.status === 'BOARDING') return 'CHECKED_IN';
  return 'CONFIRMED';
}

export interface BookingOptions {
  flights: readonly BookableFlight[];
  aircraft: readonly Aircraft[];
  passengerIds: readonly string[];
  minPerFlight: number;
  maxPerFlight: number;
  rng: Rng;
}

/** Each flight gets distinct passengers in distinct seats. */
export function generateBookings(options: BookingOptions): Booking[] {
  const { rng, passengerIds } = options;
  const seatMaps = new Map(options.aircraft.map((a) => [a.registration, seatMap(a)]));
  const bookings: Booking[] = [];

  for (const flight of options.flights) {
    const seats = [...(seatMaps.get(flight.aircraftRegistration) ?? [])];
    const count = Math.min(
      rng.int(options.minPerFlight, options.maxPerFlight),
      seats.length,
      passengerIds.length,
    );

    // Partial Fisher-Yates: the first `count` entries become a random sample of seats.
    for (let i = 0; i < count; i++) {
      const j = rng.int(i, seats.length - 1);
      [seats[i], seats[j]] = [seats[j] as Seat, seats[i] as Seat];
    }

    const chosen = new Set<string>();
    while (chosen.size < count) chosen.add(rng.pick(passengerIds));

    let i = 0;
    for (const passengerId of chosen) {
      const seat = seats[i] as Seat;
      i += 1;
      bookings.push({
        id: rng.uuid(),
        pnr: pnr(rng),
        passengerId,
        flightId: flight.id,
        seat: seat.seat,
        cabin: seat.cabin,
        status: bookingStatus(flight),
      });
    }
  }
  return bookings;
}
