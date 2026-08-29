/**
 * Split bill.
 *
 * What is actually being tested: the shares add up to the bill, a split is all-or-nothing, and a
 * leg behaves exactly like any other money request once it exists — including when several
 * people pay at the same moment.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptRequest,
  authHeaders,
  createTestApp,
  newIdempotencyKey,
  registerUser,
  type TestApp,
  type TestUser,
} from '../helpers/app.js';
import { assertBooksBalance, countRows, resetDatabase, userBalance } from '../helpers/db.js';
import { closePool } from '../../src/platform/db/pool.js';
import { drainOutbox } from '../../src/workers/outbox.dispatcher.js';

const BONUS = 10_000_000n;
const TK = (taka: number) => BigInt(taka) * 100n;

let app: TestApp;
let rahim: TestUser;
let karim: TestUser;
let salma: TestUser;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await closePool();
});

beforeEach(async () => {
  await resetDatabase();
  rahim = await registerUser(app, { name: 'Rahim' });
  karim = await registerUser(app, { name: 'Karim' });
  salma = await registerUser(app, { name: 'Salma' });
});

interface SplitOptions {
  totalAmountMinor?: bigint;
  description?: string;
  participants?: Array<{ phone: string; weight?: number }>;
  includeSelf?: boolean;
  selfWeight?: number;
  idempotencyKey?: string;
}

const createSplit = (creator: TestUser, options: SplitOptions = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/splits',
    headers: {
      ...authHeaders(creator),
      'idempotency-key': options.idempotencyKey ?? newIdempotencyKey('split'),
    },
    payload: {
      totalAmountMinor: (options.totalAmountMinor ?? TK(1200)).toString(),
      description: options.description ?? 'Dinner at Star',
      participants: options.participants ?? [{ phone: karim.phone }, { phone: salma.phone }],
      ...(options.includeSelf !== undefined ? { includeSelf: options.includeSelf } : {}),
      ...(options.selfWeight !== undefined ? { selfWeight: options.selfWeight } : {}),
    },
  });

const getSplit = (viewer: TestUser, id: string) =>
  app.inject({ method: 'GET', url: `/api/v1/splits/${id}`, headers: authHeaders(viewer) });

describe('creating a split', () => {
  it('divides the bill so the shares add up to it exactly', async () => {
    // BDT 100.00 three ways is the case that loses a poisha if anyone uses floats.
    const response = await createSplit(rahim, { totalAmountMinor: 10_000n });

    expect(response.statusCode).toBe(201);
    const split = response.json().split;

    expect(split.total.formatted).toBe('100.00');
    expect(split.yourShare.minor).toBe('3334');
    expect(split.legs.map((leg: { amount: { minor: string } }) => leg.amount.minor)).toEqual([
      '3333',
      '3333',
    ]);

    // The whole point: nothing is lost and nothing is invented.
    const legTotal = split.legs.reduce(
      (sum: bigint, leg: { amount: { minor: string } }) => sum + BigInt(leg.amount.minor),
      0n,
    );
    expect(legTotal + BigInt(split.yourShare.minor)).toBe(10_000n);
  });

  it('splits by weight when someone ordered the expensive thing', async () => {
    const response = await createSplit(rahim, {
      totalAmountMinor: TK(1200),
      participants: [
        { phone: karim.phone, weight: 2 },
        { phone: salma.phone, weight: 1 },
      ],
      selfWeight: 1,
    });

    const split = response.json().split;
    // 4 weight units over 120,000 poisha: 30,000 for Rahim, 60,000 for Karim, 30,000 for Salma.
    expect(split.yourShare.minor).toBe('30000');
    expect(split.legs.map((leg: { amount: { minor: string } }) => leg.amount.minor)).toEqual([
      '60000',
      '30000',
    ]);
  });

  it('leaves the creator out when they are not part of the bill', async () => {
    const response = await createSplit(rahim, {
      totalAmountMinor: TK(1000),
      includeSelf: false,
    });

    const split = response.json().split;
    expect(split.yourShare.minor).toBe('0');
    expect(split.requested.minor).toBe(TK(1000).toString());
    expect(split.legs).toHaveLength(2);
  });

  it('creates one money request per participant, and no money moves', async () => {
    const response = await createSplit(rahim);

    expect(await countRows('money_requests', 'WHERE split_id IS NOT NULL')).toBe(2);
    expect(await userBalance(rahim.id)).toBe(BONUS);
    expect(await userBalance(karim.id)).toBe(BONUS);

    // A leg is an ordinary request: the payer sees it in their inbox like any other.
    const inbox = await app.inject({
      method: 'GET',
      url: '/api/v1/requests?role=incoming',
      headers: authHeaders(karim),
    });
    expect(inbox.json().items).toHaveLength(1);
    expect(inbox.json().items[0].amount.minor).toBe(
      response.json().split.legs[0].amount.minor,
    );
  });

  it('notifies every participant', async () => {
    await createSplit(rahim);
    await drainOutbox();

    for (const payer of [karim, salma]) {
      expect(
        await countRows('notifications', "WHERE user_id = $1 AND type = 'REQUEST_RECEIVED'", [
          payer.id,
        ]),
      ).toBe(1);
    }
  });
});

describe('a split is all-or-nothing', () => {
  it('creates nothing at all when one participant does not exist', async () => {
    const response = await createSplit(rahim, {
      participants: [{ phone: karim.phone }, { phone: '01799999999' }],
    });

    expect(response.statusCode).toBe(404);
    // Not one leg, not one header row — half a split would be worse than none.
    expect(await countRows('bill_splits')).toBe(0);
    expect(await countRows('money_requests')).toBe(0);
  });

  it('refuses a duplicate participant and a share below the minimum', async () => {
    const duplicate = await createSplit(rahim, {
      participants: [{ phone: karim.phone }, { phone: karim.phone }],
    });
    expect(duplicate.statusCode).toBe(400);

    // BDT 1.00 between three people is 33 poisha each, below the minimum transfer.
    const tiny = await createSplit(rahim, { totalAmountMinor: 100n });
    expect(tiny.statusCode).toBe(400);
    expect(tiny.json().error.message).toMatch(/at least/);

    expect(await countRows('bill_splits')).toBe(0);
  });

  it('refuses to bill yourself twice', async () => {
    const response = await createSplit(rahim, {
      participants: [{ phone: karim.phone }, { phone: rahim.phone }],
    });
    expect(response.statusCode).toBe(400);
    expect(await countRows('bill_splits')).toBe(0);
  });

  it('replays rather than creating a second split on a retry', async () => {
    const key = newIdempotencyKey('split-retry');
    const first = await createSplit(rahim, { idempotencyKey: key });
    const retry = await createSplit(rahim, { idempotencyKey: key });

    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replay']).toBe('true');
    expect(retry.json()).toEqual(first.json());
    expect(await countRows('bill_splits')).toBe(1);
    expect(await countRows('money_requests')).toBe(2);
  });
});

describe('collecting a split', () => {
  it('settles each leg independently and tracks what is still owed', async () => {
    const split = (await createSplit(rahim, { totalAmountMinor: TK(1200) })).json().split;
    const share = BigInt(split.legs[0].amount.minor);

    await acceptRequest(app, karim, split.legs[0].requestId);

    const view = (await getSplit(rahim, split.id)).json().split;
    expect(view.collected.minor).toBe(share.toString());
    expect(view.outstanding.minor).toBe(share.toString());
    expect(view.legs.filter((leg: { status: string }) => leg.status === 'ACCEPTED')).toHaveLength(1);

    expect(await userBalance(karim.id)).toBe(BONUS - share);
    expect(await userBalance(rahim.id)).toBe(BONUS + share);
    await assertBooksBalance();
  });

  it('collects exactly the requested total when everyone pays at once', async () => {
    const split = (await createSplit(rahim, { totalAmountMinor: TK(1200) })).json().split;

    // Both payers tap at the same instant. Each leg is a separate row, so they settle in
    // parallel — but the creator's account is contended, which is the interesting part.
    const responses = await Promise.all([
      acceptRequest(app, karim, split.legs[0].requestId),
      acceptRequest(app, salma, split.legs[1].requestId),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);

    const view = (await getSplit(rahim, split.id)).json().split;
    expect(view.collected.minor).toBe(view.requested.minor);
    expect(view.outstanding.minor).toBe('0');

    // Rahim is made whole for everything except his own share.
    expect(await userBalance(rahim.id)).toBe(BONUS + BigInt(view.requested.minor));
    await assertBooksBalance();
  });

  it('does not pay a leg twice when the payer double-taps', async () => {
    const split = (await createSplit(rahim, { totalAmountMinor: TK(1200) })).json().split;
    const requestId = split.legs[0].requestId;

    const responses = await Promise.all([
      acceptRequest(app, karim, requestId),
      acceptRequest(app, karim, requestId),
    ]);

    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(await countRows('transfers', "WHERE type = 'REQUEST_SETTLEMENT'")).toBe(1);
    await assertBooksBalance();
  });

  it('shows a split to the people in it and to nobody else', async () => {
    const split = (await createSplit(rahim, { participants: [{ phone: karim.phone }] })).json()
      .split;
    const stranger = await registerUser(app);

    expect((await getSplit(rahim, split.id)).statusCode).toBe(200);
    expect((await getSplit(karim, split.id)).statusCode).toBe(200);
    expect((await getSplit(stranger, split.id)).statusCode).toBe(404);
  });

  it('lists the creator’s splits with their collection progress', async () => {
    const split = (await createSplit(rahim, { totalAmountMinor: TK(1200) })).json().split;
    await acceptRequest(app, karim, split.legs[0].requestId);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/splits',
      headers: authHeaders(rahim),
    });

    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).toMatchObject({
      description: 'Dinner at Star',
      settledCount: 1,
      legCount: 2,
    });
    expect(list.json().items[0].outstanding.minor).toBe(split.legs[1].amount.minor);
  });
});
