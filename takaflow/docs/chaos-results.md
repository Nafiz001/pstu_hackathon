# Chaos results

Reproduce with:

```bash
docker compose --profile scale up -d
node backend/scripts/chaos.mjs http://127.0.0.1:18090
```

Every scenario breaks something real — no mocks, no simulated failures. The database is actually
killed. Each one ends by demanding that `GET /admin/reconciliation` returns `PASS`.

**Status: all 7 scenarios pass, repeatedly.**

## The claim being tested

Not "the system stays up". Under a database kill it will not, and pretending otherwise would be
dishonest. The claim is narrower and more useful:

> Whatever the system does while a fault is active, the books are never wrong afterwards, and the
> client's retry is always safe.

## Scenarios

| # | Fault | Injected with | Result |
|---|---|---|---|
| N5 | API severed from Redis | Toxiproxy `enabled: false` | Transfers still commit (201); balances still readable. Cache and rate limiter are never a source of truth. |
| A3 | 4 s latency on every DB round trip | Toxiproxy latency toxic | Request abandoned on **our** 5 s transaction deadline (503), not on the proxy's 20 s timeout (504). Locks released. |
| N2 | Connection severed mid-payment | Toxiproxy proxy disabled mid-flight | Retry with the same `Idempotency-Key` resolved; sender balance is one of exactly two legal values — the payment happened once or not at all. |
| A1 | API replica killed mid-transfer | `docker kill` | Cluster recovered; **no money lost** (200,000.00 still accounted for). |
| A7 | SIGTERM under load | `docker kill --signal=SIGTERM` | 30 of 30 in-flight transfers committed while the node drained. |
| — | Standby frozen while a user reads | `pg_wal_replay_pause()` | Payer still saw their own payment (routed to primary); an unrelated user kept using the replica. |
| A2 | **Database killed mid-burst** | `docker kill takaflow-db` | 60 requests failed or were shed; on restart reconciliation **PASS**; 20 retries with original keys all resolved definitively; balances exact. |

## Six bugs this work found

### 1. A transaction can hold locks far longer than any configured timeout

The latency scenario originally ran for **20 seconds** and died at nginx's `proxy_read_timeout`,
with `statement_timeout = 5s` and `idle_in_transaction_session_timeout = 10s` both armed and
neither firing.

Neither could fire. `statement_timeout` bounds how long the *server* spends executing a statement,
which was microseconds. `idle_in_transaction_session_timeout` bounds a *single* idle gap, and each
gap was only 4 s. A transfer makes about a dozen round trips; multiply each by network latency and
the transaction sits on two account rows for tens of seconds while every server-side guard reports
itself comfortably within limits.

**Postgres cannot bound this, because it cannot see time spent on the wire.** The fix is an
application-enforced wall-clock deadline (`TRANSACTION_DEADLINE_MS`, default 5 s) checked before
every statement — the only place that time is visible. The transaction preamble was also collapsed
from three round trips into one, so the budget is not consumed before the first check runs.

The scenario now returns 503 at 16 s instead of 504 at 20 s. The remaining 16 s is arithmetic —
PIN verification, preamble, and rollback at 4 s per round trip — and the assertion checks *who
gave up*, not how long it took.

### 2. Graceful shutdown was not graceful

SIGTERM under load ended in `graceful shutdown timed out; forcing exit`. Fastify's `close()` was
waiting for nginx's pooled keep-alive sockets to go away on their own; they never did, the 10 s
drain deadline expired, and a graceful shutdown became a forced kill — the exact opposite of the
intent.

Fixed with `forceCloseConnections: 'idle'`: sockets mid-request are respected, sockets merely being
held open are not. The scenario now reports **30 of 30 committed while a node was draining**.

### 3. The load balancer was the outage

Several early "chaos failures" were nginx returning HTML 502s while the API was perfectly healthy.
nginx resolves the hostnames in an `upstream` block **once, at configuration load**, and caches
them for the process lifetime. Recreate the API containers, they get new IPs, and the proxy keeps
dialling the old ones.

