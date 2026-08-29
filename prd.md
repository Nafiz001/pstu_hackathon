# PRD — "TakaFlow": Money Movement Application

**Event:** PSTU IT Carnival 2026 — Hackathon Challenge
**Date:** 29 August 2026 · Patuakhali Science and Technology University
**Submission deadline:** extended by one week — **~5 September 2026**
**Status:** Locked for build (v2.0 — extended scope)

> **Timeline note (v2.0):** the original brief ran 09:00–15:00 on 29 Aug 2026. The deadline has been extended
> by a week, and any tooling we need may be installed. Everything this document previously listed as
> "documented but not built" (partitioning, read replicas, sharding, event streaming, full observability,
> load and chaos testing) is now **in scope and must actually be built**. There is no time-pressure cut-list.

---

## 0. Source Question (verbatim extraction)

> Sources cross-checked: `question.md`, `WhatsApp Image 2026-08-29 at 9.16.14 AM (1).jpeg` (page 1),
> `WhatsApp Image 2026-08-29 at 9.16.14 AM.jpeg` (page 2). All three agree. The images add only the event
> branding ("PSTU IT Carnival 2026") and the explicit "Duration | 9:00 AM – 3:00 PM" line. No contradictions.

### Page 1

**29 August 2026 | Patuakhali Science and Technology University | Duration 9:00 AM – 3:00 PM**

**Challenge: MONEY MOVEMENT APPLICATION**

**Brief:**
Design and develop a Money Movement Application that allows users to move/transfer/request money between one
another through a digital account (with fake balance).

Consider a real-world environment where users depend on the system expecting every transaction to be
**correct, reliable and trustworthy**.

**Scenario:**
Imagine a digital money platform used by a growing community (in 3 years users might be more than
**10 million**).

Every registered user has an account with a balance. Users should be able to interact with one another
financially and conveniently move their money through the application.

A typical user may want to:
> "I need to send ৳2,500 to another user."

Another may say:
> "My friend owes me ৳1,200. I want to collect it through the application."

Your job is to identify the real world features we need everyday life, implement those features in your app and
make it fully functional!

**Your Mission:**
Build a working web or mobile application, **including its backend**, that solves the money-movement problem
described above. We intentionally leave the detailed product requirements open.

You are expected to think about the problem from the perspectives of both:
the people using the application and the engineers responsible for making it trustworthy.

Decide what capabilities are necessary for a useful and realistic solution.

### Page 2

**Think Beyond the simplistic CRUD app.**

Moving money appears simple:

`A → ৳500 → B`

In a real system, however, things do not always happen exactly as expected. Users may perform actions quickly,
networks may behave unexpectedly, multiple activities may happen at the same time, systems may receive
unexpected input, and usage may grow far beyond what was originally anticipated.

Your solution should demonstrate how your team thinks about building software for such an environment.

**Technical Freedom:**
There are **no restrictions on programming language, framework, database, architecture or development tools**.

You may use any technologies you believe are appropriate. Use of AI-assisted development tools is also
permitted.

However, your team is expected to **understand, explain and defend the solution you build and the engineering
decisions behind it**.

**Scope:**
Your time is limited.

You are **not expected to build a complete banking platform** or integrate with real banks, cards, payment
gateways or financial networks.

Treat the application as a **closed money ecosystem** with simulated/fake funds.

Focus on building a small but thoughtful working product rather than a large collection of incomplete features.

**Starting Point:**
You may fund each user **BDT 100,000** in his/her balance automatically while they register in the application.

---

## 1. Judging Rubric to Product Mapping

| # | Rubric item | Weight | How this PRD answers it |
|---|---|---|---|
| 1 | Implementation and working product | Highest | Every P0 feature is demoable end-to-end; nothing ships half-built (§4, §11) |
| 2 | Edge cases: DB crash, idempotency, concurrency, network, ACID | Highest | §6 exhaustive, testable edge-case matrix; §7 crash/recovery semantics |
| 3 | Optimized, scalable, concurrent | High | §8 concurrency model, §9 scale plan to 10M users |
| 4 | Proper system architecture | High | §5 architecture, §5.4 data model, §5.5 API contract |
| 5 | Clean, readable, furnished, scalable code | High | §10 code standards and layering rules |
| 6 | UI 10% / Backend 90% | — | UI is deliberately thin but complete (§4.9); all depth is backend |

**The one-line claim we defend on stage:** *"Money is never created, destroyed, or duplicated in this system —
and we can prove it with one SQL query, under 200 concurrent requests, after killing the database
mid-transfer."*

---

## 2. Product Vision

A closed-loop digital wallet where a person holds Taka, **sends** it to another person instantly, and
**requests** it from another person — with the trust properties a real payment system needs: exactly-once money
movement, an immutable audit trail, and correct behaviour when the network, the client, or the database
misbehaves.

