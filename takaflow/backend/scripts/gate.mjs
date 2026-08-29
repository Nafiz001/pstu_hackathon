/**
 * Phase gate — run against a LIVE server over real HTTP.
 *
 *   node scripts/gate.mjs [baseUrl]
 *
 * The test suite proves these properties through app.inject(); this proves them again through
 * the real network stack, the real server process, and a real connection pool under saturation.
 * It is also the script used on stage: every number it prints is a claim we make out loud.
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;

const TK = (taka) => String(BigInt(taka) * 100n);
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

let failures = 0;
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
};

/**
 * Transport-level retry.
 *
 * At this concurrency the connection itself sometimes fails before any HTTP response exists —
 * a reset socket, a refused connect. That is precisely the situation idempotency keys are for:
 * the client cannot know whether the request was processed, so it repeats it with the SAME key
 * and lets the server decide. A real mobile client does exactly this. Retrying without a stable
 * key would be the double-spend this project exists to prevent.
 */
let transportRetries = 0;

async function api(path, { method = 'GET', token, key, body } = {}, attempt = 1) {
  // Only declare a JSON content-type when there is actually a body: Fastify rejects an empty
  // body that claims to be JSON, which is correct of it.
  const headers = body ? { 'content-type': 'application/json' } : {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers['idempotency-key'] = key;

  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if (attempt >= 4) throw error;
    transportRetries += 1;
    await new Promise((r) => setTimeout(r, 50 * attempt));
    return api(path, { method, token, key, body }, attempt + 1);
  }

  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text,
    json: text ? JSON.parse(text) : null,
  };
}

let phoneSeed = Math.floor(Math.random() * 8_000_0000) + 10_000_000;
async function register(name) {
  phoneSeed += 1;
  const phone = `017${String(phoneSeed).padStart(8, '0')}`;
  const response = await api('/auth/register', {
    method: 'POST',
    body: { phone, name, password: 'gate-password-123', pin: '4821' },
  });
  if (response.status !== 201) throw new Error(`register failed: ${response.body}`);
  return { phone, name, pin: '4821', token: response.json.accessToken, id: response.json.user.id };
}

const balanceOf = async (user) =>
  BigInt((await api('/accounts/me', { token: user.token })).json.account.balance.minor);

