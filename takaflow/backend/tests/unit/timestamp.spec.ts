import { describe, expect, it } from 'vitest';
import { asPgTimestamp, isPgTimestamp, toDate } from '../../src/shared/timestamp.js';

describe('Postgres timestamps', () => {
  it('parses the exact format Postgres renders', () => {
    // A space separator and a two-digit offset: neither is valid ISO 8601, and `new Date()`
    // returns Invalid Date for it rather than throwing. That silence disabled a time-window
    // check in production code once already.
    const value = asPgTimestamp('2026-08-29 06:58:31.848125+00');
    expect(toDate(value).toISOString()).toBe('2026-08-29T06:58:31.848Z');
  });

  it.each([
    ['2026-08-29 06:58:31.848125+00', '2026-08-29T06:58:31.848Z'],
    ['2026-08-29 06:58:31+00', '2026-08-29T06:58:31.000Z'],
    ['2026-08-29T06:58:31.848Z', '2026-08-29T06:58:31.848Z'],
    ['2026-08-29 12:58:31.5+06:00', '2026-08-29T06:58:31.500Z'],
    ['2026-08-29 12:28:31+0530', '2026-08-29T06:58:31.000Z'],
  ])('parses %s', (input, expected) => {
    expect(toDate(asPgTimestamp(input)).toISOString()).toBe(expected);
  });

  it('never returns an Invalid Date silently', () => {
    // The whole point: failure must be loud. A NaN date propagates into comparisons that then
    // evaluate to false, disabling checks with no error anywhere.
    expect(() => toDate('not-a-timestamp' as never)).toThrow(/Could not parse|Not a Postgres/);
  });

  it('rejects values that are not timestamps', () => {
    expect(() => asPgTimestamp('yesterday')).toThrow(/Not a Postgres timestamp/);
    expect(() => asPgTimestamp('')).toThrow();
    expect(isPgTimestamp('2026-08-29 06:58:31+00')).toBe(true);
    expect(isPgTimestamp(12345)).toBe(false);
  });

  it('preserves microseconds in the text form even though Date cannot', () => {
    const raw = '2026-08-29 06:58:31.848125+00';
    const value = asPgTimestamp(raw);
    // The string keeps all six digits — this is what gets sent back to the database.
    expect(value).toBe(raw);
    // The Date does not, which is exactly why the string is what round-trips.
    expect(toDate(value).toISOString()).not.toContain('848125');
  });
});
