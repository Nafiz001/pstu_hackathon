/**
 * Scheduled and recurring transfers.
 *
 * The properties that matter, in order of how expensive they are to get wrong:
 *
 *   1. An occurrence is paid AT MOST once — under duplicate ticks, parallel replicas, and a
 *      schedule that is re-armed onto the same instant.
 *   2. A payment that cannot happen is recorded and retried, never silently dropped.
 *   3. A scheduler that was down does not fire a backlog of back-dated payments.
 *   4. The books balance after every one of the above.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeaders,
  createTestApp,
  newIdempotencyKey,
  registerUser,
  sendMoney,
  type TestApp,
  type TestUser,
} from '../helpers/app.js';
import { assertBooksBalance, countRows, resetDatabase, userBalance } from '../helpers/db.js';
import { closePool, query } from '../../src/platform/db/pool.js';
import { drainSchedules, runDueSchedules, runSchedule } from '../../src/workers/schedule.worker.js';
import { drainOutbox } from '../../src/workers/outbox.dispatcher.js';

const BONUS = 10_000_000n;
const TK = (taka: number) => BigInt(taka) * 100n;

let app: TestApp;
let rahim: TestUser;
let karim: TestUser;

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
});

interface ScheduleOptions {
  amountMinor?: bigint;
  intervalKind?: 'ONCE' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
  startAt?: Date;
  totalRuns?: number;
  note?: string;
  pin?: string;
  idempotencyKey?: string;
}

const createSchedule = (owner: TestUser, payee: TestUser, options: ScheduleOptions = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/schedules',
    headers: {
      ...authHeaders(owner),
      'idempotency-key': options.idempotencyKey ?? newIdempotencyKey('sched'),
    },
    payload: {
      toPhone: payee.phone,
      amountMinor: (options.amountMinor ?? TK(1500)).toString(),
      intervalKind: options.intervalKind ?? 'ONCE',
      // Default to the near future: a schedule may not start in the past.
      startAt: (options.startAt ?? new Date(Date.now() + 60_000)).toISOString(),
      ...(options.totalRuns !== undefined ? { totalRuns: options.totalRuns } : {}),
      ...(options.note !== undefined ? { note: options.note } : {}),
      pin: options.pin ?? owner.pin,
    },
  });

/** Bring a schedule's due time forward, as if the clock had advanced. */
const makeDue = (id: string, secondsAgo = 1) =>
  query(`UPDATE scheduled_transfers SET next_run_at = now() - ($2 || ' seconds')::interval
           WHERE id = $1`, [id, String(secondsAgo)]);

/** Let the backoff elapse, without changing WHICH occurrence is being retried. */
const clearBackoff = (id: string) =>
  query('UPDATE scheduled_transfers SET retry_after = NULL WHERE id = $1', [id]);

const scheduleRow = async (id: string) => {
  const { rows } = await query<{
    status: string;
    remaining_runs: number | null;
    next_run_at: Date;
  }>('SELECT status::text AS status, remaining_runs, next_run_at FROM scheduled_transfers WHERE id = $1', [id]);
  return rows[0]!;
};

const occurrences = async (scheduleId: string) => {
  const { rows } = await query<{ status: string; attempts: number; failure_reason: string | null }>(
    `SELECT status::text AS status, attempts, failure_reason
       FROM schedule_occurrences WHERE schedule_id = $1 ORDER BY due_at`,
    [scheduleId],
  );
  return rows;
};