Positioning: not a CRUD wallet. A **double-entry ledger** with a wallet UX on top.

---

## 3. Personas and Core User Stories

| Persona | Story | Acceptance |
|---|---|---|
| Rahim (sender) | "I need to send ৳2,500 to another user." | Finds payee by phone, confirms with PIN, sees new balance + receipt in < 1s |
| Karim (collector) | "My friend owes me ৳1,200. I want to collect it through the application." | Creates a money request; payer accepts; funds move atomically |
| Any user | "My phone lost signal after I tapped Send. Did it go through?" | Retry never double-charges; history shows exactly one transfer |
| Any user | "Where did my money go?" | Filterable, cursor-paginated ledger view + receipt |
| Ops / Judge | "Prove the books balance." | `/admin/reconciliation` returns invariant checks; all must be PASS |

---

## 4. Feature Scope

### P0 — Must ship (demo-critical, non-negotiable)

**4.1 Identity and Accounts**
- Register with phone (unique, BD format `01XXXXXXXXX`), name, password, 4-digit transaction PIN.
- On registration: account auto-created and funded **৳100,000**, issued as a real double-entry mint from a
  `SYSTEM_TREASURY` account — not a magic number write. Registration + funding is one atomic transaction.
- Login returns a short-lived access JWT (15 min) + rotating refresh token (7 d, hashed at rest, revocable).
- Argon2id password hashing; PIN hashed separately and required for every money-moving action.

**4.2 Balance and Profile**
- `GET /accounts/me` — balance in minor units + formatted value, account status, daily limit usage.
- Balance always comes from the `accounts` row the ledger maintains; reconciliation proves
  `account.balance == SUM(ledger_entries)` for every account.

**4.3 Send Money (core)**
- Payee lookup by phone, confirm, PIN, transfer.
- Mandatory `Idempotency-Key` header. Same key + same body ⇒ same response, exactly one movement.
- Server side: single ACID transaction, deterministic row-lock ordering, `CHECK (balance_minor >= 0)` as the
  last line of defence, both ledger entries written in the same transaction.
- Optional note (≤ 140 chars), min ৳1, max ৳50,000 per transfer, ৳200,000 rolling daily limit.

**4.4 Request Money (core — explicitly called out in the brief)**
- Create request: target user, amount, note, `expires_at` (default 7 days).
- Lifecycle: `PENDING → ACCEPTED (settled) | DECLINED | CANCELLED | EXPIRED`.
- Accept performs the settlement transfer atomically with the state transition, guarded by a conditional
  `UPDATE ... WHERE status = 'PENDING'` so a double-tap or two devices can never settle twice.
- Requester may cancel while `PENDING`; payer may decline; a background worker expires stale requests.
- Inbox (incoming) and Outbox (outgoing) views with status filters.

**4.5 Transaction History and Receipts**
- Keyset (cursor) pagination — no `OFFSET`, correct and fast at 10M users.
- Filters: direction (in/out), type, date range, counterparty, amount range.
- Every transfer has a human-readable public reference (`TF-8FQ2K7XR`) and a receipt view.

**4.6 Trust and Safety**
- Immutable append-only `ledger_entries` (UPDATE/DELETE blocked by a DB trigger).
- `audit_logs` for every state-changing action (actor, action, entity, IP, user agent).
- Rate limiting: per-user and per-IP token bucket on login, transfer, request creation.
- Account states `ACTIVE | FROZEN | CLOSED`; frozen accounts can receive but not send.
- Wrong-PIN lockout: 5 failures ⇒ 15-minute cooldown.

**4.7 Notifications (in-app)**
- Money received, request received, request accepted, request declined, request expired.
- Delivered via a **transactional outbox** — never a best-effort side effect that can be lost or double-sent.

**4.8 Operability**
- `/healthz` (liveness), `/readyz` (DB + migrations + pool), `/metrics` (Prometheus text format).
- Structured JSON logs with `request_id` propagated end to end; never log tokens, PINs, or hashes.
- `GET /admin/reconciliation` runs the four money invariants (§7.4) and returns PASS/FAIL per check.

**4.9 UI (10% weight — thin but complete)**
Single React SPA, 7 screens: Login · Register · Dashboard (balance + recent) · Send · Request (create) ·
Requests inbox/outbox · History + receipt. Plus an **Engineering panel** that visibly demonstrates idempotent
retry, a 50-way concurrency burst, and live reconciliation — the UI's job is to *sell the backend*.

### P1 — Extended scope (all of it ships; ordered by build sequence)

**Product**
1. **Reversal / refund** of a completed transfer — compensating double entry, never a row edit; time-windowed,
   audited, idempotent.
