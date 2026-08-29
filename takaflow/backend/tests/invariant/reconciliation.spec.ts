/**
 * The reconciliation endpoint is the system's own claim about itself. These tests check two
 * things: that it passes on a healthy system after real work, and — more importantly — that it
 * actually FAILS when the books are broken. An invariant checker that cannot fail proves
 * nothing, so each check is verified against deliberately corrupted data.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptRequest,
  createRequest,
  createTestApp,
  registerUser,
  sendMoney,
  type TestApp,
  type TestUser,
} from '../helpers/app.js';
import { resetDatabase } from '../helpers/db.js';
import { closePool, query } from '../../src/platform/db/pool.js';
import { reconcile } from '../../src/modules/admin/reconciliation.service.js';
import { drainOutbox } from '../../src/workers/outbox.dispatcher.js';

const TK = (taka: number) => BigInt(taka) * 100n;

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

const checkNamed = (report: Awaited<ReturnType<typeof reconcile>>, name: string) => {
  const check = report.checks.find((c) => c.name === name);
  if (!check) throw new Error(`no check named ${name}`);
  return check;
};

describe('a healthy system', () => {
  it('passes all four invariants on an empty system', async () => {
    const report = await reconcile();
    expect(report.status).toBe('PASS');
    expect(report.checks.map((c) => c.status)).toEqual(['PASS', 'PASS', 'PASS', 'PASS']);
  });

  it('passes after a randomised workload of transfers and requests', async () => {
    const users: TestUser[] = [];
    for (let i = 0; i < 8; i += 1) users.push(await registerUser(app));

    // A deterministic pseudo-random walk: enough variety to be interesting, reproducible enough
    // to debug when it fails.
    let seed = 42;
    const next = (bound: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };

    for (let i = 0; i < 60; i += 1) {
      const from = users[next(users.length)]!;
      const to = users[next(users.length)]!;
      if (from.id === to.id) continue;

      if (next(3) === 0) {
        const created = await createRequest(app, to, from, TK(100 + next(400)));
        if (created.statusCode === 201 && next(2) === 0) {
          await acceptRequest(app, from, created.json().request.id);
        }
      } else {
        await sendMoney(app, from, to, TK(100 + next(900)));
      }
    }

    await drainOutbox();

    const report = await reconcile();
    expect(report.status).toBe('PASS');
    expect(report.totals.net).toBe('0.00');
    expect(report.totals.transfers).toBeGreaterThan(8);
    expect(report.totals.ledgerEntries).toBe(report.totals.transfers * 2);
  });

  it('reports totals that add up', async () => {
    const rahim = await registerUser(app);
    const karim = await registerUser(app);
    await sendMoney(app, rahim, karim, TK(2500));

    const report = await reconcile();
    expect(report.totals.userMoney).toBe('200,000.00');
    expect(report.totals.treasury).toBe('-200,000.00');
    expect(report.totals.net).toBe('0.00');
  });
});

describe('a broken system — the checker must actually catch it', () => {
  it('catches money created out of nothing', async () => {
    const rahim = await registerUser(app);
    // Simulate the exact bug the whole design exists to prevent: a balance edited without a
    // matching ledger entry.
    await query('UPDATE accounts SET balance_minor = balance_minor + 100000 WHERE user_id = $1', [
      rahim.id,
    ]);

    const report = await reconcile();
    expect(report.status).toBe('FAIL');
    expect(checkNamed(report, 'conservation_of_money').status).toBe('FAIL');
    expect(checkNamed(report, 'balances_match_ledger').status).toBe('FAIL');
    expect(checkNamed(report, 'balances_match_ledger').violations).toHaveLength(1);
  });

  it('catches a balance that has drifted from its ledger', async () => {
    const rahim = await registerUser(app);
    const karim = await registerUser(app);
    await sendMoney(app, rahim, karim, TK(2500));

    // Move money between two accounts without touching the ledger: conservation still holds,
    // but the ledger no longer explains either balance. Invariant #1 alone would miss this.
    await query('UPDATE accounts SET balance_minor = balance_minor - 500 WHERE user_id = $1', [rahim.id]);
    await query('UPDATE accounts SET balance_minor = balance_minor + 500 WHERE user_id = $1', [karim.id]);

    const report = await reconcile();
    expect(checkNamed(report, 'conservation_of_money').status).toBe('PASS');
    expect(checkNamed(report, 'balances_match_ledger').status).toBe('FAIL');
    expect(checkNamed(report, 'balances_match_ledger').violations).toHaveLength(2);
    expect(report.status).toBe('FAIL');
  });

  it('catches a half-written double entry', async () => {
    const rahim = await registerUser(app);
    const karim = await registerUser(app);
    const sent = await sendMoney(app, rahim, karim, TK(2500));

    // The ledger is append-only, so a row cannot be deleted through the application. Drop the
    // trigger to inject the corruption a catastrophic bug would have to cause.
    await query('ALTER TABLE ledger_entries DISABLE TRIGGER ledger_immutable');
    await query(
      `DELETE FROM ledger_entries
        WHERE direction = 'CREDIT'
          AND transfer_id = (SELECT id FROM transfers WHERE reference = $1)`,
      [sent.json().transfer.reference],
    );
    await query('ALTER TABLE ledger_entries ENABLE TRIGGER ledger_immutable');

    const report = await reconcile();
    expect(checkNamed(report, 'double_entry_complete').status).toBe('FAIL');
    expect(checkNamed(report, 'double_entry_complete').violations[0]).toMatchObject({
      reason: 'entry count is 1',
    });
  });

  it('catches a negative user balance', async () => {
    const rahim = await registerUser(app);
    // The CHECK constraint makes this impossible through any normal path, so the constraint
    // itself has to be lifted to prove the checker would notice.
    await query('ALTER TABLE accounts DROP CONSTRAINT non_negative_user_balance');
    await query('UPDATE accounts SET balance_minor = -1 WHERE user_id = $1', [rahim.id]);

    const report = await reconcile();
    expect(checkNamed(report, 'no_orphans').status).toBe('FAIL');
    expect(checkNamed(report, 'no_orphans').violations[0]).toMatchObject({
      kind: 'negative_user_balance',
    });

    await query(
      `ALTER TABLE accounts ADD CONSTRAINT non_negative_user_balance
       CHECK (type = 'SYSTEM' OR balance_minor >= 0) NOT VALID`,
    );
  });
});

describe('GET /admin/reconciliation', () => {
  it('returns 200 and PASS on a healthy system', async () => {
    await registerUser(app);
    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/reconciliation' });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('PASS');
    expect(response.json().checks).toHaveLength(4);
    for (const check of response.json().checks) {
      expect(check).toMatchObject({ status: 'PASS' });
      expect(check.claim).toBeTypeOf('string');
    }
  });

  it('returns 500 when an invariant is broken, so a monitor cannot miss it', async () => {
    const rahim = await registerUser(app);
    await query('UPDATE accounts SET balance_minor = balance_minor + 1 WHERE user_id = $1', [rahim.id]);

    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/reconciliation' });
    expect(response.statusCode).toBe(500);
    expect(response.json().status).toBe('FAIL');
  });
});
