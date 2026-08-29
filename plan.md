# Implementation Plan — TakaFlow (Money Movement Application)

**Companion to:** [prd.md](prd.md) · **Version:** 2.0 — extended timeline
**Window:** 29 August 2026 → ~5 September 2026 (one week) · **Constraint removed:** nothing is limited by what
is currently installed — if we need a tool, we install it.

> Governing principle: **the system must be provably incapable of losing, creating, or duplicating money — and
> every claim we make must have an automated test that fails if the claim stops being true.** With a week
> available, "documented but not built" is no longer an acceptable answer for anything in the scaling story.

---

## 1. Stack (chosen on merit, now that availability is not a constraint)

```
Runtime     Node.js 22 + TypeScript (strict)      HTTP     Fastify
DB          PostgreSQL 16 primary + streaming replica, PgBouncer (transaction pooling)
DB access   pg + hand-written parameterised SQL behind a thin repository layer
Cache       Redis 7 — rate limits + balance cache (never authoritative)
Streaming   Redpanda (Kafka API) fed by the Postgres transactional outbox
Realtime    WebSocket gateway consuming the event stream
Telemetry   OpenTelemetry → Jaeger · Prometheus + Grafana · pino JSON logs
Tests       Vitest · Supertest · Testcontainers · fast-check (property) · Playwright (E2E)
Chaos/load  Toxiproxy · docker kill · k6 (steady / spike / soak)
Frontend    Vite + React + TS + Tailwind + TanStack Query
Infra       Docker Compose: proxy · api ×3 · pgbouncer · db-primary · db-replica · redis ·
            redpanda · prometheus · grafana · jaeger · web
CI          GitHub Actions — lint, typecheck, full test pyramid, k6 smoke, Trivy image scan
```

**Two decisions worth stating out loud, because judges will probe them:**

- **Why not Go / Rust, now that we could install either?** The guarantees that make this system trustworthy —
  atomicity, isolation, durability, the non-negative-balance constraint, the append-only ledger — are enforced
  by PostgreSQL, not by the application language. Changing runtime would not alter a single one of them, while
  costing velocity on the parts actually being marked. We keep Node and spend the week on ledger correctness,
  scale mechanics, and test evidence instead.
- **Why not an ORM?** The row-locking SQL is the artefact we are being marked on and the artefact we must
  defend verbally. It stays visible, in `*.repo.ts`, parameterised, and reviewed.

---

## 2. Phases (7 working days)

Each day ends at a **gate**. A gate is a command that either passes or fails — not an opinion. Nothing from a
later day starts until the current gate is green, because everything downstream assumes the ledger is correct.

| Day | Date | Phase | Gate (must pass to proceed) |
|---|---|---|---|
| 1 | Fri 29 Aug | Foundation: repo, compose, schema, platform primitives, auth + funded registration | `docker compose up` boots; migrations apply; two registrations leave `SUM(balances) = 0` |
| 2 | Sat 30 Aug | **Transfer core** + idempotency + concurrency suite | 500-way concurrency burst: no negative balance, no lost money; 50× idempotent replay ⇒ one transfer |
| 3 | Sun 31 Aug | Money requests, history, outbox → Redpanda, notifications, realtime, reconciliation | Double-accept ⇒ `INVALID_STATE`; reconciliation 4/4 PASS after a randomised 5,000-transfer workload |
| 4 | Mon 1 Sep | Scale mechanics: PgBouncer, read replica + routing, partitioning, Redis cache, 3 API replicas, hot-account striping | Same invariants hold across 3 replicas; striping benchmark shows measured throughput gain; replica serves history with read-your-writes intact |
| 5 | Tue 2 Sep | Reliability: Toxiproxy chaos matrix, crash and failover drills, property-based invariants, backpressure, full observability | Every chaos scenario ends with reconciliation PASS; 10,000-operation property test green; dashboards and traces live |
| 6 | Wed 3 Sep | Product breadth: reversal, scheduler, split bill, QR/links, statements, admin console, full frontend + E2E | Playwright E2E covers every user journey; each new money path has its own concurrency test |
| 7 | Thu 4 Sep | Cross-shard reservation saga (flagged), security hardening, k6 suites, docs/ADRs/runbook, demo rehearsal | Saga survives coordinator kill mid-flight with books balanced; k6 thresholds pass in CI; demo rehearsed end to end |
| — | Fri 5 Sep | Buffer, final rehearsal, submission | Full CI green on the submitted commit |

