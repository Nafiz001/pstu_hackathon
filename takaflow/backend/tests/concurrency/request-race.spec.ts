/**
 * C4/C5 — races through the money-request state machine.
 *
 * Every transition is a guarded statement, so these races are resolved by the database rather
 * than by a read-then-write window in application code. The property: whatever the interleaving,
 * a request settles at most once.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptRequest,
  authHeaders,
  createRequest,
  createTestApp,
  registerUser,
  type TestApp,
  type TestUser,
} from '../helpers/app.js';
import { assertBooksBalance, countRows, resetDatabase, userBalance } from '../helpers/db.js';
import { closePool, query } from '../../src/platform/db/pool.js';

const BONUS = 10_000_000n;
const TK = (taka: number) => BigInt(taka) * 100n;

let app: TestApp;
let karim: TestUser; // requester
let rahim: TestUser; // payer

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await closePool();
});

beforeEach(async () => {
  await resetDatabase();
  karim = await registerUser(app, { name: 'Karim' });
  rahim = await registerUser(app, { name: 'Rahim' });
});

describe('C4 — two accepts at once', () => {
  it('settles exactly once when the payer double-taps', async () => {
    const created = await createRequest(app, karim, rahim, TK(1200));
    const id = created.json().request.id;

    // Different idempotency keys: this is genuinely two intents racing, not one retried.
    const [first, second] = await Promise.all([
      acceptRequest(app, rahim, id),
      acceptRequest(app, rahim, id),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 409]);

    const loser = first.statusCode === 409 ? first : second;
    expect(loser.json().error.code).toBe('INVALID_STATE');

    expect(await countRows('transfers', "WHERE type = 'REQUEST_SETTLEMENT'")).toBe(1);
    expect(await userBalance(rahim.id)).toBe(BONUS - TK(1200));
    expect(await userBalance(karim.id)).toBe(BONUS + TK(1200));
    await assertBooksBalance();
  });

  it('settles exactly once under ten simultaneous accepts', async () => {
    const created = await createRequest(app, karim, rahim, TK(1200));
    const id = created.json().request.id;

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => acceptRequest(app, rahim, id)),
    );

    // A failing race is only debuggable if the failure says what it actually saw.
    const summary = responses
      .map((r) => `${r.statusCode}${r.statusCode === 200 ? '' : `:${r.json().error?.code}:${r.json().error?.message}`}`)
      .join(' ');

    expect(responses.filter((r) => r.statusCode === 200), summary).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode !== 200).length, summary).toBe(9);
    expect(await countRows('transfers', "WHERE type = 'REQUEST_SETTLEMENT'")).toBe(1);
    expect(await userBalance(rahim.id)).toBe(BONUS - TK(1200));
    await assertBooksBalance();
  });
});

describe('C5 — accept racing cancel and decline', () => {
  it('either settles or terminates, never both', async () => {
    const created = await createRequest(app, karim, rahim, TK(1200));
    const id = created.json().request.id;

    const [accepted, cancelled] = await Promise.all([
      acceptRequest(app, rahim, id),
      app.inject({
        method: 'POST',
        url: `/api/v1/requests/${id}/cancel`,
        headers: authHeaders(karim),
      }),
    ]);

    const { rows } = await query<{ status: string; settled_transfer_id: string | null }>(
      'SELECT status, settled_transfer_id FROM money_requests WHERE id = $1',
      [id],
    );
    const finalStatus = rows[0]!.status;

    if (finalStatus === 'ACCEPTED') {
      expect(accepted.statusCode).toBe(200);
      expect(rows[0]!.settled_transfer_id).not.toBeNull();
      expect(await countRows('transfers', "WHERE type = 'REQUEST_SETTLEMENT'")).toBe(1);
      expect(await userBalance(rahim.id)).toBe(BONUS - TK(1200));
    } else {
      expect(finalStatus).toBe('CANCELLED');
      expect(rows[0]!.settled_transfer_id).toBeNull();
      // The loser must not have moved money on its way to losing.
      expect(await countRows('transfers', "WHERE type = 'REQUEST_SETTLEMENT'")).toBe(0);
      expect(await userBalance(rahim.id)).toBe(BONUS);
      expect(cancelled.statusCode).toBe(200);
    }

    await assertBooksBalance();
  });

  it('holds under repeated accept/decline races', async () => {
    for (let round = 0; round < 8; round += 1) {
      const created = await createRequest(app, karim, rahim, TK(100));
      const id = created.json().request.id;

      await Promise.all([
        acceptRequest(app, rahim, id),
        app.inject({
          method: 'POST',
          url: `/api/v1/requests/${id}/decline`,
          headers: authHeaders(rahim),
          payload: {},
        }),
      ]);

      const { rows } = await query<{ status: string; settled_transfer_id: string | null }>(
        'SELECT status, settled_transfer_id FROM money_requests WHERE id = $1',
        [id],
      );
      // A settled request always has its transfer; an unsettled one never does.
      expect(['ACCEPTED', 'DECLINED']).toContain(rows[0]!.status);
      expect(rows[0]!.status === 'ACCEPTED').toBe(rows[0]!.settled_transfer_id !== null);
    }

    // One settlement per accepted request, and the books balance across all eight rounds.
    const settled = await countRows('money_requests', "WHERE status = 'ACCEPTED'");
    expect(await countRows('transfers', "WHERE type = 'REQUEST_SETTLEMENT'")).toBe(settled);
    await assertBooksBalance();
  });
});

describe('concurrent requests between the same pair', () => {
  it('settles many independent requests without losing money', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const created = await createRequest(app, karim, rahim, TK(1000));
      ids.push(created.json().request.id);
    }

    await Promise.all(ids.map((id) => acceptRequest(app, rahim, id)));

    // Retry any that were shed under back-pressure. Accepting is idempotent per request, so this
    // is safe and makes the assertion about settlement rather than about scheduling luck.
    for (const id of ids) {
      const { rows } = await query<{ status: string }>(
        'SELECT status FROM money_requests WHERE id = $1',
        [id],
      );
      if (rows[0]?.status === 'PENDING') await acceptRequest(app, rahim, id);
    }

    const settled = await countRows('money_requests', "WHERE status = 'ACCEPTED'");
    expect(settled).toBe(12);
    // One settlement per accepted request, and the money follows exactly.
    expect(await countRows('transfers', "WHERE type = 'REQUEST_SETTLEMENT'")).toBe(settled);
    expect(await userBalance(rahim.id)).toBe(BONUS - TK(12_000));
    expect(await userBalance(karim.id)).toBe(BONUS + TK(12_000));
    await assertBooksBalance();
  });
});
