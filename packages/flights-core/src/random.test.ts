import { describe, expect, it } from 'vitest';
import { createRng } from './random.js';

describe('createRng', () => {
  it('is deterministic for a seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(
      Array.from({ length: 5 }, () => b.next()),
    );
  });

  it('keeps values in range', () => {
    const rng = createRng(1);
    for (let i = 0; i < 1_000; i++) {
      const v = rng.int(3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
    }
  });

  it('produces valid v4 UUIDs', () => {
    const rng = createRng(7);
    for (let i = 0; i < 100; i++) {
      expect(rng.uuid()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it('has a poisson mean close to the requested mean', () => {
    const rng = createRng(3);
    const samples = Array.from({ length: 5_000 }, () => rng.poisson(2.5));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeGreaterThan(2.3);
    expect(mean).toBeLessThan(2.7);
    expect(rng.poisson(0)).toBe(0);
  });
});
