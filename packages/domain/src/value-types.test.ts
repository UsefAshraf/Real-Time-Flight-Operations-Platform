import { describe, expect, it } from 'vitest';
import { isIataAirportCode, toFlightNumber, toIataAirportCode } from './value-types.js';

describe('IATA airport codes', () => {
  it('normalises and accepts valid codes', () => {
    expect(toIataAirportCode(' cai ')).toBe('CAI');
    expect(isIataAirportCode('LHR')).toBe(true);
  });

  it.each(['CA', 'CAIR', 'C4I', ''])('rejects "%s"', (code) => {
    expect(() => toIataAirportCode(code)).toThrow(TypeError);
  });
});

describe('flight numbers', () => {
  it.each([
    ['fo123', 'FO123'],
    ['X9 4501A', 'X94501A'],
    ['9F1', '9F1'],
    ['F1 23', 'F123'],
  ])('normalises %s to %s', (input, expected) => {
    expect(toFlightNumber(input)).toBe(expected);
  });

  it.each(['1234', 'FO12345', 'FO', 'FO12AB', 'F-123'])('rejects "%s"', (input) => {
    expect(() => toFlightNumber(input)).toThrow(TypeError);
  });
});
