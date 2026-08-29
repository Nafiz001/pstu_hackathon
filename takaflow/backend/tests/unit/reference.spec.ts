import { describe, expect, it } from 'vitest';
import { generateReference, referenceDateRange } from '../../src/modules/transfers/ledger.service.js';

describe('transfer reference', () => {
  it('has the documented shape', () => {
    expect(generateReference(new Date('2026-08-29T10:00:00Z'))).toMatch(/^TF260829[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  it('encodes the date so a lookup can prune to one partition', () => {
    const reference = generateReference(new Date('2026-08-29T23:59:59Z'));
    const range = referenceDateRange(reference);
    expect(range).not.toBeNull();
    expect(range!.from.toISOString()).toBe('2026-08-29T00:00:00.000Z');
    expect(range!.to.toISOString()).toBe('2026-08-30T00:00:00.000Z');
  });

  it('rejects malformed references instead of guessing a range', () => {
    expect(referenceDateRange('nonsense')).toBeNull();
    expect(referenceDateRange('TF26082')).toBeNull();
    expect(referenceDateRange('XX260829ABCDEFGH')).toBeNull();
  });

  it('does not collide across a large batch on one day', () => {
    // 40 bits of entropy per day; 20k references should be collision-free in practice.
    const now = new Date('2026-08-29T10:00:00Z');
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) seen.add(generateReference(now));
    expect(seen.size).toBe(20_000);
  });

  it('uses the Crockford alphabet (no I, L, O or U to misread)', () => {
    const suffixes = Array.from({ length: 500 }, () => generateReference().slice(8)).join('');
    expect(suffixes).not.toMatch(/[ILOU]/);
  });
});
