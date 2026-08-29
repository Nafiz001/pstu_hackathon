/**
 * Chaos suite.
 *
 *   node scripts/chaos.mjs [baseUrl]
 *
 * Runs against the scale topology and breaks it on purpose, one fault at a time. Every scenario
 * ends the same way: heal the fault, then demand that reconciliation passes. The claim being
 * tested is not "the system stays up" — it will not, and should not, pretend to. The claim is
 * that whatever it does under a fault, **the books are never wrong afterwards** and the client's
 * retry is always safe.
 *
 * Faults are injected two ways:
 *   - Toxiproxy, for network conditions (latency, severed connections) — precise and reversible
 *   - docker kill/stop/pause, for process and host failures
 *
 * Nothing here is a mock. The database really dies.
 */
import { execFileSync } from 'node:child_process';

const BASE = process.argv[2] ?? 'http://127.0.0.1:18090';
const API = `${BASE}/api/v1`;
// 127.0.0.1, not localhost: on Windows `localhost` resolves to ::1 first and Docker
// Desktop's IPv6 port forwarding is unreliable, which presents as a hung connection to a
// container that is perfectly healthy.
const TOXIPROXY = 'http://127.0.0.1:8474';

const TK = (taka) => String(BigInt(taka) * 100n);
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  if (!ok) failures += 1;
  console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
};
const info = (message) => console.log(`    INFO  ${message}`);

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe' }).trim();

async function api(path, { method = 'GET', token, key, body, timeoutMs = 15_000 } = {}) {
  const headers = body ? { 'content-type': 'application/json' } : {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers['idempotency-key'] = key;

  try {
    const response = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // nginx answers with an HTML error page when no replica can be reached. That is a
      // legitimate outcome under chaos; it is not a parse bug.
      json = { error: { code: 'PROXY_ERROR', message: text.slice(0, 120) } };
    }
    return { ok: true, status: response.status, json };
  } catch (error) {
    // A transport failure is a legitimate outcome under chaos, not a crash of the harness.
    return { ok: false, status: 0, json: null, error: String(error.message ?? error) };
  }
}

// --- Toxiproxy control -----------------------------------------------------

const toxic = {
  async add(proxy, definition) {
    const response = await fetch(`${TOXIPROXY}/proxies/${proxy}/toxics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(definition),
    });
    if (!response.ok) throw new Error(`toxic add failed: ${await response.text()}`);
  },
  async clear(proxy) {
    const listed = await fetch(`${TOXIPROXY}/proxies/${proxy}/toxics`);
    for (const t of await listed.json()) {
      await fetch(`${TOXIPROXY}/proxies/${proxy}/toxics/${t.name}`, { method: 'DELETE' });
    }
  },
  async setEnabled(proxy, enabled) {
    await fetch(`${TOXIPROXY}/proxies/${proxy}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
  },
};

// --- helpers ---------------------------------------------------------------

let seed = Math.floor(Math.random() * 80_000_000) + 10_000_000;
async function register(name) {
  // Fixture setup, not the thing under test: retry through transient unavailability so a
  // scenario fails on its own assertion rather than on its preparation.
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    seed += 1;
    const phone = `017${String(seed).padStart(8, '0')}`;
    const r = await api('/auth/register', {
      method: 'POST',
      body: { phone, name, password: 'chaos-password-1', pin: '4821' },
    });
    if (r.status === 201) {
      return { phone, pin: '4821', token: r.json.accessToken, id: r.json.user.id };
    }
    if (attempt === 8) {
      throw new Error(`register failed after ${attempt} attempts: ${JSON.stringify(r.json ?? r.error)}`);
    }
    await sleep(750);
  }
  throw new Error('unreachable');
}

const balanceOf = async (user) => {
  // Reading a balance is measurement, not the thing under test. While a killed replica is being
  // replaced the proxy can briefly answer 502; retrying keeps the assertion about the ledger
  // rather than about the load balancer's DNS cache.
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const r = await api('/accounts/me', { token: user.token });
    if (r.status === 200) return BigInt(r.json.account.balance.minor);
    await sleep(500);
  }
  return null;
};

