/**
 * Hot-account contention benchmark.
 *
 *   npx tsx scripts/bench-striping.ts [concurrency] [rounds]
 *
 * Measures the thing striping is supposed to fix. Every registration mints from the treasury,
 * and a mint takes a row lock, so with ONE treasury row every concurrent signup queues behind
 * every other one — the ledger is idle while the lock is the whole cost. With N stripes, two
 * mints collide only when they pick the same stripe.
 *
 * This measures the ledger primitive directly rather than the HTTP endpoint, because Argon2
 * password hashing (~50 ms, deliberately) would otherwise dominate and hide the effect being
 * measured. What is reported is lock contention, which is what changes.
 *
 * Runs against the TEST database and truncates it. Never point it at anything else.
 */
import { config, TREASURY_ACCOUNT_IDS } from '../src/config/index.js';
import { closePool, query } from '../src/platform/db/pool.js';
import { withTransaction } from '../src/platform/db/transaction.js';
import { postDoubleEntry } from '../src/modules/transfers/ledger.service.js';

const CONCURRENCY = Number(process.argv[2] ?? 120);
const ROUNDS = Number(process.argv[3] ?? 3);
const MINT_MINOR = 10_000_000n;

if (!/takaflow_test/.test(config.DATABASE_URL)) {
  console.error('Refusing to run: DATABASE_URL must point at takaflow_test.');
  process.exit(1);
}

async function reset(): Promise<void> {
  await query(
    `TRUNCATE audit_logs, notifications, outbox_events, refresh_tokens, money_requests,
              ledger_entries, transfers, idempotency_keys, accounts, users RESTART IDENTITY CASCADE`,
  );
  await query(
    `INSERT INTO accounts (id, user_id, type, status, balance_minor, shard_key)
     SELECT id, NULL, 'SYSTEM', 'ACTIVE', 0, ordinality
       FROM unnest($1::uuid[]) WITH ORDINALITY AS t(id, ordinality)`,
    [TREASURY_ACCOUNT_IDS],
  );
}

/** Pre-create the destination accounts so the benchmark measures only the mint. */
async function createTargets(count: number): Promise<string[]> {
  const { rows } = await query<{ id: string }>(
    `WITH new_users AS (
       INSERT INTO users (phone, name, password_hash, pin_hash)
       SELECT '019' || lpad(n::text, 8, '0'), 'Bench ' || n, 'x', 'y'
         FROM generate_series(1, $1) AS n
       RETURNING id
     )
     INSERT INTO accounts (user_id, type, status, balance_minor)
     SELECT id, 'USER', 'ACTIVE', 0 FROM new_users
     RETURNING id`,
    [count],
  );
  return rows.map((r) => r.id);
}

async function runRound(stripes: number, targets: string[]): Promise<number> {
  const started = performance.now();

  await Promise.all(
    targets.map((accountId, index) =>
      withTransaction((tx) =>
        postDoubleEntry(tx, {
          // The only variable: how many distinct treasury rows the writes spread across.
          fromAccountId: TREASURY_ACCOUNT_IDS[index % stripes]!,
          toAccountId: accountId,
          amountMinor: MINT_MINOR,
          type: 'MINT',
        }),
      ),
    ),
  );

  return performance.now() - started;
}

async function measure(stripes: number): Promise<{ meanMs: number; perSecond: number }> {
  const samples: number[] = [];

  for (let round = 0; round < ROUNDS; round += 1) {
    await reset();
    const targets = await createTargets(CONCURRENCY);
    samples.push(await runRound(stripes, targets));
  }

  const meanMs = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { meanMs, perSecond: (CONCURRENCY / meanMs) * 1000 };
}

async function main(): Promise<void> {
  console.log(
    `\nHot-account contention: ${CONCURRENCY} concurrent mints, ` +
      `best of ${ROUNDS} rounds, pool size ${config.PG_POOL_MAX}\n`,
  );

  const single = await measure(1);
  const striped = await measure(TREASURY_ACCOUNT_IDS.length);

  const row = (label: string, r: { meanMs: number; perSecond: number }) =>
    console.log(
      `  ${label.padEnd(28)} ${r.meanMs.toFixed(0).padStart(6)} ms   ` +
        `${r.perSecond.toFixed(0).padStart(5)} mints/s`,
    );

  row('1 treasury row (contended)', single);
  row(`${TREASURY_ACCOUNT_IDS.length} treasury stripes`, striped);

  const speedup = striped.perSecond / single.perSecond;
  console.log(`\n  Speed-up: ${speedup.toFixed(2)}x\n`);

  // Correctness is not optional just because this is a benchmark.
  const { rows } = await query<{ net: string }>(
    'SELECT COALESCE(SUM(balance_minor), 0)::text AS net FROM accounts',
  );
  console.log(`  Conservation check after benchmark: net = ${rows[0]!.net} (must be 0)\n`);

  await closePool();
  process.exit(rows[0]!.net === '0' ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await closePool().catch(() => undefined);
  process.exit(1);
});
