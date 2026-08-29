/**
 * Proves the read-your-writes guard, deterministically.
 *
 *   node scripts/verify-read-your-writes.mjs [baseUrl]
 *
 * On a local machine the replica catches up in under a millisecond, so a normal run never
 * exercises the fallback — the guard could be broken and the tests would still pass by luck.
 * This script removes the luck: it PAUSES WAL replay on the standby, makes a payment, and then
 * demands that the payer still sees it.
 *
 * Expected behaviour with replay paused:
 *   - the read is served by the PRIMARY (the router sees the replica is behind the user's write)
 *   - the new transfer is present in the payer's history
 *   - a different user, who has not written, is still served by the replica
 *
 * If the guard were missing, the first read would be served by a replica frozen before the
 * payment and the user would see their money missing. That is the failure this exists to catch.
 */
import { execFileSync } from 'node:child_process';

const BASE = process.argv[2] ?? 'http://127.0.0.1:18090';
const API = `${BASE}/api/v1`;
const REPLICA_CONTAINER = 'takaflow-db-replica';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
};

const psqlOnReplica = (sql) =>
  execFileSync(
    'docker',
    ['exec', REPLICA_CONTAINER, 'psql', '-U', 'takaflow', '-d', 'takaflow', '-tAc', sql],
    { encoding: 'utf8' },
  ).trim();

async function api(path, { method = 'GET', token, key, body } = {}) {
  const headers = body ? { 'content-type': 'application/json' } : {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers['idempotency-key'] = key;
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null };
}

let seed = Math.floor(Math.random() * 80_000_000) + 10_000_000;
async function register(name) {
  seed += 1;
  const phone = `017${String(seed).padStart(8, '0')}`;
  const r = await api('/auth/register', {
    method: 'POST',
    body: { phone, name, password: 'ryw-password-123', pin: '4821' },
  });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.json)}`);
  return { phone, pin: '4821', token: r.json.accessToken };
}

async function main() {
  console.log(`\nRead-your-writes under replication lag  ->  ${BASE}\n`);

  check('replica is in recovery', psqlOnReplica('SELECT pg_is_in_recovery()'), 't');

  const payer = await register('RYW Payer');
  const payee = await register('RYW Payee');

  // A user who has not written recently: their reads should keep using the replica throughout.
  const bystander = await register('RYW Bystander');
  for (let i = 0; i < 24; i += 1) {
    const probe = await api('/transfers?limit=1', { token: bystander.token });
    if (probe.headers.get('x-served-by') === 'replica') break;
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log('\n  Pausing WAL replay on the standby...');
  psqlOnReplica('SELECT pg_wal_replay_pause()');
  check('replay is paused', psqlOnReplica('SELECT pg_get_wal_replay_pause_state()'), 'paused');

  try {
    const sent = await api('/transfers', {
      method: 'POST',
      token: payer.token,
      key: `ryw-${Date.now()}`,
      body: { toPhone: payee.phone, amountMinor: '100000', pin: payer.pin },
    });
    check('payment committed while the replica is frozen', sent.status, 201);
    const reference = sent.json.transfer.reference;

    const history = await api('/transfers?limit=5', { token: payer.token });
    check('payer read was routed to the primary', history.headers.get('x-served-by'), 'primary');
    check(
      'payer sees their own payment despite the lag',
      history.json.items.some((i) => i.reference === reference),
      true,
    );

    const balance = await api('/accounts/me', { token: payer.token });
    check('payer balance reflects the payment', balance.json.account.balance.minor, '9900000');

    // The whole point of routing: only the writer pays the cost of the fallback.
    const bystanderRead = await api('/transfers?limit=1', { token: bystander.token });
    check(
      'an unrelated user is still served by the replica',
      bystanderRead.headers.get('x-served-by'),
      'replica',
    );

    console.log('\n  Resuming WAL replay...');
    psqlOnReplica('SELECT pg_wal_replay_resume()');

    let caughtUp = false;
    for (let i = 0; i < 40 && !caughtUp; i += 1) {
      const probe = await api('/transfers?limit=1', { token: payer.token });
      caughtUp = probe.headers.get('x-served-by') === 'replica';
      if (!caughtUp) await new Promise((r) => setTimeout(r, 250));
    }
    check('payer reads return to the replica once it catches up', caughtUp, true);
  } finally {
    // Never leave the standby paused, whatever happened above.
    try {
      psqlOnReplica('SELECT pg_wal_replay_resume()');
    } catch {
      /* already resumed */
    }
  }

  const report = await api('/admin/reconciliation');
  check('reconciliation after the exercise', report.json.status, 'PASS');

  console.log(
    failures === 0
      ? '\nPASSED — a user never sees a replica older than their own last write.\n'
      : `\nFAILED — ${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\ncrashed:', error);
  try {
    psqlOnReplica('SELECT pg_wal_replay_resume()');
  } catch {
    /* best effort */
  }
  process.exit(1);
});
