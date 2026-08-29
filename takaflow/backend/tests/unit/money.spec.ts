import { describe, expect, it } from 'vitest';
import { formatTaka, money, takaToMinor, toMinor } from '../../src/shared/money.js';

describe('money', () => {
  describe('toMinor', () => {
    it('accepts the string form Postgres returns for BIGINT', () => {
      expect(toMinor('10000000')).toBe(10_000_000n);
      expect(toMinor('0')).toBe(0n);
      expect(toMinor('-500')).toBe(-500n);
    });

    it('preserves values beyond Number.MAX_SAFE_INTEGER', () => {
      // The entire reason int8 is parsed as a string: this value cannot survive a float64.
      const huge = '9007199254740993'; // 2^53 + 1
      expect(toMinor(huge).toString()).toBe(huge);
      expect(Number(huge).toString()).not.toBe(huge);
    });

    it('rejects anything that is not an integer', () => {
      expect(() => toMinor('12.5')).toThrow(/integer minor-unit/);
      expect(() => toMinor('1e5')).toThrow();
      expect(() => toMinor('abc')).toThrow();
      expect(() => toMinor('')).toThrow();
      expect(() => toMinor(1.5)).toThrow(/Unsafe numeric/);
      expect(() => toMinor(null)).toThrow();
      expect(() => toMinor(undefined)).toThrow();
    });
  });

  describe('formatTaka', () => {
    it('formats minor units with grouping and two decimals', () => {
      expect(formatTaka(10_000_000n)).toBe('100,000.00');
      expect(formatTaka(250_000n)).toBe('2,500.00');
      expect(formatTaka(120_000n)).toBe('1,200.00');
      expect(formatTaka(1n)).toBe('0.01');
      expect(formatTaka(0n)).toBe('0.00');
      expect(formatTaka(-10_000_000n)).toBe('-100,000.00');
    });

    it('never loses a poisha', () => {
      expect(formatTaka(99n)).toBe('0.99');
      expect(formatTaka(101n)).toBe('1.01');
      expect(formatTaka(100_000_000_000n)).toBe('1,000,000,000.00');
    });
  });

  describe('takaToMinor', () => {
    it('parses whole and fractional Taka', () => {
      expect(takaToMinor('2500')).toBe(250_000n);
      expect(takaToMinor('2500.50')).toBe(250_050n);
      expect(takaToMinor('0.05')).toBe(5n);
      expect(takaToMinor('0.5')).toBe(50n);
    });

    it('rejects sub-poisha precision rather than rounding it away', () => {
      expect(() => takaToMinor('1.005')).toThrow();
      expect(() => takaToMinor('1.2345')).toThrow();
    });

    it('round-trips through formatTaka', () => {
      for (const value of ['0.01', '1.00', '2,500.00'.replace(/,/g, ''), '99,999.99'.replace(/,/g, '')]) {
        expect(formatTaka(takaToMinor(value))).toBe(
          Number(value).toLocaleString('en-US', { minimumFractionDigits: 2 }),
        );
      }
    });
  });

  describe('money DTO', () => {
    it('sends amounts over the wire as strings, never numbers', () => {
      const dto = money(10_000_000n);
      expect(dto).toEqual({ minor: '10000000', formatted: '100,000.00', currency: 'BDT' });
      expect(typeof dto.minor).toBe('string');
      expect(JSON.parse(JSON.stringify(dto)).minor).toBe('10000000');
    });
  });
});
