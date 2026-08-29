/**
 * The one property that matters: shares sum to EXACTLY the amount that was split. Every poisha
 * that goes missing here is somebody's money, and every extra one is money invented.
 */
import { describe, expect, it } from 'vitest';
import { allocateByWeight, allocateEvenly } from '../../src/shared/allocate.js';

const sum = (values: bigint[]) => values.reduce((total, value) => total + value, 0n);

describe('splitting evenly', () => {
  it('hands out the remainder rather than losing it', () => {
    // BDT 100.00 between three: 33.34 + 33.33 + 33.33, not 33.33 x 3.
    const shares = allocateEvenly(10_000n, 3);
    expect(shares).toEqual([3334n, 3333n, 3333n]);
    expect(sum(shares)).toBe(10_000n);
  });

  it('divides exactly when it can', () => {
    expect(allocateEvenly(9_000n, 3)).toEqual([3000n, 3000n, 3000n]);
  });

  it('never differs by more than one poisha between people', () => {
    const shares = allocateEvenly(10_001n, 7);
    expect(Number(shares[0]! - shares[shares.length - 1]!)).toBeLessThanOrEqual(1);
  });

  it('sums exactly for every amount and party size it could ever see', () => {
    for (let people = 1; people <= 20; people += 1) {
      for (const total of [1n, 7n, 99n, 100n, 10_000n, 123_457n, 5_000_000n]) {
        expect(sum(allocateEvenly(total, people))).toBe(total);
      }
    }
  });

  it('is deterministic, because an idempotent retry must replay byte-identically', () => {
    expect(allocateEvenly(10_000n, 3)).toEqual(allocateEvenly(10_000n, 3));
  });

  it('refuses nonsense instead of guessing', () => {
    expect(() => allocateEvenly(100n, 0)).toThrow(/nobody/);
    expect(() => allocateEvenly(-1n, 2)).toThrow(/negative/);
  });
});

describe('splitting by weight', () => {
  it('splits in proportion and still sums exactly', () => {
    // Someone ordered the expensive thing: 2 shares to 1 share to 1 share.
    const shares = allocateByWeight(10_000n, [2n, 1n, 1n]);
    expect(shares).toEqual([5000n, 2500n, 2500n]);
    expect(sum(shares)).toBe(10_000n);
  });

  it('gives the leftover poisha to the largest remainders', () => {
    const shares = allocateByWeight(100n, [1n, 1n, 1n]);
    expect(sum(shares)).toBe(100n);
    expect(shares).toEqual([34n, 33n, 33n]);
  });

  it('sums exactly across awkward weights', () => {
    for (const total of [1n, 101n, 9_999n, 1_000_003n]) {
      for (const weights of [[1n, 2n, 3n], [7n, 11n, 13n, 17n], [1n, 1n, 1n, 1n, 1n, 1n, 1n]]) {
        expect(sum(allocateByWeight(total, weights))).toBe(total);
      }
    }
  });

  it('falls back to an even split when every weight is zero', () => {
    expect(allocateByWeight(10n, [0n, 0n])).toEqual([5n, 5n]);
  });

  it('refuses a negative weight', () => {
    expect(() => allocateByWeight(100n, [1n, -1n])).toThrow(/negative/);
  });
});
