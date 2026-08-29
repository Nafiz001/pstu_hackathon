# Load test results

Reproduce with:

```bash
docker compose --profile scale --profile obs up -d   # proxy on http://127.0.0.1:18090
docker compose --profile load run --rm -e SINKS=40 k6 run /scripts/transfer.js   # uncontended
docker compose --profile load run --rm -e SINKS=1  k6 run /scripts/transfer.js   # hot account
```

## The machine these numbers came from

**This matters more than the numbers.** The entire stack — 3 API replicas, Postgres primary,
streaming replica, PgBouncer, Toxiproxy, Redis, nginx, Prometheus, Grafana, and the k6 container
generating the load — shares **4 vCPUs and 2.3 GB of RAM** inside Docker Desktop on a Windows
laptop. The load generator competes with the system it is measuring.

So these figures are a *floor*, not a capacity estimate, and the shape of the results is what is
worth reading, not the absolute throughput.

## Steady load — 20 VUs, 60 s, transfers only

Accounts are created in `setup()`, so each measured iteration is one `POST /transfers` and
nothing else. An earlier version of the script registered an account inside every iteration; that
added two Argon2id hashes per measurement and produced a p95 of 2.09 s that described password
hashing rather than the ledger. Registration throughput is a real number, but it is a different
number.

| Metric | 40 recipients (uncontended) | 1 recipient (hot account) |
|---|---|---|
| Transfers committed | 2,592 | 2,307 |
| Throughput | **38.1 /s** | 36.8 /s |
| HTTP p50 | **419 ms** | 228 ms |
| HTTP p95 | **829 ms** | **1,850 ms** |
| HTTP max | 1.90 s | 4.79 s |
| Failed requests | **0** | **0** |
| Transaction retries (40001/40P01) | **0** | 0 |
| Postgres statements > 500 ms | **0** | **214** |
| Reconciliation after run | **PASS** | **PASS** |

Transaction duration, measured inside the application from `BEGIN` to `COMMIT` — this is how long
account rows stay locked:

| Percentile | Uncontended |
|---|---|
| p50 | 185 ms |
| p95 | 470 ms |

## What the numbers say

**1. Lock contention is real, measurable, and localised.**

Pointing every virtual user at one recipient account more than doubled p95 (829 ms → 1,850 ms)
while barely moving throughput. Postgres logged **214 statements over 500 ms during the contended
run and zero during the uncontended one**, and every one of them was the same statement:

```
duration: 1182.120 ms  execute <unnamed>: SELECT id, user_id, type, status, balance_minor, version
```

That is `lockAccount`'s `SELECT … FOR UPDATE` waiting for the row. The system was not slow; it was
queueing, exactly where the design says it would.

This is the same problem the treasury has — every registration mints from it — and the fix is
already built and measured: striping that account across 8 rows took minting from **121 to 581
mints/s, a 4.80× improvement** (`npx tsx scripts/bench-striping.ts`). The identical remedy applies
to any high-inbound account: a merchant, a payroll float, a utility biller.

**2. Throughput here is CPU-bound, not database-bound.**

Removing contention barely changed throughput (36.8 → 38.1 /s), the connection pool never had a
waiter, and zero transactions were retried. With 4 vCPUs shared by the whole stack, the ceiling is
CPU, and the largest single consumer is deliberate: Argon2id PIN verification at 19 MiB and ~50 ms
per transfer. HTTP p50 (419 ms) minus transaction p50 (185 ms) leaves roughly 230 ms per request
spent outside the transaction, which is where that hashing lives.

We would not tune the hashing down to improve this benchmark. A 4-digit PIN has 10,000 possible
values; the cost of verifying it is the defence. The right lever is more API replicas, which are
stateless and already run three at a time.

**3. Nothing was lost, under either shape.**

Zero failed requests, zero retries, and `reconciliation after load: PASS` in the k6 teardown for
every run. The load test fails itself if the books do not balance afterwards.

## Honest gaps

- The p95 SLO of 500 ms is **not met** on this hardware (829 ms uncontended). We are reporting
  the failure rather than relaxing the threshold, because a threshold that moves to match the
  result measures nothing. On hardware where the load generator is not competing with the system
  for 4 cores, transaction p50 of 185 ms is dominated by scheduling delay and should fall sharply.
- The soak profile (`PROFILE=soak`, 10 minutes) has not been run to completion here.
- Read-path load (history, receipts) is not separately profiled; those reads are served by the
  replica and are index-only keyset scans, but that claim is currently supported by `EXPLAIN`
  rather than by a load run.
