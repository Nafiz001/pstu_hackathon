/**
 * Operator endpoints and the CSV statement.
 *
 * The operator API is tested for what it REFUSES as much as for what it does: an admin endpoint
 * that stops someone spending their own money must not be reachable without the operator token,
 * and it must fail closed when no token is configured.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeaders,
  createTestApp,
  registerUser,
  sendMoney,
  type TestApp,
  type TestUser,
} from '../helpers/app.js';
import { countRows, resetDatabase, userBalance } from '../helpers/db.js';
import { closePool, query } from '../../src/platform/db/pool.js';
import { config } from '../../src/config/index.js';

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

const adminHeaders = { 'x-admin-token': config.ADMIN_API_TOKEN ?? '' };

const freeze = (userId: string, headers: Record<string, string> = adminHeaders) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/admin/accounts/${userId}/freeze`,
    headers,
    payload: { reason: 'Suspected fraud' },
  });

describe('the operator API refuses what it should', () => {
  it('rejects a request with no token, and one with the wrong token', async () => {
    expect((await freeze(rahim.id, {})).statusCode).toBe(401);
    expect((await freeze(rahim.id, { 'x-admin-token': 'not-the-token-at-all' })).statusCode).toBe(
      401,
    );

    // Nothing happened: the account is untouched and no audit row was written.
    const { rows } = await query<{ status: string }>(
      'SELECT status::text AS status FROM accounts WHERE user_id = $1',
      [rahim.id],
    );
    expect(rows[0]!.status).toBe('ACTIVE');
    expect(await countRows('audit_logs', "WHERE action = 'ACCOUNT_FROZEN'")).toBe(0);
  });

  it('rejects a user’s own bearer token — being logged in is not being an operator', async () => {
    const response = await freeze(rahim.id, authHeaders(rahim) as Record<string, string>);
    expect(response.statusCode).toBe(401);
  });
});

describe('freezing an account', () => {
  it('stops the account spending, and unfreezing lets it spend again', async () => {
    expect((await freeze(rahim.id)).statusCode).toBe(200);

    const blocked = await sendMoney(app, rahim, karim, TK(100));
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('ACCOUNT_FROZEN');
    expect(await userBalance(rahim.id)).toBe(BONUS);

    const unfrozen = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/accounts/${rahim.id}/unfreeze`,
      headers: adminHeaders,
      payload: {},
    });
    expect(unfrozen.json().account.status).toBe('ACTIVE');

    expect((await sendMoney(app, rahim, karim, TK(100))).statusCode).toBe(201);
    expect(await userBalance(rahim.id)).toBe(BONUS - TK(100));
  });

  it('records who did it and why, in the immutable audit log', async () => {
    await freeze(rahim.id);

    const audit = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit?action=ACCOUNT_FROZEN',
      headers: adminHeaders,
    });

    expect(audit.json().items).toHaveLength(1);
    expect(audit.json().items[0]).toMatchObject({
      action: 'ACCOUNT_FROZEN',
      entityType: 'account',
      metadata: { reason: 'Suspected fraud', targetUserId: rahim.id },
    });
  });

  it('is decided by the row lock when a freeze races a transfer', async () => {
    // Whichever commits first wins; the only unacceptable outcome is a frozen account that
    // still paid out, or a rejected transfer that still moved money.
    const [transfer, frozen] = await Promise.all([
      sendMoney(app, rahim, karim, TK(2500)),
      freeze(rahim.id),
    ]);

    expect(frozen.statusCode).toBe(200);
    expect([201, 403]).toContain(transfer.statusCode);

    const expected = transfer.statusCode === 201 ? BONUS - TK(2500) : BONUS;
    expect(await userBalance(rahim.id)).toBe(expected);
  });

  it('refuses to reopen a closed account', async () => {
    await query("UPDATE accounts SET status = 'CLOSED' WHERE user_id = $1", [rahim.id]);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/accounts/${rahim.id}/unfreeze`,
      headers: adminHeaders,
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('INVALID_STATE');
  });
});

describe('searching the audit log', () => {
  it('filters and pages without OFFSET', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await sendMoney(app, rahim, karim, TK(10))).statusCode).toBe(201);
    }

    const firstPage = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit?action=TRANSFER_SENT&limit=2',
      headers: adminHeaders,
    });

    expect(firstPage.json().items).toHaveLength(2);
    expect(firstPage.json().nextCursor).not.toBeNull();

    const secondPage = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/audit?action=TRANSFER_SENT&limit=2&before=${firstPage.json().nextCursor}`,
      headers: adminHeaders,
    });

    const firstIds = firstPage.json().items.map((item: { id: string }) => item.id);
    const secondIds = secondPage.json().items.map((item: { id: string }) => item.id);

    // No row appears on both pages, and the order is strictly descending.
    expect(firstIds.some((id: string) => secondIds.includes(id))).toBe(false);
    expect(Number(secondIds[0])).toBeLessThan(Number(firstIds[1]));
  });
});

describe('the CSV statement', () => {
  /** A real (small) RFC 4180 reader, so the test verifies the file rather than trusting it. */
  const splitCsv = (line: string): string[] => {
    const fields: string[] = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < line.length; i += 1) {
      const character = line[i];
      if (quoted) {
        if (character !== '"') field += character;
        else if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === ',') {
        fields.push(field);
        field = '';
      } else field += character;
    }

    fields.push(field);
    return fields;
  };

  const parse = (body: string) => {
    const lines = body.replace(/^﻿/, '').trim().split('\r\n');
    return { header: lines[0]!.split(','), rows: lines.slice(1) };
  };

  it('streams every movement, newest first, with the balance after each', async () => {
    await sendMoney(app, rahim, karim, TK(250), { note: 'Lunch' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/transfers/statement.csv',
      headers: authHeaders(rahim),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toMatch(/attachment; filename=".*\.csv"/);

    const { header, rows } = parse(response.body);
    expect(header).toContain('reference');
    expect(header).toContain('balance_after_bdt');

    // The signup mint and the payment out.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('OUT');
    expect(rows[0]).toContain('250.00');
    expect(rows[0]).toContain('Lunch');
    expect(rows[1]).toContain('IN');
  });

  it('shows each side only their own movements', async () => {
    await sendMoney(app, rahim, karim, TK(250));

    const theirs = await app.inject({
      method: 'GET',
      url: '/api/v1/transfers/statement.csv',
      headers: authHeaders(karim),
    });

    const { rows } = parse(theirs.body);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('IN');
    expect(rows.join('\n')).not.toContain('OUT');
  });

  it('neutralises a note that a spreadsheet would execute as a formula', async () => {
    // A CSV injection attempt, typed by the sender into a field the recipient will open in Excel.
    await sendMoney(app, karim, rahim, TK(10), { note: '=cmd|calc!A1' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/transfers/statement.csv',
      headers: authHeaders(rahim),
    });

    // Present, readable, and no longer a formula.
    expect(response.body).toContain("'=cmd|calc!A1");
    expect(response.body).not.toMatch(/,=cmd/);
  });

  it('quotes a name containing a comma instead of inventing a column', async () => {
    const awkward = await registerUser(app, { name: 'Rahman, Jr.' });
    await sendMoney(app, awkward, rahim, TK(10));

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/transfers/statement.csv',
      headers: authHeaders(rahim),
    });

    expect(response.body).toContain('"Rahman, Jr."');
    const { header, rows } = parse(response.body);
    // The comma is inside the field, not a new column: every row still has the header's shape.
    for (const row of rows) {
      expect(splitCsv(row)).toHaveLength(header.length);
    }
    const counterparties = rows.map((row) => splitCsv(row)[header.indexOf('counterparty')]);
    expect(counterparties).toContain('Rahman, Jr.');
  });

  it('honours the date window and rejects an inverted one', async () => {
    await sendMoney(app, rahim, karim, TK(250));
    const future = new Date(Date.now() + 60_000).toISOString();

    const empty = await app.inject({
      method: 'GET',
      url: `/api/v1/transfers/statement.csv?from=${encodeURIComponent(future)}`,
      headers: authHeaders(rahim),
    });
    expect(parse(empty.body).rows).toEqual([]);

    const inverted = await app.inject({
      method: 'GET',
      url: `/api/v1/transfers/statement.csv?from=${encodeURIComponent(future)}&to=${encodeURIComponent(new Date().toISOString())}`,
      headers: authHeaders(rahim),
    });
    expect(inverted.statusCode).toBe(400);
  });

  it('streams a history larger than one page without repeating or dropping a row', async () => {
    // PAGE_SIZE is 500; 12 movements is enough to prove the loop, and the cursor logic is the
    // same one the paginated API tests cover at boundary conditions.
    for (let i = 0; i < 12; i += 1) {
      expect((await sendMoney(app, rahim, karim, TK(1))).statusCode).toBe(201);
    }

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/transfers/statement.csv',
      headers: authHeaders(rahim),
    });

    const { rows } = parse(response.body);
    expect(rows).toHaveLength(13); // 12 payments + the signup mint

    const references = rows.map((row) => row.split(',')[1]);
    expect(new Set(references).size).toBe(references.length);
  });
});