async function waitForReady(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/readyz`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok && (await response.json()).status === 'ready') return true;
    } catch {
      /* still down */
    }
    await sleep(1_000);
  }
  return false;
}

async function reconciliationPasses() {
  // Read-only measurement: retry through the brief window in which the proxy's DNS cache still
  // points at a replica that has just been replaced.
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const report = await api('/admin/reconciliation', { timeoutMs: 30_000 });
    if (report.json?.status) return report.json.status;
    await sleep(750);
  }
  const last = await api('/admin/reconciliation', { timeoutMs: 30_000 });
  return last.json?.status ?? `unreachable(${last.error ?? last.status})`;
}

// --- scenarios -------------------------------------------------------------

async function scenarioDatabaseKilled() {
  console.log('\n[A2] database killed mid-burst');

  const sender = await register('Chaos Sender A2');
  const receiver = await register('Chaos Receiver A2');

  // Keys minted up front: whatever happens, these exact requests can be safely retried.
  const keys = Array.from({ length: 60 }, () => uid());
  const send = (key) =>
    api('/transfers', {
      method: 'POST',
      token: sender.token,
      key,
      body: { toPhone: receiver.phone, amountMinor: TK(1_000), pin: sender.pin },
      timeoutMs: 20_000,
    });

  const inFlight = Promise.allSettled(keys.map(send));
  await sleep(300);

  info('killing takaflow-db');
  docker('kill', 'takaflow-db');
  const results = await inFlight;

  const succeeded = results.filter((r) => r.value?.status === 201).length;
  const refused = results.filter(
    (r) => r.value?.status >= 500 || r.value?.ok === false || r.value?.status === 0,
  ).length;
  info(`${succeeded} committed before the kill, ${refused} failed or were shed`);

  info('restarting the database');
  docker('start', 'takaflow-db');
  check('API returns to ready after restart', await waitForReady(), true);

  // THE claim: a crash mid-flight cannot leave the books wrong.
  check('reconciliation after crash', await reconciliationPasses(), 'PASS');

  // And every request that failed can be retried with its original key, safely.
  const retried = [];
  for (const key of keys.slice(0, 20)) retried.push(await send(key));
  const definite = retried.filter(
    (r) => r.status === 201 || r.json?.error?.code === 'INSUFFICIENT_FUNDS',
  ).length;
  check('retries with the original key resolve definitively', definite, retried.length);

  const senderBalance = await balanceOf(sender);
  const receiverBalance = await balanceOf(receiver);
  check(
    'the two balances still account for exactly BDT 200,000',
    (senderBalance ?? 0n) + (receiverBalance ?? 0n),
    20_000_000n,
  );
  check('reconciliation after retries', await reconciliationPasses(), 'PASS');
}

async function scenarioApiReplicaKilled() {
  console.log('\n[A1] an API replica is killed mid-transfer');

  const sender = await register('Chaos Sender A1');
  const receiver = await register('Chaos Receiver A1');

  const keys = Array.from({ length: 40 }, () => uid());
  const inFlight = Promise.allSettled(
    keys.map((key) =>
      api('/transfers', {
        method: 'POST',
        token: sender.token,
        key,
        body: { toPhone: receiver.phone, amountMinor: TK(500), pin: sender.pin },
      }),
    ),
  );

  await sleep(200);
  info('killing takaflow-api-2');
  docker('kill', 'takaflow-api-2');
  await inFlight;

  docker('start', 'takaflow-api-2');
  check('cluster returns to ready', await waitForReady(), true);
  check('reconciliation after replica loss', await reconciliationPasses(), 'PASS');

  const total = (await balanceOf(sender)) + (await balanceOf(receiver));
  check('no money lost when a node died', total, 20_000_000n);
}

async function scenarioRedisDown() {
  console.log('\n[N5] cache and rate-limiter outage');

  const sender = await register('Chaos Sender N5');
  const receiver = await register('Chaos Receiver N5');

  info('severing the API from Redis');
  await toxic.setEnabled('redis', false);
  await sleep(1_000);

  const sent = await api('/transfers', {
    method: 'POST',
    token: sender.token,
    key: uid(),
    body: { toPhone: receiver.phone, amountMinor: TK(1_000), pin: sender.pin },
  });
  check('money still moves with the cache gone', sent.status, 201);

  const balance = await api('/accounts/me', { token: sender.token });
  check('balance still readable', balance.json?.account?.balance?.minor, '9900000');

  await toxic.setEnabled('redis', true);
  info('Redis restored');
  check('reconciliation', await reconciliationPasses(), 'PASS');
}

async function scenarioDatabaseLatency() {
  console.log('\n[A3] 4s of latency between the API and the database');

  const sender = await register('Chaos Sender A3');
  const receiver = await register('Chaos Receiver A3');

  // Longer than statement_timeout (5s) is not needed — 4s is enough that lock and statement
  // guards start firing while the request is still in flight.
  await toxic.add('postgres', {
    name: 'latency-4s',
    type: 'latency',
    stream: 'downstream',
    attributes: { latency: 4_000, jitter: 0 },
  });

  const started = Date.now();
  const response = await api('/transfers', {
    method: 'POST',
    token: sender.token,
    key: uid(),
    body: { toPhone: receiver.phone, amountMinor: TK(1_000), pin: sender.pin },
    timeoutMs: 30_000,
  });
  const elapsed = Date.now() - started;

  // Either it completes or it fails fast — what must NOT happen is a partial write.
  info(`request finished in ${elapsed} ms with status ${response.status || response.error}`);
  check(
    'outcome is either success or a clean retryable failure',
    response.status === 201 || response.status >= 500 || response.ok === false,
    true,
  );
  /**
   * The meaningful assertion is WHO gave up, not how long the request took.
   *
   * With 4s injected on every round trip, a request that does a PIN verification, a transaction
   * preamble and a rollback cannot finish quickly — that is arithmetic, not a defect. What
   * matters is that WE abandoned the transaction on our own budget (503, locks released) rather
   * than the proxy eventually giving up on us (504) while the transaction sat on two account
   * rows for as long as the network stayed slow. Before the application-level deadline existed,
   * this scenario returned 504.
   */
  check('the API abandoned it on its own deadline, not the proxy on its timeout', response.status, 503);

  await toxic.clear('postgres');
  info('latency removed');
  check('API recovers', await waitForReady(), true);
  check('reconciliation after latency injection', await reconciliationPasses(), 'PASS');
}

async function scenarioConnectionSevered() {
  console.log('\n[N2] connection severed mid-request, then retried with the same key');

  const sender = await register('Chaos Sender N2');
  const receiver = await register('Chaos Receiver N2');
  const key = uid();

  const send = () =>
    api('/transfers', {
      method: 'POST',
      token: sender.token,
      key,
      body: { toPhone: receiver.phone, amountMinor: TK(2_500), pin: sender.pin },
      timeoutMs: 8_000,
    });

  // Cut the API's database connections while a payment is in flight. The client cannot know
  // whether it committed — which is exactly the situation the idempotency key exists for.
  const inFlight = send();
  await sleep(120);
  await toxic.setEnabled('postgres', false);
  const interrupted = await inFlight;
  info(`interrupted attempt: ${interrupted.status || interrupted.error}`);

  await toxic.setEnabled('postgres', true);
  check('API recovers', await waitForReady(), true);

  const retry = await send();
  check('retry with the same key resolves', retry.status === 201 || retry.status === 409, true);

  const senderBalance = await balanceOf(sender);
  check(
    'exactly one payment happened, or none',
    senderBalance === 10_000_000n || senderBalance === 9_750_000n,
    true,
  );
  info(`sender balance: ${senderBalance}`);
  check('reconciliation', await reconciliationPasses(), 'PASS');
}

async function scenarioGracefulShutdown() {
  console.log('\n[A7] graceful shutdown under load');

  const sender = await register('Chaos Sender A7');
  const receiver = await register('Chaos Receiver A7');

  const inFlight = Promise.allSettled(
    Array.from({ length: 30 }, () =>
      api('/transfers', {
        method: 'POST',
        token: sender.token,
        key: uid(),
        body: { toPhone: receiver.phone, amountMinor: TK(100), pin: sender.pin },
      }),
    ),
  );

  await sleep(150);
  info('sending SIGTERM to takaflow-api-3');
  docker('kill', '--signal=SIGTERM', 'takaflow-api-3');
  const results = await inFlight;

  const committed = results.filter((r) => r.value?.status === 201).length;
  info(`${committed} of 30 committed while a node was draining`);

  docker('start', 'takaflow-api-3');
  check('cluster ready again', await waitForReady(), true);
  check('reconciliation after graceful shutdown', await reconciliationPasses(), 'PASS');
}

async function scenarioReplicaFrozen() {
  console.log('\n[replica] standby frozen while a user reads');

  const user = await register('Chaos Reader');
  const payee = await register('Chaos Payee');

  docker('exec', 'takaflow-db-replica', 'psql', '-U', 'takaflow', '-d', 'takaflow', '-tAc',
    'SELECT pg_wal_replay_pause()');

  // Retried with a STABLE key, which is the only way retrying a payment is ever acceptable.
  const paymentKey = uid();
  let sent = { status: 0 };
  for (let attempt = 1; attempt <= 8 && sent.status !== 201; attempt += 1) {
    sent = await api('/transfers', {
      method: 'POST',
      token: user.token,
      key: paymentKey,
      body: { toPhone: payee.phone, amountMinor: TK(1_000), pin: user.pin },
    });
    if (sent.status !== 201) await sleep(750);
  }
  check('payment committed', sent.status, 201);

  const history = await api('/transfers?limit=5', { token: user.token });
  check(
    'payer still sees their own payment',
    history.json.items.some((i) => i.reference === sent.json.transfer.reference),
    true,
  );

  docker('exec', 'takaflow-db-replica', 'psql', '-U', 'takaflow', '-d', 'takaflow', '-tAc',
    'SELECT pg_wal_replay_resume()');
  check('reconciliation', await reconciliationPasses(), 'PASS');
}

// --- runner ----------------------------------------------------------------

async function main() {
  console.log(`\nTakaFlow chaos suite  ->  ${BASE}`);
  console.log('Every scenario ends by proving the books are still correct.\n');

  check('stack is ready before we break it', await waitForReady(30_000), true);
  check('baseline reconciliation', await reconciliationPasses(), 'PASS');

  const scenarios = [
    scenarioRedisDown,
    scenarioDatabaseLatency,
    scenarioConnectionSevered,
    scenarioApiReplicaKilled,
    scenarioGracefulShutdown,
    scenarioReplicaFrozen,
    scenarioDatabaseKilled, // last: it is the most disruptive
  ];

  for (const scenario of scenarios) {
    try {
      await scenario();
    } catch (error) {
      failures += 1;
      console.log(`    FAIL  scenario threw: ${error.message}`);
    } finally {
      // Never leave a fault armed for the next scenario.
      await toxic.clear('postgres').catch(() => undefined);
      await toxic.setEnabled('postgres', true).catch(() => undefined);
      await toxic.setEnabled('redis', true).catch(() => undefined);
    }
  }

  console.log('\n[final] full reconciliation');
  check('all invariants', await reconciliationPasses(), 'PASS');

  console.log(
    failures === 0
      ? '\nCHAOS SUITE PASSED — every fault healed with the books intact.\n'
      : `\nCHAOS SUITE FAILED — ${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nchaos harness crashed:', error);
  await toxic.clear('postgres').catch(() => undefined);
  await toxic.setEnabled('postgres', true).catch(() => undefined);
  await toxic.setEnabled('redis', true).catch(() => undefined);
  process.exit(1);
});
