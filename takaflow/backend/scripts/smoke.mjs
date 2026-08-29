/**
 * End-to-end smoke test against a RUNNING stack (not the test suite).
 *
 * The test suite drives the app in-process; this drives it through nginx, three API replicas,
 * PgBouncer and Toxiproxy, over real HTTP — so it catches the things in-process tests cannot:
 * routing, load-balanced session handling, replica reads, and the operator guard.
 *
 *   node scripts/smoke.mjs                          # against the compose stack on :18090
 *   BASE=http://127.0.0.1:3000/api/v1 node scripts/smoke.mjs   # against a local `npm run dev`
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:18090/api/v1';
const ADMIN = 'local-operator-token-change-me';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};
const uid = Date.now().toString().slice(-7);
const phone = (n) => `018${String(n).padStart(8, '0')}`;

async function call(path, { method = 'GET', body, token, key, admin } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers['idempotency-key'] = key;
  if (admin) headers['x-admin-token'] = ADMIN;
  const response = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers };
}

const register = async (name, n) => {
  const p = phone(`${uid}${n}`.slice(-8));
  const r = await call('/auth/register', { method: 'POST', body: { phone: p, name, password: 'correct-horse-battery', pin: '1234' } });
  if (r.status !== 201) throw new Error(`register ${name}: ${r.status} ${JSON.stringify(r.body)}`);
  return { ...r.body, phone: p, pin: '1234' };
};

const rahim = await register('Rahim Smoke', 1);
const karim = await register('Karim Smoke', 2);
const salma = await register('Salma Smoke', 3);
check('register + signup mint', BigInt(rahim.account.balance.minor) === 10_000_000n, rahim.account.balance.formatted);

const key = crypto.randomUUID();
const [a, b] = await Promise.all([
  call('/transfers', { method: 'POST', token: rahim.accessToken, key, body: { toPhone: karim.phone, amountMinor: '250000', pin: '1234', note: 'Smoke' } }),
  call('/transfers', { method: 'POST', token: rahim.accessToken, key, body: { toPhone: karim.phone, amountMinor: '250000', pin: '1234', note: 'Smoke' } }),
]);
check('double-submit is one payment', a.status === 201 && b.status === 201 && a.body.transfer.reference === b.body.transfer.reference, a.body?.transfer?.reference);

const me = await call('/accounts/me', { token: rahim.accessToken });
check('balance after one payment', me.body.account.balance.minor === '9750000', me.body.account.balance.formatted);

const req = await call('/requests', { method: 'POST', token: karim.accessToken, key: crypto.randomUUID(), body: { fromPhone: rahim.phone, amountMinor: '120000', note: 'Owed' } });
check('create request', req.status === 201);
const accepted = await call(`/requests/${req.body.request.id}/accept`, { method: 'POST', token: rahim.accessToken, key: crypto.randomUUID(), body: { pin: '1234' } });
check('accept request settles', accepted.status === 200, accepted.body?.balance?.formatted);

const split = await call('/splits', { method: 'POST', token: rahim.accessToken, key: crypto.randomUUID(), body: { totalAmountMinor: '10000', description: 'Smoke dinner', participants: [{ phone: karim.phone }, { phone: salma.phone }], includeSelf: true } });
const shares = split.body?.split ? [split.body.split.yourShare.minor, ...split.body.split.legs.map((l) => l.amount.minor)] : [];
check('split allocates exactly', split.status === 201 && shares.reduce((s, v) => s + BigInt(v), 0n) === 10_000n, shares.join('+'));

const startAt = new Date(Date.now() + 60_000).toISOString();
const sched = await call('/schedules', { method: 'POST', token: rahim.accessToken, key: crypto.randomUUID(), body: { toPhone: karim.phone, amountMinor: '50000', intervalKind: 'MONTHLY', startAt, totalRuns: 3, note: 'Rent', pin: '1234' } });
check('create schedule', sched.status === 201, sched.body?.schedule?.status);
const paused = await call(`/schedules/${sched.body.schedule.id}/pause`, { method: 'POST', token: rahim.accessToken, body: {} });
check('pause schedule', paused.body?.schedule?.status === 'PAUSED');

const history = await call('/transfers?limit=5', { token: rahim.accessToken });
check('history reads', history.status === 200 && history.body.items.length >= 3, `${history.body?.items?.length} items, served by ${history.headers.get('x-served-by')}`);

const statement = await fetch(`${BASE}/transfers/statement.csv`, { headers: { authorization: `Bearer ${rahim.accessToken}` } });
const csv = await statement.text();
check('statement streams CSV', statement.status === 200 && csv.split('\r\n').length > 3, `${csv.split('\r\n').length - 2} rows`);

const noToken = await call(`/admin/accounts/${rahim.user.id}/freeze`, { method: 'POST', body: {} });
check('admin refuses without token', noToken.status === 401);
const frozen = await call(`/admin/accounts/${salma.user.id}/freeze`, { method: 'POST', admin: true, body: { reason: 'smoke test' } });
check('admin freezes with token', frozen.status === 200 && frozen.body.account.status === 'FROZEN');
const blocked = await call('/transfers', { method: 'POST', token: salma.accessToken, key: crypto.randomUUID(), body: { toPhone: rahim.phone, amountMinor: '100', pin: '1234' } });
check('frozen account cannot spend', blocked.status === 403, blocked.body?.error?.code);
await call(`/admin/accounts/${salma.user.id}/unfreeze`, { method: 'POST', admin: true, body: {} });

const workers = await call('/admin/workers/run', { method: 'POST', admin: true, body: {} });
check('workers drain', workers.status === 200, JSON.stringify(workers.body?.schedules ?? {}));

const notes = await call('/notifications', { token: karim.accessToken });
check('notifications delivered', notes.body.items.length >= 2, `${notes.body.items.length}`);

const recon = await call('/admin/reconciliation');
check('reconciliation PASS', recon.status === 200 && recon.body.status === 'PASS', recon.body?.checks?.map((c) => c.status).join(','));

console.log(failures === 0 ? '\nALL SMOKE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
