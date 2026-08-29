/**
 * Load profile for the money path.
 *
 *   docker compose --profile load run --rm k6 run /scripts/transfer.js
 *   PROFILE=spike docker compose --profile load run --rm k6 run /scripts/transfer.js
 *
 * Three shapes, because they answer different questions:
 *   steady — what does this cost at a sustained rate?
 *   spike  — what happens when traffic multiplies without warning?
 *   soak   — does anything leak or drift when it runs for a while?
 *
 * The thresholds are the SLOs. If they fail, the run fails; a load test that cannot fail is a
 * demo, not a test.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const BASE = __ENV.BASE_URL || 'http://proxy:80';
const API = `${BASE}/api/v1`;
const PROFILE = __ENV.PROFILE || 'steady';
/**
 * How many recipient accounts the load spreads across.
 *
 * 1 (the default) means every virtual user pays into the SAME account, so every transfer
 * contends for one row lock — the hot-account worst case. Raising it removes that contention
 * without changing a line of application code, which is how we tell lock contention apart from
 * CPU cost in the results.
 */
const SINKS = Number(__ENV.SINKS || 1);

const transfersCommitted = new Counter('transfers_committed');
const transfersRefused = new Counter('transfers_refused');
const idempotentReplays = new Counter('idempotent_replays');
const transferLatency = new Trend('transfer_latency', true);

const PROFILES = {
  steady: {
    executor: 'constant-vus',
    vus: 20,
    duration: '60s',
  },
  spike: {
    executor: 'ramping-vus',
    startVUs: 5,
    stages: [
      { duration: '15s', target: 5 },
      { duration: '5s', target: 100 },   // 20x, with no warning
      { duration: '30s', target: 100 },
      { duration: '10s', target: 5 },
      { duration: '15s', target: 5 },    // does it recover, or stay degraded?
    ],
  },
  soak: {
    executor: 'constant-vus',
    vus: 10,
    duration: '10m',
  },
};

export const options = {
  scenarios: { money: PROFILES[PROFILE] },
  thresholds: {
    // The SLO this system claims.
    'http_req_duration{scenario:money}': ['p(95)<500', 'p(99)<1500'],
    // Every request must reach a definite business outcome. 5xx is the failure being watched:
    // a refused transfer is a correct answer, a 500 is not.
    'http_req_failed{expected_response:true}': ['rate<0.02'],
    checks: ['rate>0.98'],
  },
  // Money must not be lost even when the tool measuring it gives up.
  gracefulStop: '10s',
};

const json = { headers: { 'content-type': 'application/json' } };
const authed = (token, key) => ({
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    ...(key ? { 'idempotency-key': key } : {}),
  },
});

const RUN = `${Date.now().toString(36)}`;

function register(tag) {
  const phone = `017${String(Math.floor(Math.random() * 89_000_000) + 10_000_000)}`;
  const response = http.post(
    `${API}/auth/register`,
    JSON.stringify({ phone, name: `Load ${tag}`, password: 'load-password-1', pin: '4821' }),
    json,
  );
  if (response.status !== 201) return null;
  return { phone, pin: '4821', token: response.json().accessToken };
}

/**
 * Accounts are created ONCE, up front, and the measured loop does nothing but move money.
 *
 * The first version of this script registered a fresh account inside every iteration, which
 * meant each measurement included two Argon2id hashes for the signup on top of the one for the
 * PIN. Argon2 is deliberately expensive (19 MiB, ~50 ms), so the run was really a benchmark of
 * password hashing wearing a transfer's clothes: p95 came out at 2.09s and told us nothing about
 * the ledger. Registration throughput is a real number, but it is a different number.
 */
export function setup() {
  const senders = [];
  for (let i = 0; i < 40; i += 1) {
    const sender = register(`sender-${i}`);
    if (sender) senders.push(sender);
  }
  const sinks = [];
  for (let i = 0; i < SINKS; i += 1) {
    const sink = register(`sink-${i}`);
    if (sink) sinks.push(sink.phone);
  }
  if (sinks.length === 0 || senders.length === 0) {
    throw new Error('load test setup failed: could not create accounts');
  }
  console.log(
    `setup: ${senders.length} senders paying into ${sinks.length} recipient(s)` +
      `${sinks.length === 1 ? ' — single hot account, maximum lock contention' : ''}`,
  );
  return { sinks, senders };
}

export default function (data) {
  const sender = data.senders[exec.vu.idInTest % data.senders.length];
  const sinkPhone = data.sinks[exec.scenario.iterationInTest % data.sinks.length];

  const key = `k6-${RUN}-${exec.vu.idInTest}-${exec.scenario.iterationInTest}`;
  const started = Date.now();

  const response = http.post(
    `${API}/transfers`,
    JSON.stringify({ toPhone: sinkPhone, amountMinor: '10000', pin: sender.pin }),
    authed(sender.token, key),
  );

  transferLatency.add(Date.now() - started);

  check(response, {
    // A refusal is a correct outcome under load; an unexplained 500 is not.
    'transfer reached a definite outcome': (r) =>
      r.status === 201 || r.status === 422 || r.status === 429 || r.status === 503,
    'no server error': (r) => r.status !== 500,
  });

  if (response.status === 201) {
    transfersCommitted.add(1);
    if (response.headers['Idempotent-Replay'] === 'true') idempotentReplays.add(1);
  } else {
    transfersRefused.add(1);
  }
}

export function teardown() {
  // The run is only meaningful if the books still balance afterwards.
  const report = http.get(`${API}/admin/reconciliation`);
  const status = report.status === 200 ? report.json().status : 'UNREACHABLE';
  console.log(`\nreconciliation after load: ${status}`);
  if (status !== 'PASS') {
    throw new Error(`RECONCILIATION FAILED AFTER LOAD: ${report.body}`);
  }
}
