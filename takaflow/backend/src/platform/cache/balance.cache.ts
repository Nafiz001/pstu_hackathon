/**
 * Balance cache.
 *
 * The hard part of caching a balance is not the caching, it is the race: a reader that misses
 * the cache, reads the database, and is then descheduled can write a *stale* value over a newer
 * one published by a write that committed in the meantime. The cache would then serve a balance
 * that is wrong until its TTL expires — for a wallet screen, that is a support ticket.
 *
 * The fix is to make every cached value carry the `accounts.version` it came from, and to make
 * the write conditional on that version in a single atomic step. `accounts.version` increments
 * on every balance change, so "higher version wins" is a total order on the truth. A Lua script
 * gives the compare-and-set atomicity; two of them racing cannot interleave.
 *
 * Result: a stale writer loses, unconditionally, and the cache converges on the newest value it
 * has ever seen rather than the last one written to it.
 */
import { tryRedis } from './redis.js';

export interface CachedBalance {
  balanceMinor: bigint;
  version: bigint;
}

const TTL_SECONDS = 30;
const key = (accountId: string) => `bal:${accountId}`;

/**
 * SET only if the incoming version is newer than what is stored (or nothing is stored).
 * Returns 1 when the value was accepted, 0 when it was rejected as stale.
 */
const CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then
  local storedVersion = tonumber(string.match(current, '^(%d+):'))
  if storedVersion ~= nil and storedVersion >= tonumber(ARGV[1]) then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[1] .. ':' .. ARGV[2], 'EX', ARGV[3])
return 1
`;

export async function readBalance(accountId: string): Promise<CachedBalance | null> {
  return tryRedis(async (redis) => {
    const raw = await redis.get(key(accountId));
    if (!raw) return null;

    const separator = raw.indexOf(':');
    if (separator === -1) return null;

    const version = raw.slice(0, separator);
    const balance = raw.slice(separator + 1);
    if (!/^\d+$/.test(version) || !/^-?\d+$/.test(balance)) return null;

    return { version: BigInt(version), balanceMinor: BigInt(balance) };
  }, null);
}

/** Publish a balance. Rejected silently if a newer version is already cached. */
export async function writeBalance(
  accountId: string,
  value: CachedBalance,
): Promise<'stored' | 'stale' | 'unavailable'> {
  return tryRedis(async (redis) => {
    const stored = await redis.eval(
      CAS_SCRIPT,
      1,
      key(accountId),
      value.version.toString(),
      value.balanceMinor.toString(),
      String(TTL_SECONDS),
    );
    return stored === 1 ? ('stored' as const) : ('stale' as const);
  }, 'unavailable' as const);
}

/**
 * Drop a cached balance outright.
 *
 * Used where the new value is not known with its version — for instance after an administrative
 * change. Deleting is always safe; the next read repopulates from Postgres.
 */
export async function invalidateBalance(accountId: string): Promise<void> {
  await tryRedis(async (redis) => {
    await redis.del(key(accountId));
  }, undefined);
}