**Ordering rule:** correctness first (Days 1–3), then scale (Day 4), then proof of resilience (Day 5), then
product surface (Day 6), then distribution (Day 7). Features never precede the invariants that protect them.

---

## 3. Day-by-Day Detail

### Day 1 — Foundation

**Repo layout**
```
takaflow/
  backend/   src/ tests/ migrations/ package.json tsconfig.json .env.example
  frontend/  (vite react-ts)
  ops/       docker-compose.yml prometheus/ grafana/ toxiproxy/ k6/
  docs/      adr/ architecture.md runbook.md
  .github/workflows/ci.yml
```

**Compose (start with the full service list, even if some containers are idle on day 1)** — adding
infrastructure late is what breaks builds; declaring it early costs nothing.

**Migrations** — run at API start, guarded by a Postgres advisory lock so concurrent replicas cannot race.

```sql
-- 001_init.sql (abridged; the constraints are the point)
CREATE TYPE account_type    AS ENUM ('USER','SYSTEM');
CREATE TYPE account_status  AS ENUM ('ACTIVE','FROZEN','CLOSED');
CREATE TYPE transfer_status AS ENUM ('COMPLETED','FAILED','REVERSED');
CREATE TYPE transfer_type   AS ENUM ('P2P','MINT','REQUEST_SETTLEMENT','REVERSAL','SCHEDULED');
CREATE TYPE entry_direction AS ENUM ('DEBIT','CREDIT');
CREATE TYPE request_status  AS ENUM ('PENDING','ACCEPTED','DECLINED','CANCELLED','EXPIRED');

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone           text NOT NULL UNIQUE CHECK (phone ~ '^01[3-9][0-9]{8}$'),
  name            text NOT NULL,
  password_hash   text NOT NULL,
  pin_hash        text NOT NULL,
  failed_pin_attempts int NOT NULL DEFAULT 0,
  pin_locked_until    timestamptz,
  status          text NOT NULL DEFAULT 'ACTIVE',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid UNIQUE REFERENCES users(id),
  type          account_type   NOT NULL DEFAULT 'USER',
  status        account_status NOT NULL DEFAULT 'ACTIVE',
  balance_minor bigint NOT NULL DEFAULT 0,
  version       bigint NOT NULL DEFAULT 0,
  shard_key     smallint NOT NULL DEFAULT 0,      -- day 7 sharding, declared now
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT non_negative_user_balance CHECK (type = 'SYSTEM' OR balance_minor >= 0),
  CONSTRAINT user_account_has_user     CHECK (type = 'SYSTEM' OR user_id IS NOT NULL)
);

CREATE TABLE idempotency_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  key             text NOT NULL,
  endpoint        text NOT NULL,
  request_hash    text NOT NULL,
  state           text NOT NULL CHECK (state IN ('IN_PROGRESS','COMPLETED')),
  response_status int,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  UNIQUE (user_id, key)
);

CREATE TABLE transfers (
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  reference          text NOT NULL,
  from_account_id    uuid NOT NULL REFERENCES accounts(id),
  to_account_id      uuid NOT NULL REFERENCES accounts(id),
  amount_minor       bigint NOT NULL CHECK (amount_minor > 0),
  type               transfer_type   NOT NULL DEFAULT 'P2P',
  status             transfer_status NOT NULL DEFAULT 'COMPLETED',
  note               text CHECK (note IS NULL OR length(note) <= 140),
  idempotency_key_id uuid REFERENCES idempotency_keys(id),
  reversal_of        uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at),                    -- partition key must be in the PK
  CONSTRAINT no_self_transfer CHECK (from_account_id <> to_account_id)
) PARTITION BY RANGE (created_at);                 -- monthly partitions from day 1
CREATE UNIQUE INDEX transfers_reference_uk ON transfers (reference, created_at);

CREATE TABLE ledger_entries (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  transfer_id   uuid   NOT NULL,
  account_id    uuid   NOT NULL REFERENCES accounts(id),
  direction     entry_direction NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  balance_after bigint NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at),
  UNIQUE (transfer_id, account_id, direction, created_at)
) PARTITION BY RANGE (created_at);

CREATE FUNCTION deny_mutation() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN RAISE EXCEPTION 'ledger_entries is append-only'; END $$;
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

CREATE TABLE money_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_request_id   uuid REFERENCES money_requests(id),   -- split-bill aggregate
  requester_user_id   uuid NOT NULL REFERENCES users(id),
  payer_user_id       uuid NOT NULL REFERENCES users(id),
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  note                text,
  status              request_status NOT NULL DEFAULT 'PENDING',
  expires_at          timestamptz NOT NULL,
  settled_transfer_id uuid,
  version             bigint NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT no_self_request CHECK (requester_user_id <> payer_user_id)
);

CREATE TABLE outbox_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type      text NOT NULL,
  aggregate_id    uuid NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING',   -- PENDING | PROCESSED | FAILED
  attempts        int  NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_ready ON outbox_events (next_attempt_at) WHERE status = 'PENDING';

-- 002_support.sql   notifications · audit_logs · refresh_tokens · scheduled_transfers · limits
-- 003_indexes.sql   the index list from PRD §5.4
-- 004_partitions.sql  partition manager function + the first 6 monthly partitions
-- 005_seed_system.sql SYSTEM_TREASURY account (fixed uuid, type = 'SYSTEM')
```