describe('creating a schedule', () => {
  it('stores the instruction without moving any money', async () => {
    const response = await createSchedule(rahim, karim, { amountMinor: TK(1500), note: 'Rent' });

    expect(response.statusCode).toBe(201);
    expect(response.json().schedule).toMatchObject({
      status: 'ACTIVE',
      intervalKind: 'ONCE',
      note: 'Rent',
      payee: { name: 'Karim', phone: karim.phone },
    });
    expect(response.json().schedule.amount.formatted).toBe('1,500.00');

    // Nothing has been paid yet — the worker is the only thing that pays.
    expect(await userBalance(rahim.id)).toBe(BONUS);
    expect(await countRows('transfers', "WHERE type = 'SCHEDULED'")).toBe(0);
  });

  it('requires the PIN, refuses the past, and refuses paying yourself', async () => {
    expect((await createSchedule(rahim, karim, { pin: '0000' })).statusCode).toBe(401);

    const past = await createSchedule(rahim, karim, { startAt: new Date(Date.now() - 60_000) });
    expect(past.statusCode).toBe(400);

    const self = await createSchedule(rahim, rahim);
    expect(self.statusCode).toBe(422);
    expect(self.json().error.code).toBe('SELF_TRANSFER');
  });

  it('replays rather than creating twice on an idempotent retry', async () => {
    const key = newIdempotencyKey('sched-retry');
    // Same key AND same body: a retry is the same intent sent twice, not a new one.
    const startAt = new Date(Date.now() + 60_000);
    const first = await createSchedule(rahim, karim, { idempotencyKey: key, startAt });
    const retry = await createSchedule(rahim, karim, { idempotencyKey: key, startAt });

    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replay']).toBe('true');
    expect(retry.json()).toEqual(first.json());
    expect(await countRows('scheduled_transfers')).toBe(1);
  });

  it('lists a user’s own schedules and nobody else’s', async () => {
    await createSchedule(rahim, karim);
    await createSchedule(karim, rahim);

    const mine = await app.inject({
      method: 'GET',
      url: '/api/v1/schedules',
      headers: authHeaders(rahim),
    });

    expect(mine.json().items).toHaveLength(1);
    expect(mine.json().items[0].payee.phone).toBe(karim.phone);
  });
});

