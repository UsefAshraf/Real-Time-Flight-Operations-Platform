import type { Rng } from '@flightops/flights-core';
import {
  AIRLINE_CODE,
  HUB_IATA,
  type Aircraft,
  type AircraftCategory,
  type Airport,
} from './reference-data.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export interface Route {
  originIata: string;
  destinationIata: string;
  distanceKm: number;
  blockMinutes: number;
  category: AircraftCategory;
  /** Relative share of daily frequencies. */
  weight: number;
}

/** Point-to-point leisure routes from Red Sea / Nile resorts to Europe. */
const LEISURE_ORIGINS = ['HRG', 'SSH', 'LXR'];
const LEISURE_DESTINATIONS = ['FRA', 'MUC', 'LHR', 'AMS', 'BRU', 'VIE'];

const WEIGHT: Record<AircraftCategory, number> = { REGIONAL: 6, NARROWBODY: 4, WIDEBODY: 1.5 };
const TURNAROUND_MINUTES: Record<AircraftCategory, number> = {
  REGIONAL: 40,
  NARROWBODY: 50,
  WIDEBODY: 90,
};

export function haversineKm(
  a: Pick<Airport, 'latitude' | 'longitude'>,
  b: Pick<Airport, 'latitude' | 'longitude'>,
) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371 * Math.asin(Math.sqrt(h));
}

export function categoryForDistance(km: number): AircraftCategory {
  if (km < 800) return 'REGIONAL';
  if (km < 4_500) return 'NARROWBODY';
  return 'WIDEBODY';
}

const roundUpTo5 = (minutes: number) => Math.ceil(minutes / 5) * 5;

/** Cruise at ~800 km/h plus 30 minutes for taxi, climb and approach. */
export function blockMinutesFor(km: number): number {
  return roundUpTo5((km / 800) * 60 + 30);
}

export function buildRoutes(airports: readonly Airport[]): Route[] {
  const byIata = new Map(airports.map((a) => [a.iata, a]));
  const hub = byIata.get(HUB_IATA);
  if (!hub) throw new Error(`Hub ${HUB_IATA} missing`);

  const pairs: [Airport, Airport][] = airports.filter((a) => a !== hub).map((a) => [hub, a]);
  for (const o of LEISURE_ORIGINS) {
    for (const d of LEISURE_DESTINATIONS) {
      const origin = byIata.get(o);
      const destination = byIata.get(d);
      if (origin && destination) pairs.push([origin, destination]);
    }
  }

  return pairs.map(([origin, destination]) => {
    const distanceKm = Math.round(haversineKm(origin, destination));
    const category = categoryForDistance(distanceKm);
    return {
      originIata: origin.iata,
      destinationIata: destination.iata,
      distanceKm,
      blockMinutes: blockMinutesFor(distanceKm),
      category,
      weight: WEIGHT[category],
    };
  });
}

/**
 * Split `rotations` daily round trips across routes: every route gets one while the budget
 * allows (heaviest first), the rest is shared by weight using the largest-remainder method.
 */
export function allocateFrequencies(routes: readonly Route[], rotations: number): number[] {
  const order = routes
    .map((_, i) => i)
    .sort((a, b) => (routes[b]?.weight ?? 0) - (routes[a]?.weight ?? 0));
  const result = routes.map(() => 0);
  let budget = rotations;
  for (const i of order) {
    if (budget === 0) break;
    result[i] = 1;
    budget -= 1;
  }
  if (budget === 0) return result;

  const totalWeight = routes.reduce((sum, r) => sum + r.weight, 0);
  const shares = routes.map((r) => (budget * r.weight) / totalWeight);
  shares.forEach((share, i) => (result[i] = (result[i] ?? 0) + Math.floor(share)));
  let remaining = budget - shares.reduce((sum, s) => sum + Math.floor(s), 0);
  const byRemainder = shares
    .map((share, i) => ({ i, rest: share - Math.floor(share) }))
    .sort((a, b) => b.rest - a.rest);
  for (const { i } of byRemainder) {
    if (remaining === 0) break;
    result[i] = (result[i] ?? 0) + 1;
    remaining -= 1;
  }
  return result;
}