**Platform primitives (build these before any route)**
- `db/pool.ts` — bounded pool (`max = 20` per replica), `statement_timeout`, `lock_timeout`,
  `idle_in_transaction_session_timeout`, pointed at PgBouncer.
- `db/withTransaction.ts` — BEGIN/COMMIT/ROLLBACK, `SET LOCAL` timeouts, retry ×3 with jittered backoff on
  `40001` (serialization) and `40P01` (deadlock). **Every money path goes through this one function.**
- `db/readRouter.ts` — replica-by-default reads with a post-write stickiness window keyed by the user's last
  write LSN (read-your-writes; falls back to the primary when the replica has not caught up).
- `errors/` — `DomainError` hierarchy + a single Fastify error handler emitting the PRD §5.5 envelope.
- `logging/` + `telemetry/` — pino with `requestId`, OTel tracing on HTTP and DB spans; redact `pin`,
  `password`, `authorization`.

**Auth and funded registration**
- Argon2id for password and PIN (separate hashes, separate salts).
- **Registration is one transaction:** insert user → insert account → lock treasury `FOR UPDATE` → mint
  transfer (`type = 'MINT'`) → two ledger entries → outbox `USER_REGISTERED`. If any step fails the user does
  not exist. Never "create the user now, fund them later".
- Login: access JWT 15 min (`jti`, `sub`), refresh token 7 d stored as a SHA-256 hash, rotated on every use;
  **reuse of a rotated token revokes the entire family** (theft detection).
- Rate limit login by IP and phone; PIN lockout after 5 failures for 15 minutes.

**Day 1 gate:** `docker compose up` boots; `/readyz` green; two registrations leave `SUM(balances) = 0`; the
mint appears as two real ledger entries.

---

### Day 2 — Transfer core (the most important day of the week)

