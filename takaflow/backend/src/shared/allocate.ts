/**
 * Splitting an amount of money between people.
 *
 * BDT 100.00 between three people is 33.333... taka each, and that number does not exist in a
 * ledger. Three shares of 33.33 lose one poisha; three shares of 33.34 invent one. Neither is
 * acceptable — the shares of a split MUST sum to exactly the amount that was split, because the
 * difference is somebody's money and the books have to balance.
 *
 * The largest-remainder method: give everyone the floor of their share, then hand the leftover
 * poisha, one each, to the people whose remainders were largest. The result sums exactly, no
 * share differs from another by more than one poisha, and the outcome is deterministic — the same
 * input always produces the same allocation, which matters because an idempotent retry must
 * produce byte-identical results.
 */

/**
 * Split `totalMinor` into `count` shares.
 *
 * @returns shares in participant order, summing to exactly `totalMinor`.
 */
export function allocateEvenly(totalMinor: bigint, count: number): bigint[] {
  if (count <= 0) throw new Error('Cannot split between nobody');
  if (totalMinor < 0n) throw new Error('Cannot split a negative amount');

  const parts = BigInt(count);
  const base = totalMinor / parts;
  const remainder = Number(totalMinor % parts);

  // The first `remainder` participants get one extra poisha. Deterministic by position rather
  // than by a tie-break on equal remainders, which for an even split are all equal anyway.
  return Array.from({ length: count }, (_, index) =>
    index < remainder ? base + 1n : base,
  );
}

/**
 * Split `totalMinor` in proportion to `weights` (for "I ordered the expensive thing").
 *
 * Same guarantee: the shares sum to exactly `totalMinor`. Leftover poisha go to the largest
 * fractional remainders, and ties are broken by position so the result is reproducible.
 */
export function allocateByWeight(totalMinor: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) throw new Error('Cannot split between nobody');
  if (weights.some((weight) => weight < 0n)) throw new Error('A weight cannot be negative');

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
  if (totalWeight === 0n) return allocateEvenly(totalMinor, weights.length);

  // Integer arithmetic throughout: floor(total * weight / totalWeight), with the remainder kept
  // exactly rather than as a float that would round differently on different values.
  const shares = weights.map((weight) => (totalMinor * weight) / totalWeight);
  const remainders = weights.map((weight, index) => ({
    index,
    remainder: (totalMinor * weight) % totalWeight,
  }));

  let leftover = totalMinor - shares.reduce((sum, share) => sum + share, 0n);

  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );

  for (const { index } of remainders) {
    if (leftover <= 0n) break;
    shares[index] = shares[index]! + 1n;
    leftover -= 1n;
  }

  return shares;
}