async function main() {
  console.log(`\nTakaFlow gate  ->  ${BASE}\n`);

  const ready = await fetch(`${BASE}/readyz`);
  check('readiness', (await ready.json()).status, 'ready');

  // --- C1: concurrency -----------------------------------------------------
  console.log('\nC1  500 concurrent transfers of BDT 10,000 from a BDT 100,000 balance');
  const sender = await register('Burst Sender');
  const receiver = await register('Burst Receiver');

  // Keys are minted up front so that anything shed under load can be retried with the SAME key,
  // exactly as a real client would.
  const keys = Array.from({ length: 500 }, () => uid());
  const send = (key) =>
    api('/transfers', {
      method: 'POST',
      token: sender.token,
      key,
      body: { toPhone: receiver.phone, amountMinor: TK(10_000), pin: sender.pin },
    });

  const started = Date.now();
  const responses = await Promise.all(keys.map(send));
  const elapsed = Date.now() - started;

  const created = responses.filter((r) => r.status === 201).length;
  const insufficient = responses.filter((r) => r.json?.error?.code === 'INSUFFICIENT_FUNDS').length;
  const shed = responses.filter((r) => r.json?.error?.code === 'SERVICE_UNAVAILABLE');
  const unexpected = responses.filter(
    (r) =>
      r.status !== 201 &&
      !['INSUFFICIENT_FUNDS', 'SERVICE_UNAVAILABLE', 'REQUEST_IN_PROGRESS'].includes(
        r.json?.error?.code,
      ),
  );

  check('transfers that succeeded', created, 10);
  check('unexpected failures', unexpected.length, 0);
  if (unexpected.length > 0) console.log('   ', unexpected.slice(0, 3).map((r) => r.body).join('\n    '));
  check('sender balance (poisha)', await balanceOf(sender), 0n);
  check('receiver balance (poisha)', await balanceOf(receiver), 20_000_000n);
  console.log(
    `  INFO  ${created} succeeded, ${insufficient} refused for funds, ${shed.length} shed as ` +
      `retryable 503 (pool saturation — bounded queue, not a stall)`,
  );
  console.log(
    `  INFO  completed in ${elapsed} ms; throughput here is bounded by deliberate Argon2 PIN ` +
      `hashing (~50 ms/request), not by the ledger`,
  );

  // The contract for a shed request is that retrying it with the same key is safe. Prove it.
  if (shed.length > 0) {
    console.log(`\nA3  retrying ${shed.length} shed request(s) with their original keys`);
    const shedKeys = keys.filter((_, i) => responses[i].json?.error?.code === 'SERVICE_UNAVAILABLE');
    const retried = [];
    for (const key of shedKeys) retried.push(await send(key));
    check(
      'every retry resolved to a definite outcome',
      retried.every((r) => r.status === 201 || r.json?.error?.code === 'INSUFFICIENT_FUNDS'),
      true,
    );
    // The sender was emptied by the 10 that succeeded, so a retry must now be refused for funds
    // — and must not have moved money a second time.
    check('sender balance still zero (poisha)', await balanceOf(sender), 0n);
    check('receiver balance unchanged (poisha)', await balanceOf(receiver), 20_000_000n);
  }

  // --- I1/I3: idempotency --------------------------------------------------
  console.log('\nI1  50 concurrent retries of one request, one Idempotency-Key');
  const payer = await register('Replay Payer');
  const payee = await register('Replay Payee');
  const key = uid();

  const replays = await Promise.all(
    Array.from({ length: 50 }, () =>
      api('/transfers', {
        method: 'POST',
        token: payer.token,
        key,
        body: { toPhone: payee.phone, amountMinor: TK(2_500), pin: payer.pin },
      }),
    ),
  );

  const receipts = replays.filter((r) => r.status === 201);
  const inProgress = replays.filter((r) => r.json?.error?.code === 'REQUEST_IN_PROGRESS');
  const distinctBodies = new Set(receipts.map((r) => r.body));

  check('receipts returned', receipts.length >= 1, true);
  check('responses accounted for', receipts.length + inProgress.length, 50);
  check('distinct receipt bodies (byte-identical replay)', distinctBodies.size, 1);
  check('payer balance after 50 attempts (poisha)', await balanceOf(payer), 9_750_000n);

  console.log('\nI1b 20 sequential retries of the same key');
  const seqKey = uid();
  const sequential = [];
  for (let i = 0; i < 20; i += 1) {
    sequential.push(
      await api('/transfers', {
        method: 'POST',
        token: payer.token,
        key: seqKey,
        body: { toPhone: payee.phone, amountMinor: TK(1_000), pin: payer.pin },
      }),
    );
  }
  check('all returned 201', sequential.every((r) => r.status === 201), true);
  check('replays flagged', sequential.slice(1).every((r) => r.headers.get('idempotent-replay') === 'true'), true);
  check('distinct bodies', new Set(sequential.map((r) => r.body)).size, 1);
  check('payer balance (poisha)', await balanceOf(payer), 9_650_000n);

  // --- I2: key reuse with a different body ---------------------------------
  console.log('\nI2  same key, different amount');
  const mismatch = await api('/transfers', {
    method: 'POST',
    token: payer.token,
    key: seqKey,
    body: { toPhone: payee.phone, amountMinor: TK(9_999), pin: payer.pin },
  });
  check('rejected', mismatch.json?.error?.code, 'IDEMPOTENCY_KEY_REUSE');
  check('payer balance unchanged (poisha)', await balanceOf(payer), 9_650_000n);

  // --- C4: the money-request state machine ---------------------------------
  console.log('\nC4  "my friend owes me BDT 1,200" — request, then 10 simultaneous accepts');
  const collector = await register('Collector');
  const debtor = await register('Debtor');

  const requested = await api('/requests', {
    method: 'POST',
    token: collector.token,
    key: uid(),
    body: { fromPhone: debtor.phone, amountMinor: TK(1_200), note: 'Dinner' },
  });
  check('request created', requested.status, 201);
  const requestId = requested.json.request.id;

  const accepts = await Promise.all(
    Array.from({ length: 10 }, () =>
      api(`/requests/${requestId}/accept`, {
        method: 'POST',
        token: debtor.token,
        key: uid(),
        body: { pin: debtor.pin },
      }),
    ),
  );
  check('settled exactly once', accepts.filter((r) => r.status === 200).length, 1);
  check(
    'losers rejected as INVALID_STATE',
    accepts.filter((r) => r.json?.error?.code === 'INVALID_STATE').length,
    9,
  );
  check('debtor balance (poisha)', await balanceOf(debtor), 9_880_000n);
  check('collector balance (poisha)', await balanceOf(collector), 10_120_000n);

  // --- outbox + notifications ----------------------------------------------
  console.log('\nA5  transactional outbox');
  const drained = await api('/admin/workers/run', {
    method: 'POST',
    // Operator endpoint: the gate runs with the same token the stack was started with.
    headers: { 'x-admin-token': process.env.ADMIN_API_TOKEN ?? 'local-operator-token-change-me' },
  });
  check('outbox drained without failures', drained.json.outbox.failed, 0);
  const inbox = await api('/notifications', { token: collector.token });
  check(
    'requester was notified their request was paid',
    inbox.json.items.some((i) => i.type === 'REQUEST_ACCEPTED'),
    true,
  );

  // --- reconciliation ------------------------------------------------------
  console.log('\nInvariants  GET /admin/reconciliation');
  const report = await api('/admin/reconciliation');
  check('overall', report.json.status, 'PASS');
  for (const c of report.json.checks) {
    check(`  ${c.name}`, c.status, 'PASS');
  }
  console.log(
    `  INFO  user money ${report.json.totals.userMoney}, treasury ${report.json.totals.treasury}, ` +
      `net ${report.json.totals.net} across ${report.json.totals.transfers} transfers ` +
      `(${report.json.totals.ledgerEntries} entries) in ${report.json.totalDurationMs} ms`,
  );

  // --- read routing (only meaningful on the scale topology) ----------------
  const readyBody = await (await fetch(`${BASE}/readyz`)).json();
  if (readyBody.replica === 'configured') {
    console.log('\nRead routing  replica + read-your-writes');

    const reader = await register('Replica Reader');
    const other = await register('Replica Payee');

    // Immediately after a write, this user's reads must not be served stale. The router asks the
    // replica whether it has replayed that far, and falls back to the primary when it has not.
    const sent = await api('/transfers', {
      method: 'POST',
      token: reader.token,
      key: uid(),
      body: { toPhone: other.phone, amountMinor: TK(1_000), pin: reader.pin },
    });
    check('transfer accepted', sent.status, 201);

    const immediate = await api('/transfers?limit=5', { token: reader.token });
    check(
      'own write is visible immediately after committing',
      immediate.json.items.some((i) => i.reference === sent.json.transfer.reference),
      true,
    );
    console.log(`  INFO  that read was served by the ${immediate.headers.get('x-served-by')}`);

    // Once the replica has replayed past a user's recorded write position, their reads are free
    // to use it. Poll briefly rather than sleeping for a guessed duration.
    let servedByReplica = false;
    for (let i = 0; i < 24 && !servedByReplica; i += 1) {
      const probe = await api('/transfers?limit=1', { token: other.token });
      servedByReplica = probe.headers.get('x-served-by') === 'replica';
      if (!servedByReplica) await new Promise((r) => setTimeout(r, 250));
    }
    check('reads reach the replica once it has caught up', servedByReplica, true);

    const balance = await api('/accounts/me', { token: reader.token });
    console.log(
      `  INFO  balance ${balance.json.account.balance.formatted} ` +
        `(servedFromCache=${balance.json.account.servedFromCache})`,
    );
  }

  if (transportRetries > 0) {
    console.log(
      `\n  INFO  ${transportRetries} request(s) failed at the transport layer and were retried ` +
        `with their original Idempotency-Key; every balance above already accounts for that.`,
    );
  }

  console.log(
    failures === 0
      ? '\nGATE PASSED — no money created, destroyed, or duplicated.\n'
      : `\nGATE FAILED — ${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\ngate crashed:', error);
  process.exit(1);
});