**Idempotency middleware (`platform/idempotency`)**
1. Require `Idempotency-Key` on every money-moving POST (≤ 128 chars).
2. `request_hash = sha256(canonical(body) + endpoint)`.
3. `INSERT ... ON CONFLICT (user_id, key) DO NOTHING RETURNING *`:
   - insert won ⇒ we own this operation, proceed;
   - conflict, `state = 'COMPLETED'`, same hash ⇒ replay the stored response with `Idempotent-Replay: true`;
   - conflict, `state = 'COMPLETED'`, different hash ⇒ `409 IDEMPOTENCY_KEY_REUSE`;
   - conflict, `state = 'IN_PROGRESS'` ⇒ `409 REQUEST_IN_PROGRESS` + `Retry-After: 1`.
4. **The completion write happens inside the business transaction, not after it.** This single decision is what
   makes crash-after-commit and crash-before-commit both correct — there is no third state. Say this out loud
   in the defence.

**`transfer.service.executeTransfer(cmd)` — order of operations**
```
verify PIN (outside the tx, constant-time; the lockout counter updates in its own tx)
withTransaction:
  claim the idempotency row                       -- IN_PROGRESS, owned by this request
  resolve payee by phone                          -- 404 before any lock is taken
  guard: self-transfer, amount range, payee account status
  SELECT ... FOR UPDATE both accounts ORDER BY id -- deterministic lock order kills deadlocks
  guard under the lock: sender ACTIVE, balance >= amount, per-transfer and daily limits
  UPDATE both balances (+ version)                -- CHECK (balance_minor >= 0) is the final guard
  INSERT transfer  (reference = TF-<base32 of 40 random bits>)
  INSERT 2 ledger entries with balance_after
  INSERT outbox event MONEY_RECEIVED
  INSERT audit log
  UPDATE idempotency row -> COMPLETED with the exact response body
COMMIT
```
No HTTP, Redis, logging, or stream I/O inside the transaction — nothing that can hold a row lock while waiting
on a remote system.

**Tests written the same day, not later**
- `concurrency/burst.spec.ts` — 500 parallel ৳10,000 transfers from a ৳100,000 account ⇒ exactly 10 succeed,
  final balance 0, `SUM(balances) = 0`, ledger entry count = 2 × successes.
- `concurrency/deadlock.spec.ts` — 200 interleaved A→B / B→A transfers ⇒ zero unhandled `40P01` escapes.
- `concurrency/chain.spec.ts` — a ring of 10 accounts transferring simultaneously ⇒ total conserved.
- `integration/idempotency.spec.ts` — 50 parallel identical requests on one key ⇒ 1 transfer, 50 identical
  bodies, 49 flagged replays; different-payload reuse ⇒ 409; in-flight duplicate ⇒ 409 + `Retry-After`.
- `integration/validation.spec.ts` — self-transfer, zero/negative/fractional amounts, unknown payee, frozen
  account, over-limit, oversized note, malformed phone.

**Day 2 gate:** all of the above green, run 20× in a loop to smoke out flakiness.

---

### Day 3 — Requests, history, events, reconciliation

**Money-request state machine — transitions guarded in SQL, never in JavaScript**
```sql
UPDATE money_requests
   SET status = 'ACCEPTED', settled_transfer_id = $tx, version = version + 1, updated_at = now()
 WHERE id = $1 AND status = 'PENDING' AND payer_user_id = $me AND expires_at > now();
-- rowCount = 0  =>  INVALID_STATE (already settled, cancelled, expired, or not yours)
```
- Accept = that guarded update **plus** the Day-2 transfer, in **one** transaction, reusing `executeTransfer`
  with `type = 'REQUEST_SETTLEMENT'`. Zero duplicated ledger logic.
- Cancel (requester only) and decline (payer only) use the same conditional-update pattern.
- Expiry worker every 60 s: batched `UPDATE ... SET status = 'EXPIRED' WHERE status = 'PENDING' AND
  expires_at <= now()`, emitting one outbox event per row.