describe('running what is due', () => {
  it('pays a due schedule exactly once and records the occurrence', async () => {
    const id = (await createSchedule(rahim, karim, { amountMinor: TK(1500) })).json().schedule.id;
    await makeDue(id);

    const result = await runDueSchedules();

    expect(result).toMatchObject({ claimed: 1, paid: 1, failed: 0 });
    expect(await userBalance(rahim.id)).toBe(BONUS - TK(1500));
    expect(await userBalance(karim.id)).toBe(BONUS + TK(1500));
    expect(await countRows('transfers', "WHERE type = 'SCHEDULED'")).toBe(1);

    expect(await occurrences(id)).toEqual([
      expect.objectContaining({ status: 'PAID', attempts: 1 }),
    ]);
    // A one-off is finished, not merely quiet.
    expect((await scheduleRow(id)).status).toBe('COMPLETED');
    await assertBooksBalance();
  });

  it('ignores a schedule that is not due yet', async () => {
    const id = (await createSchedule(rahim, karim)).json().schedule.id;

    expect(await runDueSchedules()).toMatchObject({ claimed: 0, paid: 0 });
    expect(await userBalance(rahim.id)).toBe(BONUS);
    expect((await scheduleRow(id)).status).toBe('ACTIVE');
  });

  it('notifies both sides through the outbox', async () => {
    const id = (await createSchedule(rahim, karim, { amountMinor: TK(1500) })).json().schedule.id;
    await makeDue(id);
    await runDueSchedules();
    await drainOutbox();

    expect(
      await countRows('notifications', "WHERE user_id = $1 AND type = 'MONEY_RECEIVED'", [karim.id]),
    ).toBe(1);
    expect(
      await countRows('notifications', "WHERE user_id = $1 AND type = 'SCHEDULE_PAID'", [rahim.id]),
    ).toBe(1);
  });

  it('advances a recurring schedule by one interval and consumes one run', async () => {
    const id = (
      await createSchedule(rahim, karim, {
        amountMinor: TK(1000),
        intervalKind: 'DAILY',
        totalRuns: 3,
      })
    ).json().schedule.id;

    await makeDue(id);
    const before = (await scheduleRow(id)).next_run_at;
    await runDueSchedules();
    const after = await scheduleRow(id);

    expect(after.remaining_runs).toBe(2);
    expect(after.status).toBe('ACTIVE');
    // Exactly one day later than the occurrence that ran — not one day after "now", which would
    // let every late payment drag the whole series later.
    expect(after.next_run_at.getTime() - before.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(await userBalance(rahim.id)).toBe(BONUS - TK(1000));
  });

  it('completes a recurring schedule after its last run', async () => {
    const id = (
      await createSchedule(rahim, karim, {
        amountMinor: TK(1000),
        intervalKind: 'DAILY',
        totalRuns: 2,
      })
    ).json().schedule.id;

    for (let run = 0; run < 2; run += 1) {
      await makeDue(id);
      await runDueSchedules();
    }

    const row = await scheduleRow(id);
    expect(row.status).toBe('COMPLETED');
    expect(row.remaining_runs).toBe(0);
    expect(await userBalance(rahim.id)).toBe(BONUS - TK(2000));

    // Being due again changes nothing: a completed schedule is not claimable.
    await makeDue(id);
    expect(await runDueSchedules()).toMatchObject({ claimed: 0 });
    expect(await userBalance(rahim.id)).toBe(BONUS - TK(2000));
    await assertBooksBalance();
  });
});

describe('paying at most once', () => {
  it('does not pay twice when the same occurrence comes round again', async () => {
    const id = (await createSchedule(rahim, karim, { amountMinor: TK(1500) })).json().schedule.id;

    await makeDue(id);
    // The exact instant, at full precision, that this occurrence is due — which is what its key
    // is derived from.
    const { rows } = await query<{ next_run_at_raw: string }>(
      'SELECT next_run_at::text AS next_run_at_raw FROM scheduled_transfers WHERE id = $1',
      [id],
    );
    const dueAt = rows[0]!.next_run_at_raw;

    await runDueSchedules();
    expect(await userBalance(rahim.id)).toBe(BONUS - TK(1500));

    // Re-arm the schedule onto the EXACT instant it already paid for — the worst case, and what
    // a botched manual fix or a replayed backup would look like. The occurrence key is derived
    // from that instant, so the duplicate is recognised and refused.
    await query(
      `UPDATE scheduled_transfers
          SET status = 'ACTIVE', next_run_at = $2::timestamptz, remaining_runs = 1
        WHERE id = $1`,
      [id, dueAt],
    );

    expect(await runDueSchedules()).toMatchObject({ paid: 0, duplicate: 1 });
    expect(await userBalance(rahim.id)).toBe(BONUS - TK(1500));
    expect(await countRows('transfers', "WHERE type = 'SCHEDULED'")).toBe(1);
    await assertBooksBalance();
  });

  it('pays once when five replicas run the same schedule simultaneously', async () => {
    const id = (await createSchedule(rahim, karim, { amountMinor: TK(1500) })).json().schedule.id;
    await makeDue(id);

    // Exactly what N API replicas do on the same tick.
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => runSchedule(id)));

    expect(outcomes.filter((outcome) => outcome === 'paid')).toHaveLength(1);
    expect(await countRows('transfers', "WHERE type = 'SCHEDULED'")).toBe(1);
    expect(await countRows('schedule_occurrences')).toBe(1);
    expect(await userBalance(rahim.id)).toBe(BONUS - TK(1500));
    expect(await userBalance(karim.id)).toBe(BONUS + TK(1500));
    await assertBooksBalance();
  });
});

