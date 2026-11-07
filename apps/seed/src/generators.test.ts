import { toFlightNumber } from '@flightops/domain';
import { createRng } from '@flightops/flights-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateBookings, generatePassengers } from './people.js';
import {
  HUB_IATA,
  generateFleet,
  generateTerminalsAndGates,
  loadAirports,
  seatMap,
  type Airport,
} from './reference-data.js';
import {
  allocateFrequencies,
  blockMinutesFor,
  buildRoutes,
  categoryForDistance,
  generateSchedule,
  haversineKm,
} from './schedule.js';
import { settleFlights } from './settle.js';

let airports: Airport[];
const fleet = generateFleet();

beforeAll(async () => {
  airports = await loadAirports();
});

const schedule = (seed = 42, flightsPerDay = 400, days = 2) =>
  generateSchedule({
    airports,
    fleet,
    startDate: '2026-11-06',
    days,
    flightsPerDay,
    rng: createRng(seed),
  });

describe('reference data', () => {
  it('loads valid airports including the hub', () => {
    expect(airports.length).toBeGreaterThan(30);
    expect(new Set(airports.map((a) => a.iata)).size).toBe(airports.length);
    expect(airports.find((a) => a.iata === HUB_IATA)?.city).toBe('Cairo');
  });

  it('creates gate codes unique per airport, with 60 at the hub', () => {
    const { gates } = generateTerminalsAndGates(airports, createRng(1));
    const keys = gates.map((g) => `${g.airportIata}:${g.code}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(gates.filter((g) => g.airportIata === HUB_IATA)).toHaveLength(60);
  });

  it('builds seat maps matching the seat count', () => {
    for (const aircraft of fleet) {
      const seats = seatMap(aircraft);
      expect(seats).toHaveLength(aircraft.seatCount);
      expect(new Set(seats.map((s) => s.seat)).size).toBe(aircraft.seatCount);
      expect(seats[0]?.cabin).toBe('BUSINESS');
    }
  });
});

describe('network', () => {
  it('computes realistic great-circle distances', () => {
    const cai = airports.find((a) => a.iata === 'CAI') as Airport;
    const lhr = airports.find((a) => a.iata === 'LHR') as Airport;
    expect(haversineKm(cai, lhr)).toBeGreaterThan(3_400);
    expect(haversineKm(cai, lhr)).toBeLessThan(3_600);
    expect(blockMinutesFor(3_500)).toBe(295);
    expect(categoryForDistance(3_500)).toBe('NARROWBODY');
  });

  it('connects the hub to every other airport', () => {
    const fromHub = buildRoutes(airports).filter((r) => r.originIata === HUB_IATA);
    expect(fromHub).toHaveLength(airports.length - 1);
  });

  it('allocates exactly the requested rotations', () => {
    const routes = buildRoutes(airports);
    for (const rotations of [10, routes.length, 1_000]) {
      const freqs = allocateFrequencies(routes, rotations);
      expect(freqs.reduce((a, b) => a + b, 0)).toBe(rotations);
    }
    expect(allocateFrequencies(routes, 1_000).every((f) => f >= 1)).toBe(true);
  });
});

describe('generateSchedule', () => {
  it('is deterministic for a seed', () => {
    expect(schedule(7)).toEqual(schedule(7));
    expect(schedule(7)).not.toEqual(schedule(8));
  });

  it('produces the requested volume of valid flights', () => {
    const flights = schedule(42, 400, 2);
    expect(flights).toHaveLength(800);
    for (const f of flights) {
      expect(toFlightNumber(f.flightNumber)).toBe(f.flightNumber);
      expect(f.scheduledArrival.getTime()).toBeGreaterThan(f.scheduledDeparture.getTime());
      expect(f.originIata).not.toBe(f.destinationIata);
      expect(f.serviceDate).toBe(f.scheduledDeparture.toISOString().slice(0, 10));
    }
  });

  it('never repeats a flight number on the same service date', () => {
    const flights = schedule(42, 2_000, 3);
    const keys = flights.map((f) => `${f.flightNumber}/${f.serviceDate}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('pairs every outbound with a return from the destination', () => {
    const flights = schedule(1, 100, 1);
    const byNumber = new Map(flights.map((f) => [f.flightNumber, f]));
    for (const f of flights.filter((x) => Number(x.flightNumber.slice(2)) % 2 === 1)) {
      const back = byNumber.get(`FO${Number(f.flightNumber.slice(2)) + 1}`);
      expect(back?.originIata).toBe(f.destinationIata);
      expect(back?.scheduledDeparture.getTime()).toBeGreaterThan(f.scheduledArrival.getTime());
    }
  });
});

describe('settleFlights', () => {
  const now = new Date('2026-11-07T12:00:00Z');

  it('puts flights into a state consistent with the clock', () => {
    const gates = new Map(airports.map((a) => [a.iata, ['A01', 'A02']]));
    const flights = settleFlights(schedule(3, 400, 2), {
      now,
      rng: createRng(3),
      gatesByAirport: gates,
    });
    const statuses = new Set(flights.map((f) => f.status));

    expect(statuses).toContain('ARRIVED');
    expect(statuses).toContain('SCHEDULED');
    expect(statuses).toContain('AIRBORNE');
    for (const f of flights) {
      if (f.status === 'ARRIVED') {
        expect(f.actualArrival?.getTime()).toBeLessThanOrEqual(now.getTime());
        expect(f.departureGate).not.toBeNull();
      }
      if (f.status === 'SCHEDULED') {
        expect(f.scheduledDeparture.getTime()).toBeGreaterThan(now.getTime());
      }
      if (f.delayMinutes > 0) expect(f.estimatedDeparture).not.toBeNull();
      if (f.actualDeparture) expect(f.actualDeparture.getTime()).toBeLessThanOrEqual(now.getTime());
    }
  });

  it('only disrupts flights inside the operational window', () => {
    const gates = new Map(airports.map((a) => [a.iata, ['A01']]));
    const flights = settleFlights(schedule(5, 400, 3), {
      now,
      rng: createRng(5),
      gatesByAirport: gates,
      delayProbability: 1,
    });
    const farFuture = flights.filter(
      (f) => f.scheduledDeparture.getTime() > now.getTime() + 3 * 3_600_000,
    );
    expect(farFuture.every((f) => f.status === 'SCHEDULED' && f.delayMinutes === 0)).toBe(true);
  });
});

describe('people', () => {
  it('generates unique passengers', () => {
    const passengers = generatePassengers(2_000, createRng(1));
    expect(new Set(passengers.map((p) => p.email)).size).toBe(2_000);
    expect(passengers[0]?.email).toMatch(/^[a-z]+\.[a-z]+\.1@example\.com$/);
  });

  it('never double-books a seat or a passenger on one flight', () => {
    const rng = createRng(9);
    const passengers = generatePassengers(500, rng);
    const flights = schedule(9, 100, 1).map((f) => ({ ...f, status: 'SCHEDULED' as const }));
    const bookings = generateBookings({
      flights,
      aircraft: fleet,
      passengerIds: passengers.map((p) => p.id),
      minPerFlight: 20,
      maxPerFlight: 60,
      rng,
    });
    const seats = bookings.map((b) => `${b.flightId}:${b.seat}`);
    const people = bookings.map((b) => `${b.flightId}:${b.passengerId}`);
    expect(new Set(seats).size).toBe(bookings.length);
    expect(new Set(people).size).toBe(bookings.length);
    expect(bookings.every((b) => /^[A-Z0-9]{6}$/.test(b.pnr))).toBe(true);
  });
});