2. **Scheduled and recurring transfers** — a durable scheduler with per-occurrence idempotency keys, so a
   scheduler restart or double-fire cannot pay twice.
3. **Split bill / group request** — one request fanned out to N payers, each leg settling independently, with a
   parent aggregate that closes only when every leg is terminal.
4. **QR codes and shareable claim links** for money requests (signed, single-use, expiring tokens).
5. **Statements** — CSV and PDF export over a date range, generated from the ledger, not from the UI's view.
6. **Contacts / favourites / recent payees**, and per-user configurable limit tiers.
7. **Real-time notifications** over WebSocket (fed by the same outbox), plus the in-app inbox.
8. **Admin console** — reconciliation dashboard, account freeze/unfreeze, audit-log search, outbox inspector.
9. **Session management** — list active devices, revoke individually; optional TOTP 2FA for high-value moves.

**Platform (this is where the marks are)**
10. **PgBouncer** (transaction pooling) in front of Postgres, and a bounded app pool behind it.
11. **Streaming read replica** with read routing for history/notifications, and read-your-writes safety
    (post-write stickiness by LSN, so a user never sees a stale balance after their own transfer).
12. **Monthly range partitioning** of `transfers` and `ledger_entries` with an automated partition manager.
13. **Redis balance cache** with version-stamped invalidation (read-your-writes safe; never authoritative).
14. **Kafka-compatible event streaming (Redpanda)** — the outbox table stays the source of truth; the
    dispatcher publishes to a topic and independent consumers handle notifications and analytics.
15. **Three API replicas behind a reverse proxy**, proving `SKIP LOCKED` outbox consumption and the
    idempotency layer are correct across processes, not just across requests.
16. **Hot-account balance striping** — N sub-balances for high-contention accounts (treasury, merchant-like),
    with aggregation; the fix for C7 is built, not just described.
17. **Full observability** — OpenTelemetry traces to Jaeger, Prometheus metrics, Grafana dashboards
    (TPS, p99, lock-wait time, outbox lag, reconciliation status), and alert rules with stated SLOs.
18. **Chaos and load engineering** — Toxiproxy fault matrix (latency, packet loss, severed connections),
    container kills, replica failover drill, k6 steady/spike/soak suites with pass/fail thresholds in CI.
19. **Cross-shard money movement** — two logical shards with a reservation-based saga (reserve → commit →
    release, with a compensating timeout sweeper), feature-flagged and independently tested. Built last so it
    can never destabilise the single-shard core.
20. **CI/CD** — GitHub Actions running lint, typecheck, unit, integration, concurrency, invariant, chaos-lite
    and k6-smoke on every push; image build + Trivy scan.

### P2 — Explicitly out of scope (state this to judges)
Real bank/card/gateway integration, real KYC/AML programmes, FX and multi-currency, interest and lending, chat,
native mobile apps, and mobile push (APNs/FCM) — WebSocket delivery covers the demo need.

---

## 5. System Architecture

### 5.1 Style
**Modular monolith with strict internal service seams, deployed as multiple identical replicas.** Rationale we
defend on engineering merit (not on schedule): at 10M users the bottleneck is the ledger's *write path* and
per-account contention, not process boundaries. Keeping money movement inside one ACID boundary is the
strongest correctness position available; splitting a debit and its matching credit across services would
replace a database transaction with a saga and buy nothing but failure modes. Where distribution is genuinely
required — sharding beyond one primary — we implement it explicitly as a reservation saga (§9) and keep it
behind a flag, so the fast, simple path stays fast and simple. The modules are seam-clean, so any of them
*could* be extracted; we can articulate exactly what we would gain and lose by doing so.

