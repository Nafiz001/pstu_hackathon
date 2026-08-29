/**
 * Property-based invariant testing.
 *
 * Every other test in this suite asserts something a human thought to check. This one generates
 * thousands of randomised operation sequences — transfers, requests, accepts, declines, cancels,
 * expiries, freezes — and after each batch asserts the four properties that must hold no matter
 * what happened:
 *
 *   1. total money is conserved                    (sum of all balances is zero)
 *   2. no user account is ever negative
 *   3. every balance equals the sum of its ledger entries
 *   4. every transfer is a complete, balanced double entry
 *
 * The generator is seeded, so a failure is reproducible: the seed is printed and re-running with
 * it replays the exact sequence.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, registerUser, type TestApp, type TestUser } from '../helpers/app.js';
import { assertBooksBalance, resetDatabase, totalBalance } from '../helpers/db.js';
import { closePool, query } from '../../src/platform/db/pool.js';
import { withTransaction } from '../../src/platform/db/transaction.js';
import { postDoubleEntry } from '../../src/modules/transfers/ledger.service.js';
import { reconcile } from '../../src/modules/admin/reconciliation.service.js';
import { drainOutbox } from '../../src/workers/outbox.dispatcher.js';
import { expireRequests } from '../../src/workers/request-expiry.worker.js';

let app: TestApp;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await closePool();
});

beforeEach(async () => {
  await resetDatabase();
});

/** Deterministic PRNG (mulberry32) so a failing run can be replayed from its seed. */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Harness {
  users: TestUser[];
  random: () => number;
  pick: <T>(items: T[]) => T;
  pickAmount: () => bigint;
}

const OPERATIONS = [
  'transfer',
  'transfer',
  'transfer', // weighted: transfers are the common case
  'overdraft-attempt',
  'self-transfer-attempt',
  'create-request',
  'accept-request',
  'decline-request',
  'cancel-request',
  'expire-requests',
  'freeze-account',
  'unfreeze-account',
  'drain-outbox',
] as const;

async function runOperation(h: Harness, operation: (typeof OPERATIONS)[number]): Promise<void> {
  const from = h.pick(h.users);
  const to = h.pick(h.users.filter((u) => u.id !== from.id));

  switch (operation) {
    case 'transfer':
      await withTransaction((tx) =>
        postDoubleEntry(tx, {
          fromAccountId: from.accountId,
          toAccountId: to.accountId,
          amountMinor: h.pickAmount(),
          type: 'P2P',
        }),
      ).catch(() => undefined); // insufficient funds / frozen are valid outcomes
      break;

    case 'overdraft-attempt':
      // Deliberately impossible: must never move money, must never make a balance negative.
      await withTransaction((tx) =>
        postDoubleEntry(tx, {
          fromAccountId: from.accountId,
          toAccountId: to.accountId,
          amountMinor: 900_000_000n,
          type: 'P2P',
        }),
      ).catch(() => undefined);
      break;

    case 'self-transfer-attempt':
      await withTransaction((tx) =>
        postDoubleEntry(tx, {
          fromAccountId: from.accountId,
          toAccountId: from.accountId,
          amountMinor: h.pickAmount(),
          type: 'P2P',
        }),
      ).catch(() => undefined);
      break;

    case 'create-request':
      await app.inject({
        method: 'POST',
        url: '/api/v1/requests',
        headers: {
          authorization: `Bearer ${from.accessToken}`,
          'idempotency-key': `prop-${Math.floor(h.random() * 1e12)}`,
        },
        payload: {
          fromPhone: to.phone,
          amountMinor: h.pickAmount().toString(),
          expiresInDays: 1,
        },
      });
      break;

    case 'accept-request':
    case 'decline-request':
    case 'cancel-request': {
      const { rows } = await query<{ id: string; payer_user_id: string; requester_user_id: string }>(
        "SELECT id, payer_user_id, requester_user_id FROM money_requests WHERE status = 'PENDING' LIMIT 5",
      );
      if (rows.length === 0) return;
      const target = rows[Math.floor(h.random() * rows.length)]!;

      if (operation === 'accept-request') {
        const payer = h.users.find((u) => u.id === target.payer_user_id);
        if (!payer) return;
        await app.inject({
          method: 'POST',
          url: `/api/v1/requests/${target.id}/accept`,
          headers: {
            authorization: `Bearer ${payer.accessToken}`,
            'idempotency-key': `prop-acc-${Math.floor(h.random() * 1e12)}`,
          },
          payload: { pin: payer.pin },
        });
        return;
      }

      const actorId =
        operation === 'decline-request' ? target.payer_user_id : target.requester_user_id;
      const actor = h.users.find((u) => u.id === actorId);
      if (!actor) return;
      await app.inject({
        method: 'POST',
        url: `/api/v1/requests/${target.id}/${operation === 'decline-request' ? 'decline' : 'cancel'}`,
        headers: { authorization: `Bearer ${actor.accessToken}` },
        payload: {},
      });
      break;
    }

    case 'expire-requests':
      // Age some requests, then let the worker sweep them.
      await query(
        `UPDATE money_requests SET expires_at = now() - interval '1 minute'
          WHERE status = 'PENDING' AND id IN (
            SELECT id FROM money_requests WHERE status = 'PENDING' LIMIT 2
          )`,
      );
      await expireRequests();
      break;

    case 'freeze-account':
      await query("UPDATE accounts SET status = 'FROZEN' WHERE user_id = $1", [from.id]);
      break;

    case 'unfreeze-account':
      await query("UPDATE accounts SET status = 'ACTIVE' WHERE user_id = $1", [from.id]);
      break;

    case 'drain-outbox':
      await drainOutbox(3);
      break;
  }
}

