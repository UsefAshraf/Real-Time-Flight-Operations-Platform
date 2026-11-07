/**
 * Small deterministic randomness toolkit for simulation and seeding. A fixed seed reproduces
 * the same schedule and the same disruptions, which makes bugs and load tests repeatable.
 */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** Random element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Poisson-distributed count with the given mean (Knuth; fine for small means). */
  poisson(mean: number): number;
  /** RFC 4122 version-4 UUID built from this generator. */
  uuid(): string;
}

/** mulberry32: tiny, fast, good enough statistical quality for simulation. */
export function createRng(seed: number = Date.now()): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));

  return {
    next,
    int,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new RangeError('pick() from an empty array');
      return items[int(0, items.length - 1)] as T;
    },
    chance: (p) => next() < p,
    poisson(mean) {
      if (mean <= 0) return 0;
      const limit = Math.exp(-mean);
      let k = 0;
      let p = 1;
      do {
        k += 1;
        p *= next();
      } while (p > limit);
      return k - 1;
    },
    uuid() {
      const bytes = Array.from({ length: 16 }, () => int(0, 255));
      bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
      bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
      const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
  };
}