### 5.2 Stack (decided — no further debate)

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 + TypeScript (strict) | Team velocity and ecosystem; the correctness guarantees live in Postgres, not in the language runtime. (Go was reconsidered once the "not installed" constraint was lifted and rejected on merit: it would not change a single isolation guarantee, and it would cost us velocity on the parts being marked.) |
| HTTP | Fastify | Fastest mainstream Node server; first-class schema validation and lifecycle hooks |
| DB | PostgreSQL 16 (Docker), primary + streaming replica | Real ACID, `SELECT ... FOR UPDATE`, `SKIP LOCKED`, declarative partitioning, CHECK constraints |
| Pooling | PgBouncer (transaction mode) + bounded app pool | Thousands of client connections onto a small server-side pool — the standard answer at 10M users |
| DB access | `pg` + hand-written SQL behind a thin repository layer | We must *show and defend* the locking SQL; an ORM hides it |
| Cache / limits | Redis 7 | Rate limiting and balance cache. **Never a source of truth** — losing Redis degrades, never corrupts |
| Streaming | Redpanda (Kafka API) | Outbox dispatcher publishes committed events; independent consumers for notifications and analytics |
| Async | Postgres transactional outbox + `FOR UPDATE SKIP LOCKED` dispatcher | Exactly-once *effect*; the DB stays the source of truth even if the broker is down |
| Realtime | WebSocket gateway fed by the event stream | Live balance and request updates without polling |
| Validation | Zod (shared schemas) | One definition for runtime validation, TS types, and OpenAPI |
| Auth | JWT access + rotating refresh, Argon2id, optional TOTP | Stateless reads, revocable sessions, step-up for high-value moves |
| Observability | OpenTelemetry → Jaeger, Prometheus + Grafana, pino JSON logs | Traces through the transfer path; dashboards for TPS, p99, lock waits, outbox lag |
| Tests | Vitest + Supertest + Testcontainers, fast-check (property tests), Playwright | Concurrency / idempotency / invariant / crash proofs are a first-class deliverable |
| Chaos + load | Toxiproxy, `docker kill`, k6 (steady / spike / soak) | Network faults and crashes are exercised, not asserted about |
| Frontend | Vite + React + TS + Tailwind + TanStack Query | 10% of marks — complete and polished, deliberately not sprawling |
| Infra | Docker Compose (proxy, api ×3, db primary, db replica, pgbouncer, redis, redpanda, prometheus, grafana, jaeger, web) | One command to reproduce the whole system on a judge's laptop |
| CI | GitHub Actions | Lint, typecheck, and the full test pyramid on every push; image build + Trivy scan |

### 5.3 Layering (strict, enforced in review)

```
HTTP route  →  validation (Zod)  →  service (business rules + tx boundary)
            →  repository (SQL only)  →  Postgres
```

Rules: routes contain no business logic; services never write raw SQL; repositories never open transactions
(they receive the `tx` handle); domain errors are typed and mapped to HTTP in exactly one place.

```
src/
  app.ts  server.ts  config/
  modules/
    auth/          routes · service · repo · schemas
    accounts/
    transfers/     ← the heart: ledger.service.ts, transfer.service.ts, transfer.repo.ts
    requests/      money-request state machine (incl. split-bill aggregate)
    schedules/     scheduled + recurring transfers
    notifications/
    realtime/      WebSocket gateway
    admin/         reconciliation · freeze · audit search · outbox inspector
  platform/
    db/            pool, withTransaction (retry on 40001/40P01), migrations, read-replica router
    idempotency/   middleware + store
    sharding/      shard router + reservation saga (feature-flagged)
    striping/      hot-account balance stripes + aggregation
    ratelimit/  outbox/  stream/  cache/  errors/  logging/  telemetry/  auth/
  workers/         outbox dispatcher · stream consumers · request expiry · scheduler
                   partition manager · saga timeout sweeper · janitor · reconciliation
tests/
  unit/  integration/  concurrency/  invariant/  chaos/  load/  e2e/
ops/
  docker-compose.yml  grafana/  prometheus/  toxiproxy/  k6/
docs/
  adr/  architecture.md  runbook.md  load-results.md  chaos-results.md
```

### 5.4 Data Model (authoritative)

**Money representation:** `BIGINT` **minor units (poisha)**. ৳100,000 = `10000000`. No floats anywhere, ever.
Formatting happens only at the UI edge.

| Table | Purpose | Key integrity rules |
|---|---|---|
| `users` | identity | `phone` UNIQUE, `status`, argon2 `password_hash`, `pin_hash`, `failed_pin_attempts`, `pin_locked_until` |
| `accounts` | one wallet per user, plus system accounts | `user_id` UNIQUE (nullable for system), `balance_minor BIGINT NOT NULL`, `CHECK (type = 'SYSTEM' OR balance_minor >= 0)`, `version BIGINT` |
| `transfers` | movement intent and outcome | public `reference` UNIQUE, `status`, `type`, `CHECK (amount_minor > 0)`, `CHECK (from_account_id <> to_account_id)` |
| `ledger_entries` | **append-only double entry** | UNIQUE `(transfer_id, account_id, direction)`, `amount_minor > 0`, `balance_after`, trigger blocks UPDATE/DELETE |
| `money_requests` | request lifecycle | `status` enum, `expires_at`, `settled_transfer_id`, `version`, `CHECK (requester_id <> payer_id)` |
| `idempotency_keys` | exactly-once API | UNIQUE `(user_id, key)`, `request_hash`, `state IN ('IN_PROGRESS','COMPLETED')`, stored `response_status` / `response_body`, `expires_at` |
| `outbox_events` | reliable side effects | `status`, `attempts`, `next_attempt_at`, consumed with `FOR UPDATE SKIP LOCKED` |
| `notifications` | in-app inbox | `user_id`, `type`, `payload jsonb`, `read_at` |
| `audit_logs` | who did what | append-only, `actor_user_id`, `action`, `entity`, `metadata`, `ip`, `ua` |
| `refresh_tokens` | revocable sessions | `token_hash`, `expires_at`, `revoked_at`, rotation chain |