describe('randomised operation sequences preserve every money invariant', () => {
  it.each([1337, 90210, 8675309])(
    'holds over 400 random operations (seed %i)',
    async (seed) => {
      const random = makeRandom(seed);
      const users: TestUser[] = [];
      for (let i = 0; i < 6; i += 1) users.push(await registerUser(app));

      const startingTotal = await totalBalance();
      expect(startingTotal).toBe(0n);

      const h: Harness = {
        users,
        random,
        pick: (items) => items[Math.floor(random() * items.length)]!,
        // Amounts span the interesting boundaries: 1 poisha, and up to more than one account
        // holds, so overdraft paths are exercised alongside ordinary ones.
        pickAmount: () => BigInt(1 + Math.floor(random() * 3_000_000)),
      };

      for (let step = 0; step < 400; step += 1) {
        const operation = OPERATIONS[Math.floor(random() * OPERATIONS.length)]!;
        await runOperation(h, operation);

        // Check often enough to localise a failure to a handful of operations.
        if (step % 50 === 0) {
          const total = await totalBalance();
          expect(total, `money was created or destroyed at step ${step} (seed ${seed})`).toBe(0n);
        }
      }

      await drainOutbox();
      await assertBooksBalance();

      const report = await reconcile();
      expect(report.status, `reconciliation failed for seed ${seed}`).toBe('PASS');

      // Something must actually have happened, or the test proves nothing.
      expect(report.totals.transfers).toBeGreaterThan(users.length);
    },
    120_000,
  );

  it('never produces a negative user balance under randomised concurrency', async () => {
    const random = makeRandom(4242);
    const users: TestUser[] = [];
    for (let i = 0; i < 5; i += 1) users.push(await registerUser(app));

    // 300 concurrent movements between random pairs, amounts large enough that many must fail.
    await Promise.allSettled(
      Array.from({ length: 300 }, () => {
        const from = users[Math.floor(random() * users.length)]!;
        const to = users.filter((u) => u.id !== from.id)[
          Math.floor(random() * (users.length - 1))
        ]!;
        return withTransaction((tx) =>
          postDoubleEntry(tx, {
            fromAccountId: from.accountId,
            toAccountId: to.accountId,
            amountMinor: BigInt(1 + Math.floor(random() * 5_000_000)),
            type: 'P2P',
          }),
        );
      }),
    );

    const { rows } = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM accounts WHERE type = 'USER' AND balance_minor < 0",
    );
    expect(rows[0]!.count).toBe('0');
    await assertBooksBalance();

    const report = await reconcile();
    expect(report.status).toBe('PASS');
  }, 120_000);
});