export interface ScheduledFlight {
  id: string;
  flightNumber: string;
  serviceDate: string;
  originIata: string;
  destinationIata: string;
  scheduledDeparture: Date;
  scheduledArrival: Date;
  aircraftRegistration: string;
  category: AircraftCategory;
}

export interface ScheduleOptions {
  airports: readonly Airport[];
  fleet: readonly Aircraft[];
  /** First UTC service day, 'YYYY-MM-DD'. */
  startDate: string;
  days: number;
  flightsPerDay: number;
  rng: Rng;
}

interface Rotation {
  route: Route;
  outboundNumber: number;
  outboundMinute: number;
  returnMinute: number;
  aircraft: string;
}

/**
 * A repeating daily timetable: each rotation is an outbound flight and its return, with the
 * same flight numbers and times every day (like a real timetable). Times are UTC.
 *
 * Simplification: aircraft are assigned round-robin per category, so one tail can appear on
 * overlapping rotations. Tail routing is out of scope for this project.
 */
export function generateSchedule(options: ScheduleOptions): ScheduledFlight[] {
  const { rng } = options;
  const rotationsPerDay = Math.floor(options.flightsPerDay / 2);
  if (rotationsPerDay < 1) throw new RangeError('flightsPerDay must be at least 2');
  if (rotationsPerDay > 4_900)
    throw new RangeError('flightsPerDay too large for 4-digit flight numbers');

  const routes = buildRoutes(options.airports);
  const frequencies = allocateFrequencies(routes, rotationsPerDay);
  const fleetByCategory = new Map<AircraftCategory, string[]>();
  for (const a of options.fleet) {
    fleetByCategory.set(a.category, [...(fleetByCategory.get(a.category) ?? []), a.registration]);
  }
  const nextTail = new Map<AircraftCategory, number>();

  const WINDOW_START = 4 * 60; // first departures at 04:00 UTC
  const WINDOW = 19 * 60; // last around 23:00 UTC

  const rotations: Rotation[] = [];
  let number = 101;
  routes.forEach((route, i) => {
    const frequency = frequencies[i] ?? 0;
    const slot = WINDOW / Math.max(frequency, 1);
    const tails = fleetByCategory.get(route.category) ?? [];
    for (let k = 0; k < frequency; k++) {
      const jitter = (rng.next() - 0.5) * slot * 0.6;
      const outboundMinute = Math.round((WINDOW_START + slot * (k + 0.5) + jitter) / 5) * 5;
      const returnMinute = roundUpTo5(
        outboundMinute + route.blockMinutes + TURNAROUND_MINUTES[route.category],
      );
      const tailIndex = nextTail.get(route.category) ?? 0;
      nextTail.set(route.category, tailIndex + 1);
      rotations.push({
        route,
        outboundNumber: number,
        outboundMinute,
        returnMinute,
        aircraft: tails[tailIndex % tails.length] ?? '',
      });
      number += 2;
    }
  });

  const start = Date.parse(`${options.startDate}T00:00:00Z`);
  if (Number.isNaN(start)) throw new RangeError(`Invalid startDate ${options.startDate}`);

  const flights: ScheduledFlight[] = [];
  for (let day = 0; day < options.days; day++) {
    const dayStart = start + day * DAY;
    for (const r of rotations) {
      for (const [leg, minute, flightNumber] of [
        ['out', r.outboundMinute, r.outboundNumber],
        ['back', r.returnMinute, r.outboundNumber + 1],
      ] as const) {
        const departure = new Date(dayStart + minute * MINUTE);
        flights.push({
          id: rng.uuid(),
          flightNumber: `${AIRLINE_CODE}${flightNumber}`,
          serviceDate: departure.toISOString().slice(0, 10),
          originIata: leg === 'out' ? r.route.originIata : r.route.destinationIata,
          destinationIata: leg === 'out' ? r.route.destinationIata : r.route.originIata,
          scheduledDeparture: departure,
          scheduledArrival: new Date(departure.getTime() + r.route.blockMinutes * MINUTE),
          aircraftRegistration: r.aircraft,
          category: r.route.category,
        });
      }
    }
  }
  return flights;
}