**Double-entry invariant:** every transfer writes exactly two `ledger_entries` (one `DEBIT`, one `CREDIT`) of
equal `amount_minor`, in the same transaction that mutates both `accounts.balance_minor` rows. The signup bonus
is a mint from `SYSTEM_TREASURY` — the only account permitted to go negative — so total user money always
equals exactly what the treasury issued.

**Indexes that matter at 10M users**
```
users(phone) UNIQUE                       accounts(user_id) UNIQUE
transfers(from_account_id, created_at DESC, id DESC)
transfers(to_account_id,   created_at DESC, id DESC)
transfers(reference) UNIQUE               ledger_entries(account_id, id DESC)
money_requests(payer_id, status, created_at DESC)
money_requests(requester_id, status, created_at DESC)
idempotency_keys(user_id, key) UNIQUE
outbox_events(next_attempt_at) WHERE status = 'PENDING'   -- partial
```

### 5.5 API Contract (v1, JSON, base `/api/v1`)

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` | creates user + account + ৳100,000 mint, atomically |
| POST | `/auth/login` · `/auth/refresh` · `/auth/logout` | rotating refresh with reuse detection |
| GET | `/me` · `/accounts/me` | profile, balance, limit usage |
| GET | `/users/search?q=01…` | exact-phone lookup only (no enumeration) |
| POST | `/transfers` | **`Idempotency-Key` required**; `{ toPhone, amountMinor, note, pin }` |
| GET | `/transfers?cursor=&limit=&direction=&type=&from=&to=` | keyset pagination |
| GET | `/transfers/:reference` | receipt |
| POST | `/transfers/:reference/reverse` | P1; compensating entries |
| POST | `/requests` | idempotent; `{ fromPhone, amountMinor, note, expiresInDays }` |
| GET | `/requests?role=incoming\|outgoing&status=` | inbox / outbox |
| POST | `/requests/:id/accept` | idempotent; settles atomically; PIN required |
| POST | `/requests/:id/decline` · `/requests/:id/cancel` | state-guarded |
| GET | `/notifications` · POST `/notifications/:id/read` | in-app |
| GET | `/admin/reconciliation` | invariant report |
| GET | `/healthz` · `/readyz` · `/metrics` | ops |

**Uniform error envelope**
```json
{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "...", "requestId": "...", "details": {} } }
```
Codes: `VALIDATION_ERROR(400)`, `UNAUTHENTICATED(401)`, `INVALID_PIN(401)`, `FORBIDDEN(403)`,
`ACCOUNT_FROZEN(403)`, `NOT_FOUND(404)`, `IDEMPOTENCY_KEY_REUSE(409)`, `REQUEST_IN_PROGRESS(409)`,
`INVALID_STATE(409)`, `INSUFFICIENT_FUNDS(422)`, `LIMIT_EXCEEDED(422)`, `SELF_TRANSFER(422)`,
`RATE_LIMITED(429)`, `INTERNAL(500)`, `SERVICE_UNAVAILABLE(503)`.

**Rule:** any client that sees a 5xx or a timeout must be able to retry with the same `Idempotency-Key` and be
safe.

---

## 6. Edge-Case Matrix (Rubric #2 — the centrepiece)

Every row has a test in `tests/` and a slot in the demo script.

### 6.1 Concurrency and race conditions
| # | Scenario | Handling | Proof |
|---|---|---|---|
| C1 | 50 concurrent transfers from one account with funds for only 10 | `SELECT ... FOR UPDATE` + `CHECK (balance_minor >= 0)`; exactly 10 succeed | `tests/concurrency/burst.spec.ts` |
| C2 | A→B and B→A simultaneously (deadlock risk) | **Deterministic lock ordering by account id** + retry on SQLSTATE `40P01` | deadlock test |
| C3 | Same user, two devices, double-tap Send | Client-generated idempotency key per intent ⇒ one movement | integration test |
| C4 | Two accepts of the same money request | `UPDATE money_requests SET status='ACCEPTED' WHERE id=$1 AND status='PENDING'`; rowCount 0 ⇒ `INVALID_STATE` | state-machine test |
| C5 | Accept and cancel race | Same conditional update; loser gets 409, no money moves | test |
| C6 | Read balance during an in-flight transfer | MVCC: readers never block writers; reads are point-in-time consistent | — |
| C7 | Hot receiving account contention | Short lock window, `lock_timeout = 3s`, zero external I/O inside a transaction; §9 documents the striping path | load test |
| C8 | Lost update on `money_requests` | `version` column + conditional update | test |

### 6.2 Idempotency and retries
| # | Scenario | Handling |
|---|---|---|
| I1 | Client retries after a network timeout | Same key ⇒ replay the stored response byte-identically with `Idempotent-Replay: true` |
| I2 | Same key, **different** payload | `409 IDEMPOTENCY_KEY_REUSE` (canonical request body is hashed) |
| I3 | Retry while the original is still in flight | `409 REQUEST_IN_PROGRESS` + `Retry-After` (row is `IN_PROGRESS`, claimed via a unique insert) |
| I4 | Server crashed *after* commit, before responding | Retry finds the `COMPLETED` row (written in the same tx as the transfer) ⇒ correct response |
| I5 | Server crashed *before* commit | The whole tx rolls back including the `IN_PROGRESS` marker ⇒ retry executes cleanly. **Key insight: the idempotency record and the money movement share one transaction.** |
| I6 | Key reuse across users | Keys are scoped `(user_id, key)` |
| I7 | Stale keys | 24 h TTL, swept by the janitor worker |

### 6.3 ACID, durability, crash recovery
| # | Scenario | Handling |
|---|---|---|
| A1 | Process killed mid-transfer | Uncommitted tx rolled back by Postgres; no partial ledger; verified by chaos test |
| A2 | **Database crash / container kill mid-burst** | `synchronous_commit = on`, WAL durability; on restart reconciliation is PASS; in-flight requests fail with 503 and are safely retryable |
| A3 | Connection pool exhausted | Bounded pool, `statement_timeout = 5s`, `lock_timeout = 3s`, `idle_in_transaction_session_timeout = 10s`; fail fast with 503 rather than queue forever |
| A4 | Partial write (balance updated, ledger not) | Impossible — same transaction; reconciliation would catch it anyway |
| A5 | Notification sent but transfer rolled back | Outbox row is written **inside** the tx; the dispatcher only ever sees committed events |
| A6 | Outbox dispatcher crashes mid-send | At-least-once + idempotent consumer (dedup on `event_id`); attempts/backoff; poison events go `FAILED` after N tries |
| A7 | Torn deploy / graceful shutdown | SIGTERM ⇒ stop accepting, drain in-flight, close pool; readiness flips first so the LB stops routing |
| A8 | Serialization failure (`40001`) | Central `withTransaction` retry: 3 attempts, jittered backoff |
| A9 | Clock skew | All timestamps `timestamptz` generated by the DB (`now()`), stored UTC |

### 6.4 Money correctness and validation
| # | Scenario | Handling |
|---|---|---|
| M1 | Negative, zero, or non-integer amount | Zod + DB `CHECK (amount_minor > 0)` |
| M2 | Floating-point rounding | Integers end to end; the UI formats from minor units |
| M3 | Overflow | `BIGINT` + per-transfer cap |
| M4 | Self-transfer | Rejected in the service and by DB `CHECK (from <> to)` |
| M5 | Transfer to a nonexistent or closed account | 404 / 403 before any lock is taken |
| M6 | Insufficient funds under race | Re-checked *after* acquiring the lock, never before |
| M7 | Money created or destroyed | Double entry + the four reconciliation invariants (§7.4) |
| M8 | Frozen or closed sender | `ACCOUNT_FROZEN`, checked under the same lock |
| M9 | Daily / per-transfer limit | Aggregated over an indexed window, evaluated inside the tx |
| M10 | Expired money request accepted | `expires_at` checked in the conditional update, not in application code |

### 6.5 Network and client behaviour
| # | Scenario | Handling |
|---|---|---|
| N1 | Duplicate submit / double click | UI disables the button + client-generated idempotency key per intent |
| N2 | Client disconnects mid-request | Server still completes or rolls back atomically; state is never ambiguous to a retry |
| N3 | Slow client / oversized body | Body size limit + request timeout |
| N4 | Replay of an old JWT | Short TTL + `jti` + refresh-token reuse detection revokes the family |
| N5 | Redis down | Rate limiter fails open for reads, closed for auth-sensitive routes; the money path is unaffected |
| N6 | Abusive traffic | Token-bucket limits per user and per IP, PIN lockout, audit trail |

### 6.6 Security
Argon2id passwords, separately hashed PIN, short-TTL JWT, refresh rotation with reuse detection, parameterised
SQL only (zero string-concatenated SQL), strict CORS allow-list, Helmet headers, no secrets in logs, exact-match
user search (no enumeration), per-object authorization checks (`payer_id = req.user.id`), and a uniform error
envelope that never leaks internals.

---

## 7. Correctness Guarantees (what we claim on stage)

1. **Atomicity** — a transfer is one Postgres transaction: lock → validate → update both balances → write two
   ledger entries → write the outbox event → complete the idempotency record. All or nothing.
2. **Consistency** — invariants live in the database (CHECK constraints, uniqueness, append-only triggers), not
   only in application code. A rogue script cannot corrupt the books.
3. **Isolation** — `READ COMMITTED` + explicit `SELECT ... FOR UPDATE` in deterministic order, with retry on
   `40001` / `40P01`. Chosen over blanket `SERIALIZABLE` for throughput; documented trade-off.
4. **Durability** — `synchronous_commit = on`; committed means it survives `docker kill`.
5. **Exactly-once effect** — at-least-once delivery + idempotent handlers + the idempotency table.

### 7.4 The four reconciliation invariants (`GET /admin/reconciliation`)
1. `SUM(accounts.balance_minor) = 0` across all accounts (the treasury is negative by exactly what was minted).
2. For every account: `balance_minor = SUM(credits) - SUM(debits)` from `ledger_entries`.
3. For every `COMPLETED` transfer: exactly two entries, equal amounts, opposite directions, net zero.
4. No `COMPLETED` transfer without entries, no entries without a `COMPLETED` transfer, and no orphaned
   `IN_PROGRESS` idempotency rows older than the timeout.

---

## 8. Concurrency Model (the code we will be asked to walk through)

```sql
BEGIN;                                   -- READ COMMITTED
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5s';