Fixed by dropping the `upstream` block in favour of Docker's embedded DNS (`resolver 127.0.0.11
valid=2s`) with a variable in `proxy_pass`, which forces re-resolution. The three named API
services were collapsed into one service with `replicas: 3` so DNS returns one A record per
replica.

The trade-off is stated rather than hidden: DNS-based routing has no passive health check, so
after a replica dies there is a window of up to 2 s in which the proxy may still dial it. A
production edge would use health-checked routing.

### 4. A repository was taking a second connection inside a transaction

Found while hardening the concurrency suite, not by the chaos suite — but it is the most serious
bug in this list, so it belongs with them.

Ten simultaneous accepts of one money request all returned 503. A lock-graph dump showed the
would-be winner sitting `idle in transaction` for five seconds, holding the row lock, while every
other session timed out behind it:

```
5086 Lock/transactionid blocked_by=5071 :: SELECT * FROM money_requests ... FOR UPDATE
5535 [idle in transaction] xact_age=4.9 :: UPDATE money_requests SET status = 'ACCEPTED' ...
```

`acceptRequest` called `findUserById`, and that repository function used the **connection pool**
rather than the caller's transaction. So a transaction holding row locks stopped to queue for a
*second* connection. Once concurrency approaches the pool size this cannot resolve: every
transaction holds one connection and waits for another that will never be free — a pool
self-deadlock, with row locks held throughout.

Fixed by giving repositories an explicit `Executor` parameter (satisfied by both a transaction and
the pool) so the dependency is visible in the type, and by threading `tx` through every call site
inside a transaction. The suite now passes at the production pool size.

### 5. The load balancer was unreachable over IPv6

A late symptom that looked like a total outage: `curl http://localhost:18090` hung, while the same
request from inside the Docker network was instantly fine.

`localhost` resolves to `::1` first on Windows. The nginx image's entrypoint normally injects an
IPv6 listener, but it cannot edit a configuration file mounted read-only, so it silently skipped
it. An explicit `listen [::]:80;` is now in the config, and the scripts address `127.0.0.1` rather
than `localhost` so host resolution order cannot matter.

### 6. IPv6 loopback stalled the Postgres handshake, not the TCP connect

Two tests failed intermittently — one dispatcher race with `timeout exceeded when trying to
connect`, one accept race returning 503 where 409 was expected — while the database sat idle with
three open connections and `max_connections` at 300. The pool was not exhausted: it was creating
connections that never finished.

Measured directly, 20 simultaneous `pg.Client` connections per host:

| host | connections | failures |
| --- | --- | --- |
| `127.0.0.1` | 20 x 3 rounds | 0 |
| `::1` | 20 x 3 rounds | 13, 3, 0 |
| `localhost` | 20 x 3 rounds | 16, 0, 0 |

A raw TCP connect to `[::1]:5433` always succeeded in single-digit milliseconds, so the socket was
never the problem; it was the Postgres startup and authentication exchange that stalled behind
Docker Desktop's IPv6 loopback forwarder, until `pg` abandoned it at `connectionTimeoutMillis`.
Because `localhost` resolves to `::1` first on Windows, the failure rate was a coin flip per run.

Every host URL is now written as `127.0.0.1` (see the note in `.env.example`). Beyond fixing the
two failures, the full suite dropped from 174s to 100s: several passing tests had been quietly
paying five seconds for a stalled handshake and retrying. Same root cause as #5, one layer down.

## What is deliberately not claimed

- **No automated failover.** The replica is promoted by hand. Patroni-class HA is out of scope,
  and the drill is manual (`scripts/verify-read-your-writes.mjs`).
- **Availability is not the promise.** When the database is down, the API returns 503. It is
  designed to fail closed and stay correct, not to stay up.
- **The chaos suite runs against the same database as the demo.** A production version would run
  it against a dedicated compose project so a failed run cannot disturb a live demo.