describe('when a scheduled payment cannot happen', () => {
  /** Spend Rahim down so a scheduled payment cannot be afforded. */
  const drainRahim = async (leave: bigint) => {
    const stranger = await registerUser(app);
    let balance = await userBalance(rahim.id);
    while (balance - leave > 0n) {
      const chunk = balance - leave > TK(25_000) ? TK(25_000) : balance - leave;
      const response = await sendMoney(app, rahim, stranger, chunk);
      expect(response.statusCode).toBe(201);
      balance = await userBalance(rahim.id);
    }
    expect(await userBalance(rahim.id)).toBe(leave);
  };

  it('defers rather than failing, and pays when the money arrives', async () => {
    const id = (await createSchedule(rahim, karim, { amountMinor: TK(1500) })).json().schedule.id;
    await drainRahim(TK(10));
    await makeDue(id);

    expect(await runDueSchedules()).toMatchObject({ paid: 0, deferred: 1, failed: 0 });

    // Nothing moved, and the occurrence is still open with its attempt recorded.
    expect(await userBalance(rahim.id)).toBe(TK(10));
    expect(await occurrences(id)).toEqual([
      expect.objectContaining({ status: 'PENDING', attempts: 1 }),
    ]);
    expect(await countRows('transfers', "WHERE type = 'SCHEDULED'")).toBe(0);

    // The salary lands, the backoff elapses, and the retry is the SAME occurrence — same key,
    // same row, one more attempt. Note it is `retry_after` that moved, never `next_run_at`.
    await sendMoney(app, karim, rahim, TK(5000));
    await clearBackoff(id);
    expect(await runDueSchedules()).toMatchObject({ paid: 1 });

    expect(await occurrences(id)).toEqual([
      expect.objectContaining({ status: 'PAID', attempts: 2 }),
    ]);
    expect(await countRows('transfers', "WHERE type = 'SCHEDULED'")).toBe(1);
    await assertBooksBalance();
  });

  it('gives up after the attempt limit and tells the owner', async () => {
    const id = (
      await createSchedule(rahim, karim, { amountMinor: TK(1500), intervalKind: 'DAILY' })
    ).json().schedule.id;
    await drainRahim(TK(10));

    await makeDue(id);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await clearBackoff(id);
      await runDueSchedules();
    }

    expect(await occurrences(id)).toEqual([
      expect.objectContaining({ status: 'FAILED', attempts: 3 }),
    ]);
    expect(await countRows('transfers', "WHERE type = 'SCHEDULED'")).toBe(0);

    // A failed occurrence does not kill the schedule — next month's rent should still go out.
    expect((await scheduleRow(id)).status).toBe('ACTIVE');

    await drainOutbox();
    expect(
      await countRows('notifications', "WHERE user_id = $1 AND type = 'SCHEDULE_FAILED'", [rahim.id]),
    ).toBe(1);
    await assertBooksBalance();
  });

  it('refuses to pay from a frozen account, and records why', async () => {
    const id = (await createSchedule(rahim, karim, { amountMinor: TK(1500) })).json().schedule.id;
    await query("UPDATE accounts SET status = 'FROZEN' WHERE user_id = $1", [rahim.id]);
    await makeDue(id);

    // Frozen is not transient, so it fails on the first attempt instead of retrying for hours.
    expect(await runDueSchedules()).toMatchObject({ failed: 1, deferred: 0 });
    expect(await occurrences(id)).toEqual([
      expect.objectContaining({ status: 'FAILED', attempts: 1 }),
    ]);
    expect(await userBalance(karim.id)).toBe(BONUS);
    await assertBooksBalance();
  });
});

describe('a scheduler that was down', () => {
  it('skips overdue occurrences instead of firing a backlog of payments', async () => {
    const id = (
      await createSchedule(rahim, karim, {
        amountMinor: TK(1000),
        intervalKind: 'DAILY',
        totalRuns: 5,
      })
    ).json().schedule.id;

    // Three and a half days of outage. The half-day offset matters: it puts every missed
    // occurrence outside the six-hour grace window and the next one in the future, so the
    // assertion below is about the policy and not about where "now" happened to land.
    await makeDue(id, 3.5 * 24 * 60 * 60);

    const result = await drainSchedules();

    // Every missed day is recorded as skipped, and not one of them takes money.
    expect(result.paid).toBe(0);
    expect(result.skipped).toBe(4);
    expect(await userBalance(rahim.id)).toBe(BONUS);
    expect(await countRows('transfers', "WHERE type = 'SCHEDULED'")).toBe(0);

    // The runs the user asked for were not consumed by days the service was not running.
    const row = await scheduleRow(id);
    expect(row.remaining_runs).toBe(5);
    expect(row.status).toBe('ACTIVE');
    expect(row.next_run_at.getTime()).toBeGreaterThan(Date.now());

    await drainOutbox();
    expect(
      await countRows('notifications', "WHERE user_id = $1 AND type = 'SCHEDULE_SKIPPED'", [rahim.id]),
    ).toBeGreaterThanOrEqual(3);
    await assertBooksBalance();
  });
});