-- deterministic ordering kills deadlocks (C2)
SELECT id, balance_minor, status, type
  FROM accounts
 WHERE id IN ($from, $to)
 ORDER BY id
   FOR UPDATE;

-- validate under the lock: status, funds, limits

UPDATE accounts SET balance_minor = balance_minor - $amt, version = version + 1 WHERE id = $from;
UPDATE accounts SET balance_minor = balance_minor + $amt, version = version + 1 WHERE id = $to;
--   CHECK (balance_minor >= 0) is the final, un-bypassable guard

INSERT INTO transfers      (...) VALUES (...);
INSERT INTO ledger_entries (...) VALUES (debit_row), (credit_row);
INSERT INTO outbox_events  (...) VALUES (...);
UPDATE idempotency_keys
   SET state = 'COMPLETED', response_status = 201, response_body = $json
 WHERE id = $key;
COMMIT;
```

Points we defend: no network or external I/O inside the transaction; the lock window is sub-millisecond; the
idempotency completion is *inside* the same commit (that is what makes I4 and I5 work); retries live in a single
`withTransaction(fn, { retryOn: ['40001', '40P01'] })` helper so no module reinvents them.

---

## 9. Scaling to 10M+ Users (Rubric #3)

With the extended timeline, the right-hand column is **built and demonstrated**, not merely described.

| Dimension | Mechanism | Status |
|---|---|---|
| API tier | Stateless Node processes, no in-process state; 3 replicas behind a reverse proxy | **Built** — correctness proven across replicas, not just across requests |
| Connections | PgBouncer transaction pooling + bounded app pool | **Built** |
| Reads | Streaming replica for history/notifications; writes on the primary; read-your-writes via post-write LSN stickiness | **Built** |
| History tables | Monthly range partitions on `transfers` / `ledger_entries` + automated partition manager; cold-partition archival | **Built** (archival scripted) |
| Pagination | Keyset cursor — size-independent, never `OFFSET` | **Built** |
| Accounts | Hash-shard by `user_id`; cross-shard transfers via a reservation saga (reserve → commit → release + timeout compensation) | **Built**, feature-flagged, independently tested |
| Hot accounts | Balance striping — N sub-balances per hot account + async aggregation | **Built**, with a contention benchmark showing before/after |
| Async work | In-DB outbox + `SKIP LOCKED` dispatcher publishing to Redpanda; idempotent consumers | **Built** |
| Cache | Redis balance cache with version-stamped invalidation | **Built** |
| Failure handling | Toxiproxy fault matrix, container kills, replica failover drill | **Built** as an automated suite |
| Evidence | k6 steady / spike / soak with thresholds enforced in CI; Grafana dashboards; Jaeger traces | **Built** — p50/p95/p99 and TPS published in `docs/load-results.md` |

**Capacity sketch:** 10M users at ~2 transfers/user/month ≈ 20M transfers/month ≈ 8 TPS average, ~100–500 TPS
peak. A single well-indexed Postgres primary handles that comfortably; the honest bottleneck is *per-account*
contention, not global throughput — which is why the scaling story is hot-row striping and partitioning, not
microservices.

---

## 10. Code Quality Standards (Rubric #5)

- TypeScript `strict` and `noUncheckedIndexedAccess`; no `any` in `src/` (lint-enforced).
- One responsibility per file; services are pure business logic and accept a `tx` handle.
- All SQL parameterised and confined to `*.repo.ts`.
- Typed domain errors (`DomainError` subclasses) mapped to HTTP in one place.
- Zod schemas shared across validation, types, and OpenAPI generation.
- Every module carries a header comment stating its invariant.
- Conventional commits, `.env.example`, one-command bootstrap (`docker compose up`), seeded demo users.
- README with an architecture diagram, numbered ADRs under `docs/adr/`, a runbook, and the demo script.
- CI gates on every push: ESLint, `tsc --noEmit`, unit + integration + concurrency + invariant suites, a
  chaos smoke test, a k6 smoke run with thresholds, and a Trivy scan of the built image.
- Coverage floor on `src/modules/**` and `src/platform/**`; the transfer and idempotency paths are held to a
  higher bar than the rest of the codebase, because that is where money lives.

---

## 11. Demo Script (the five minutes that carry the marks)

1. **Register** two users — both instantly hold ৳100,000, minted from the treasury (show the ledger rows).
2. **Send ৳2,500** from A to B — balances update, receipt with reference, both histories reflect it.
3. **Request ৳1,200** from B — B accepts, settlement is atomic; click Accept again ⇒ `INVALID_STATE`.
4. **Idempotency:** replay the exact transfer 20× with the same key ⇒ one transfer, identical responses,
   `Idempotent-Replay: true`.
5. **Concurrency:** fire 50 parallel ৳10,000 transfers from an account holding ৳100,000 ⇒ exactly 10 succeed,
   40 rejected with `INSUFFICIENT_FUNDS`, **final balance exactly 0, never negative**.
6. **Crash:** `docker kill` the database mid-burst ⇒ API returns 503 ⇒ restart ⇒ **reconciliation all PASS**,
   and the retried idempotent requests resolve correctly.
7. **Reconciliation:** all four invariants green, `SUM(balances) = 0`.
8. **Network faults:** with Toxiproxy, add 2 s of latency and then sever the API↔DB link mid-transfer — the
   client's retry with the same key still yields exactly one movement.
9. **Horizontal scale:** three API replicas serving the same burst; show that outbox events are consumed once
   (`SKIP LOCKED`) and no notification is duplicated.
10. **Read replica:** history served from the replica while writes go to the primary — and a user who has just
    sent money still sees their own new balance immediately (read-your-writes).
11. **Hot-account contention:** benchmark the treasury account with and without balance striping; show the
    throughput difference on the Grafana dashboard.
12. **Cross-shard transfer:** move money between two shards via the reservation saga; kill the coordinator
    mid-saga and show the timeout sweeper releasing the reservation with the books still balanced.
13. **Load:** live k6 spike run with the Grafana dashboard and a Jaeger trace of a single transfer, ending on
    `docs/load-results.md`.

---

## 12. Success Criteria

**Must be true at submission**
- [ ] `docker compose up` boots the entire stack (proxy, 3 API replicas, primary + replica, PgBouncer, Redis,
      Redpanda, Prometheus, Grafana, Jaeger, web) on a clean machine.
- [ ] Register → send → request → accept → schedule → reverse → history works end to end in the browser.
- [ ] Concurrency suite proves no negative balance and no lost or created money, under 500 parallel requests.
- [ ] Idempotency suite proves single execution under retry, replay, in-flight duplication, and payload reuse.
- [ ] Chaos suite passes: DB kill, API kill, Redis down, Redpanda down, severed and lagged network links,
      replica failover — reconciliation is PASS after every one of them.
- [ ] Property-based invariant test survives 10,000 randomised operations.
- [ ] Reconciliation endpoint returns all invariants PASS, live, on stage.
- [ ] k6 thresholds pass in CI; `docs/load-results.md` publishes p50/p95/p99 and TPS.
- [ ] Partitioning, read-replica routing, striping, and the cross-shard saga are demonstrable, not just written.
- [ ] Every test suite runs green in GitHub Actions on the final commit.
- [ ] README, ADRs, architecture diagram, and runbook explain every engineering decision.

**Explicitly accepted trade-offs (state them, do not hide them)**
- Sharding is implemented for two logical shards to prove the mechanism, not operated as a production topology
  (no automated rebalancing or shard splitting).
- Failover is a manual drill; there is no automated leader election (Patroni-class HA is out of scope).
- Notifications are in-app and WebSocket; no SMS, email, or mobile push.
- No real payment rails, real KYC, or FX (per the brief's scope).
- Fraud/AML is limited to rate limits, PIN lockout, velocity limits, and the audit trail — not a risk engine.