**History** — keyset pagination: cursor = base64 of `(created_at, id)`;
`WHERE (created_at, id) < ($ts, $id) ORDER BY created_at DESC, id DESC LIMIT $n + 1`. Never `OFFSET`.
Filters: direction, type, date range, counterparty, amount range — each backed by an index, each with an
`EXPLAIN` captured in `docs/` to prove no sequential scans.

**Outbox → Redpanda** — dispatcher every 500 ms:
`SELECT ... WHERE status = 'PENDING' AND next_attempt_at <= now() ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED`
→ publish to the topic → mark `PROCESSED`; on failure `attempts++` with exponential `next_attempt_at`, `FAILED`
after 5 attempts, with a poison-event inspector in the admin console. `SKIP LOCKED` is what makes multiple API
replicas safe — this is a Day-4 proof point, so build it correctly now.

**Consumers** — notification writer (idempotent on `event_id`), realtime WebSocket fan-out, analytics
projection. Each consumer is independently restartable and must tolerate redelivery.

**Reconciliation** — `GET /admin/reconciliation` runs the four invariants (PRD §7.4) in one read-only
transaction and returns `{ name, status, detail, durationMs }` per check; also available as `npm run reconcile`
and exported as a Prometheus gauge so a broken invariant becomes an alert, not a surprise.

**Day 3 gate:** randomised 5,000-transfer workload across 20 accounts ⇒ reconciliation 4/4 PASS; double-accept,
accept-after-cancel, accept-when-expired, and accept-with-insufficient-funds all behave (the request stays
`PENDING` in the last case and no money moves).

---

### Day 4 — Scale mechanics (build what was previously only described)

1. **PgBouncer** in transaction mode; app pools sized against it; verify behaviour under 2,000 client
   connections.
2. **Streaming replica** in compose; `readRouter` sends history, notifications, and admin reads to it; the
   post-write LSN stickiness window guarantees read-your-writes. Test: send money, immediately read the
   balance from a replica-routed endpoint — never stale.
3. **Partitioning** — the partition manager creates next month's partitions ahead of time and detaches/archives
   old ones. Test with 5M synthetic rows: query plans must still be index-only on the current partition, with
   partition pruning visible in `EXPLAIN`.
4. **Redis balance cache** — version-stamped (`accounts.version`), invalidated inside the same request that
   writes; on a Redis miss or outage, reads fall through to Postgres. Prove correctness by running the whole
   integration suite with Redis stopped.
5. **Three API replicas behind the proxy** — rerun the Day-2 concurrency and idempotency suites against the
   proxy. The idempotency layer and `SKIP LOCKED` must hold across processes, not merely across requests.
6. **Hot-account balance striping** — N stripes per hot account, random stripe selection on credit, aggregated
   for reads and consolidated by a background job. Benchmark the treasury account before and after; publish the
   throughput delta.

**Day 4 gate:** every earlier suite passes against the 3-replica proxy topology; the striping benchmark shows a
measured (not asserted) improvement; partition pruning confirmed by `EXPLAIN`.

---

### Day 5 — Reliability engineering (the day that wins Rubric #2)

**Chaos matrix** — each scenario is an automated test ending in a reconciliation assertion:

