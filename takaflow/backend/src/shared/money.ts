/**
 * Money.
 *
 * One rule, enforced by the type system as far as TypeScript allows: amounts are BIGINT poisha
 * (1/100 of a Taka) and are represented as `bigint` in the application and as `string` on the
 * wire. There is no code path in this project where an amount is a JS `number`, because
 * Number.MAX_SAFE_INTEGER is 2^53 and float arithmetic is not associative — neither property is
 * acceptable for a ledger.
 *
 * `pg` is configured to return int8 as a string precisely so that this module is the only place
 * that decides how to widen it.
 */

export const POISHA_PER_TAKA = 100n;

/** Parse a value that arrived from Postgres (string), JSON (string), or code (bigint/number). */
export function toMinor(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined) {
    throw new TypeError('Expected a monetary amount, received null/undefined');
  }
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`Unsafe numeric amount: ${value}`);
    }
    return BigInt(value);
  }
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new TypeError(`Not an integer minor-unit amount: ${JSON.stringify(value)}`);
  }
  return BigInt(trimmed);
}

/** Human string for a minor-unit amount: 250000n -> "2,500.00". */
export function formatTaka(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const taka = abs / POISHA_PER_TAKA;
  const poisha = abs % POISHA_PER_TAKA;
  const grouped = taka.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${poisha.toString().padStart(2, '0')}`;
}

/** "2500.50" or "2500" -> 250050n. Rejects anything with more than two decimal places. */
export function takaToMinor(input: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match) {
    throw new TypeError(`Not a valid Taka amount: ${JSON.stringify(input)}`);
  }
  const [, sign, whole, fraction = '0'] = match;
  const poisha = BigInt(whole!) * POISHA_PER_TAKA + BigInt(fraction.padEnd(2, '0'));
  return sign === '-' ? -poisha : poisha;
}

/** The shape every amount takes when it crosses the API boundary. */
export interface MoneyDTO {
  minor: string;
  formatted: string;
  currency: 'BDT';
}

export function money(minor: bigint): MoneyDTO {
  return { minor: minor.toString(), formatted: formatTaka(minor), currency: 'BDT' };
}