describe('pausing, resuming and cancelling', () => {
  const act = (user: TestUser, id: string, action: 'pause' | 'resume') =>
    app.inject({
      method: 'POST',
      url: `/api/v1/schedules/${id}/${action}`,
      headers: authHeaders(user),
    });

  const cancel = (user: TestUser, id: string) =>
    app.inject({ method: 'DELETE', url: `/api/v1/schedules/${id}`, headers: authHeaders(user) });

  it('does not pay a paused schedule, and pays again once resumed', async () => {
    const id = (
      await createSchedule(rahim, karim, { amountMinor: TK(1000), intervalKind: 'DAILY' })
    ).json().schedule.id;

    expect((await act(rahim, id, 'pause')).json().schedule.status).toBe('PAUSED');
    await makeDue(id);
    expect(await runDueSchedules()).toMatchObject({ claimed: 0 });
    expect(await userBalance(rahim.id)).toBe(BONUS);

    expect((await act(rahim, id, 'resume')).json().schedule.status).toBe('ACTIVE');
    await makeDue(id);
    expect(await runDueSchedules()).toMatchObject({ paid: 1 });
    expect(await userBalance(rahim.id)).toBe(BONUS - TK(1000));
  });

  it('resuming does not back-date the payments that were missed while paused', async () => {
    const id = (
      await createSchedule(rahim, karim, { amountMinor: TK(1000), intervalKind: 'DAILY' })
    ).json().schedule.id;

    await act(rahim, id, 'pause');
    // A week goes by while it is paused.
    await query("UPDATE scheduled_transfers SET next_run_at = now() - interval '7 days' WHERE id = $1", [id]);

    await act(rahim, id, 'resume');

    // It starts again from now, so the seven days it spent paused cannot become seven payments.
    const row = await scheduleRow(id);
    expect(row.next_run_at.getTime()).toBeGreaterThan(Date.now() - 5_000);

    // Resuming does start it running: exactly one payment, for the occurrence that is due now.
    expect(await drainSchedules()).toMatchObject({ paid: 1, skipped: 0 });
    expect(await userBalance(rahim.id)).toBe(BONUS - TK(1000));
  });

  it('cancels, is idempotent about it, and never pays afterwards', async () => {
    const id = (await createSchedule(rahim, karim)).json().schedule.id;

    expect((await cancel(rahim, id)).json().schedule.status).toBe('CANCELLED');
    // Repeating a terminal action is success, not an error.
    expect((await cancel(rahim, id)).statusCode).toBe(200);
    // ...but a cancelled schedule cannot be resurrected.
    expect((await act(rahim, id, 'resume')).statusCode).toBe(409);

    await makeDue(id);
    expect(await runDueSchedules()).toMatchObject({ claimed: 0 });
    expect(await userBalance(rahim.id)).toBe(BONUS);
  });

  it('refuses to let anyone touch someone else’s schedule', async () => {
    const id = (await createSchedule(rahim, karim)).json().schedule.id;

    expect((await act(karim, id, 'pause')).statusCode).toBe(404);
    expect((await cancel(karim, id)).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/schedules/${id}`, headers: authHeaders(karim) }))
        .statusCode,
    ).toBe(404);
  });

  it('shows the owner what actually happened, occurrence by occurrence', async () => {
    const id = (
      await createSchedule(rahim, karim, { amountMinor: TK(1000), intervalKind: 'DAILY' })
    ).json().schedule.id;

    await makeDue(id);
    await runDueSchedules();

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/schedules/${id}`,
      headers: authHeaders(rahim),
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json().occurrences).toHaveLength(1);
    expect(detail.json().occurrences[0]).toMatchObject({ status: 'PAID', attempts: 1 });
    expect(detail.json().occurrences[0].transferReference).toMatch(/^TF/);
  });
});