| Scenario | Injected with | Expected |
|---|---|---|
| DB killed mid-burst | `docker kill db-primary` | 503s; on restart reconciliation PASS; retries resolve consistently |
| API replica killed mid-transfer | `docker kill api-2` | In-flight tx rolled back; client retry with the same key is safe |
| API↔DB latency 2 s | Toxiproxy | `lock_timeout`/`statement_timeout` fire; fail fast, no pile-up, no partial writes |
| API↔DB connection severed after commit | Toxiproxy | Retry finds `COMPLETED` and replays the stored response |
| Redis down | `docker stop redis` | Money paths unaffected; limits degrade per policy |
| Redpanda down | `docker stop redpanda` | Transfers still commit; outbox backs up and drains on recovery; no duplicates |
| Replica lag / failover | pause replica, promote | Reads fall back to the primary; no stale balance is ever served |
| Pool exhaustion | k6 spike beyond pool size | Fast 503 with `Retry-After`, no unbounded queueing |
| Graceful shutdown | SIGTERM under load | Readiness flips first, in-flight requests complete, zero dropped commits |
| Clock skew | Skewed container clock | DB-generated `now()` keeps ordering and expiry correct |

**Property-based invariants (`fast-check`)** — generate 10,000 random operations (transfers, requests,
accepts, declines, reversals, expiries) across a pool of accounts, then assert: total money conserved, no
negative user balance, every account's balance equals its ledger sum, every completed transfer has exactly two
balanced entries. This is the test that finds what our hand-written cases missed.

**Observability** — Grafana dashboards for TPS, latency percentiles, error taxonomy, lock-wait time, outbox
lag, consumer lag, replica lag, and reconciliation status; Jaeger traces spanning HTTP → service → SQL; alert
rules with written SLOs (e.g. p99 transfer < 250 ms, outbox lag < 5 s, reconciliation always PASS).

**Day 5 gate:** the entire chaos matrix passes unattended; the property test survives 10,000 operations;
`docs/chaos-results.md` is written.

---

### Day 6 — Product breadth and the frontend

**Backend**
- **Reversal** — compensating double entry (never a row edit), time-windowed, idempotent, audited, with the
  original transfer marked `REVERSED` and linked via `reversal_of`.
- **Scheduler** — durable scheduled and recurring transfers; each occurrence carries a deterministic
  idempotency key (`schedule_id + occurrence_date`), so a scheduler restart, a duplicate tick, or two replicas
  firing simultaneously cannot pay twice. Claim occurrences with `FOR UPDATE SKIP LOCKED`.
- **Split bill** — a parent request fanned to N payers; each leg settles independently and the parent closes
  only when every leg is terminal. Concurrency test: all N payers accept simultaneously.
- **QR / claim links** — signed, single-use, expiring tokens; replay of a consumed token is rejected.
- **Statements** — CSV and PDF over a date range, generated from the ledger, streamed rather than buffered.
- **Admin console API** — reconciliation dashboard, freeze/unfreeze, audit search, outbox inspector, with RBAC.

**Frontend (10% of the marks — complete, polished, deliberately not sprawling)**
Login · Register · Dashboard · Send · Request · Requests (inbox/outbox) · History + receipt · Schedules ·
Admin · **Engineering panel**.
- One `apiClient` that generates a **UUID idempotency key per user intent** — created when the form opens, not
  when the button is clicked; that is what makes a double-tap safe — and retries 5xx/timeouts with the same key.
- TanStack Query for cache and invalidation; live updates over WebSocket; submit disabled while in flight; no
  optimistic balances (money UI shows server truth only).
- **Engineering panel** — buttons for "replay this transfer 50×", "fire 500 concurrent transfers", "run
  reconciliation", "show the last Jaeger trace", each rendering raw JSON. This is how a 10% UI earns backend
  marks.
- Playwright E2E across every journey, run in CI.

**Day 6 gate:** E2E green; every new money path has its own concurrency test; reconciliation still PASS.

---

### Day 7 — Distribution, hardening, documentation

- **Cross-shard reservation saga** (feature-flagged, two logical shards): `reserve` debits into a held state on
  the source shard → `commit` credits the destination → `release` finalises; a timeout sweeper compensates any
  reservation left dangling. Tests: kill the coordinator between each pair of steps, in both directions, and
  assert the books balance every time. Built last, precisely so the fast single-shard path is never at risk.
- **Security pass** — dependency and image scanning (npm audit, Trivy), OWASP checklist, secrets handling,
  CORS/Helmet review, authorization tests for every object-scoped route (can user A act on user B's request?),
  optional TOTP step-up for high-value transfers.
- **k6 suites** — steady (sustained TPS), spike (10× for 60 s), soak (2 h, watching for leaks and pool drift);
  thresholds enforced in CI; results published in `docs/load-results.md`.
- **Documentation** — README (one-command run, architecture diagram, demo script), numbered ADRs for every
  significant decision (why modular monolith, why `READ COMMITTED` + row locks, why the outbox, why striping,
  why Node), a runbook (what to do when reconciliation fails, when outbox lag grows, when the replica lags),
  and OpenAPI served through Scalar.
- **Rehearsal** — run the PRD §11 demo end to end, timed, twice, on a clean `docker compose up`.

---

## 4. Test Inventory (the evidence that carries Rubric #2)

| Suite | File | Proves |
|---|---|---|
| Unit | `withTransaction.spec.ts` | Retries `40001`/`40P01`, gives up after 3, always releases the client |
| Unit | `money.spec.ts` | Minor-unit parsing/formatting, no float path, boundary amounts |
| Unit | `idempotency-hash.spec.ts` | Canonicalisation is order- and whitespace-insensitive but value-sensitive |
| Integration | `auth.spec.ts` | Atomic registration, real mint, refresh rotation, reuse detection, PIN lockout |
| Integration | `transfer.spec.ts` | Happy path, receipt, both sides of history |
| Integration | `idempotency.spec.ts` | PRD §6.2 I1–I7 |
| Integration | `requests.spec.ts` | Full state machine incl. double-accept, expiry, wrong actor, split-bill legs |
| Integration | `schedules.spec.ts` | Duplicate ticks and restarts never double-pay |
| Integration | `reversal.spec.ts` | Compensating entries, window enforcement, no double reversal |
| Integration | `limits.spec.ts` | Per-transfer cap, daily cap, velocity, rate limits |
| Integration | `authz.spec.ts` | No user can act on another user's objects |
| Concurrency | `burst.spec.ts` | 500-way burst: no negative balance, no lost or created money |
| Concurrency | `deadlock.spec.ts` | Deterministic ordering + retry, zero escapes |
| Concurrency | `request-race.spec.ts` | Exactly one settlement under accept/accept and accept/cancel races |
| Concurrency | `multi-replica.spec.ts` | Idempotency and `SKIP LOCKED` hold across 3 API processes |
| Invariant | `property.spec.ts` | 10,000 randomised ops preserve all four invariants |
| Invariant | `reconciliation.spec.ts` | Invariants after a randomised 5,000-transfer workload |
| Chaos | `db-kill.spec.ts` · `net-fault.spec.ts` · `broker-down.spec.ts` · `failover.spec.ts` | The Day-5 matrix |
| Load | `k6/steady.js` · `spike.js` · `soak.js` | Thresholds on p95/p99 and error rate |
| E2E | `e2e/*.spec.ts` | Every user journey in a real browser |

**Definition of done for any money feature:** it has an integration test **and** a concurrency or invariant
test. No exceptions — including for features added on Day 6.

---

## 5. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Infrastructure sprawl destabilises the demo | Medium | High | Every service is declared in compose on Day 1 and exercised daily in CI; nothing is introduced the night before |
| Cross-shard saga bleeds into the core path | Medium | High | Feature-flagged, built last, separate module and test suite; the flag is off by default |
| Chaos tests become flaky and get ignored | Medium | High | Chaos runs against a dedicated compose project, never the demo instance; deterministic assertions on totals, not on timings |
| Frontend expands past its 10% weight | Medium | Medium | Screen list is fixed in the PRD; new UI ideas go to a backlog file, not into the sprint |
| Partitioning bugs surface late | Low | High | Partitions exist from migration 001, so every test has run against a partitioned table all week |
| Test suite runtime grows unusable | Medium | Medium | Tiered CI: fast suites on every push, chaos/load nightly and pre-submission |
| Nobody can explain a component under questioning | Medium | High | One named owner per module; a written ADR per decision; a full team walkthrough on Day 7 |

---

## 6. Judge Q&A Preparation (rehearse these)

1. **"What happens if the server dies mid-transfer?"** Postgres rolls back the uncommitted transaction. Because
   the idempotency completion is written *inside* that same transaction, a retry with the same key either sees
   `COMPLETED` (the crash was after commit — we replay the stored response) or nothing (the crash was before
   commit — we execute cleanly). There is no third state, and the chaos suite proves it.
2. **"Two people send from the same account simultaneously?"** Both take `SELECT ... FOR UPDATE`; one waits. The
   balance check happens *after* the lock, and `CHECK (balance_minor >= 0)` is a database-level guard even if
   the application code were wrong. Demonstrated with 500 concurrent requests.
3. **"Why `READ COMMITTED` and not `SERIALIZABLE`?"** Our write path already takes explicit row locks in a
   deterministic order, which gives the isolation we need with far less abort churn. We retry `40001` centrally
   anyway, so raising the level is a one-line change — we can show the benchmark that justified the choice.
4. **"How do you avoid deadlocks?"** Locks are always acquired ordered by account id, so opposite transfers
   request the same rows in the same sequence, plus `lock_timeout` and a bounded retry on `40P01`.
5. **"Does the balance column duplicate the ledger?"** Deliberately — it is a materialised aggregate for O(1)
   reads, written in the same transaction as the entries and continuously verified by invariant #2.
6. **"How does this reach 10 million users?"** Stateless API replicas, PgBouncer, a read replica with
   read-your-writes safety, monthly partitions, keyset pagination, hot-account striping, and a reservation saga
   for cross-shard movement. All of it is running in this compose file — we can show you the dashboards.
7. **"Why an outbox instead of publishing directly?"** A direct publish can succeed while the transaction rolls
   back, or fail after it commits. The outbox row commits atomically with the money, so the event exists if and
   only if the money moved; the dispatcher then guarantees at-least-once delivery to idempotent consumers.
8. **"What if Redis or Redpanda is down?"** Money still moves. Redis is a cache and a rate limiter, never a
   source of truth; Redpanda is a delivery channel whose source of truth is the outbox table. We test both
   outages in CI.
9. **"Why Node rather than Go?"** Because every guarantee that matters here is enforced by Postgres, not by the
   runtime — and we would rather spend the week on ledger correctness and evidence than on a rewrite that
   changes no guarantee.
10. **"What is not done?"** Automated shard rebalancing, automated HA failover, real payment rails, real
    KYC/AML, and mobile push. Stated deliberately in the PRD — not discovered on stage.

---

## 7. Non-Negotiables

These are the spine of the submission. Everything else is negotiable; these are not:

`withTransaction` with retry · deterministic row-lock ordering · `CHECK (balance_minor >= 0)` ·
double-entry writes for every movement · the append-only ledger trigger · the idempotency layer with its
completion inside the money transaction · the transactional outbox · the reconciliation endpoint and its four
invariants · the concurrency, idempotency, property, and chaos suites.

---

## 8. Immediate Next Actions

1. Scaffold `takaflow/` (`backend/`, `frontend/`, `ops/`, `docs/`, `.github/workflows/`).
2. Write the full `ops/docker-compose.yml` — every service, including the ones idle until Day 4.
3. `docker compose up -d db-primary db-replica pgbouncer redis redpanda` and confirm connectivity before a line
   of application code.
4. Write and apply `001_init.sql` exactly as in Day 1 — schema first, because every later decision hangs off it.
5. Implement `withTransaction`, `readRouter`, and the error envelope before the first route.
6. Stand up CI on the first commit, so it never has to be retrofitted.
