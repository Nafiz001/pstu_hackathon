# TakaFlow — Demo & Defence Guide

**For:** the person driving the laptop while the judges watch.
**Contains:** what is running, where to click, and the exact sentence to say at each click.

> The single claim this whole demo defends:
> **the system is provably incapable of losing, creating, or duplicating money — and every
> claim we make has a check on screen that would fail if the claim stopped being true.**

---

## 0. Before the judges arrive (2 minutes)

The stack is already up. Confirm it in one command:

```bash
cd takaflow
docker compose ps
```

You want 12 containers `Up`. If anything is missing:

```bash
docker compose --profile scale --profile obs up -d
```

Then confirm the API is alive through the load balancer:

```bash
curl http://127.0.0.1:18090/healthz
# {"status":"ok","instance":"149476ab2aeb","uptime":30.6}
```

**Open these browser tabs before you start. Do not open them on stage.**

| Tab | URL | Used in |
|---|---|---|
| 1. The app | http://127.0.0.1:18080 | Acts 1–2 |
| 2. The app, second window (incognito) | http://127.0.0.1:18080 | Act 1 — the other user |
| 3. Grafana | http://127.0.0.1:3001 | Act 3 |

Have one terminal open at `takaflow/backend`.

### Demo accounts (already registered and funded)

| Name | Mobile | Password | PIN |
|---|---|---|---|
| Rahim Uddin | `01711100001` | `correct-horse-battery` | `1234` |
| Karim Hossain | `01711100002` | `correct-horse-battery` | `1234` |

Sign Rahim into tab 1 and Karim into tab 2 (incognito) **before** the judges sit down. Registering
live is a nice moment, but do it as a bonus — not as the thing standing between you and your demo.

### Numbers you will be asked for

| Thing | Value |
|---|---|
| Signup credit | ৳100,000, minted from the treasury as a real double-entry movement |
| Minimum transfer | ৳1.00 |
| Maximum single transfer | ৳50,000 |
| Daily send limit | ৳200,000 |
| Reversal window | **60 seconds** — short on purpose |
| PIN lockout | 5 wrong attempts |
| Scheduler tick | every 15 seconds |
| Money representation | `bigint` poisha, end to end. No floating point anywhere. |

---

## 1. The opening sentence

Say this before you touch anything:

> "Moving money is easy. Moving money **exactly once** — when the network is dropping, when two
> people press send at the same instant, and when a server dies mid-payment — is the actual
> problem. So we built the product surface a real user needs, and then we built the evidence that
> it is correct. Both are on this screen."

Then go to the app.

---

## 2. Run of show

Three acts, roughly 5 minutes each. If you are cut to 5 minutes total, do **Act 1 step 1.2** and
**Act 2 entirely**, and skip the rest. Act 2 is where the marks are.

---

### ACT 1 — It is a real product (5 min)

#### 1.1 Overview

**Click:** the app, already signed in as Rahim → lands on **Overview**.

**Point at the balance and say:**
> "৳100,000. That was not typed into a column at signup. Registration is one database
> transaction: create the user, create the account, lock the platform treasury, write a MINT
> transfer and two ledger entries. If any step fails, the user does not exist. There is no
> 'create the user now, fund them later' — that is the gap money escapes through."

**Point at the sidebar:**
> "Send, Requests, Split a bill, Scheduled, Transactions — the things someone actually does with
> money. And Engineering, which I will come back to."

#### 1.2 Send money — the core path

**Click:** **Send** → type Karim's number `01711100002`.

**Wait for the name to resolve, and say:**
> "It resolves the exact number and shows the name. There is deliberately no name search — you
> should not be able to browse for strangers to pay in a money app."

**Type `2500`. Point at the right-hand card *before* pressing send:**
> "This panel is not decoration. It is the order of operations for what is about to happen, and
> every line of it is a decision we can defend."

Read the four points out loud, or paraphrase:
1. The browser attaches an **idempotency key for this intent** — minted when the form opens, not when the button is clicked.
2. The server locks both accounts **in ascending id order**, so two people paying each other simultaneously cannot deadlock.
3. The balance is checked **under that lock**, not before it.
4. One transaction writes the transfer, two ledger entries summing to zero, both balances, and the notification event. All of it commits, or none of it does.

**Click Review and send → PIN `1234` → send.**

> "Receipt with a reference. Balance updated. And a PIN on every payment — the password gets you
> into the app, the PIN moves money. Both are Argon2id hashes with separate salts."

**Switch to tab 2 (Karim). Refresh.** The money is there, with a notification.

#### 1.3 Request money — the second scenario from the brief

**In tab 2 (Karim):** **Requests** → Ask for money → `01711100001`, `1200`, note "Dinner on
Friday" → Send request.

> "The brief's second user: *my friend owes me ৳1,200.* A request never moves money by itself. It
> is a proposal with a state machine — pending, accepted, declined, cancelled, expired — and only
> the side entitled to act can move it."

**Switch to tab 1 (Rahim):** Overview shows it under **Needs your attention** → **Requests** →
**Pay** → PIN.

> "Accepting is not two operations. The guarded state change and the transfer happen in **one**
> transaction, reusing the exact same transfer code path. There is no second copy of the ledger
> logic that could drift from the first."

**Then show the double-accept case:** the request is now gone from pending — refresh to confirm.

> "The state transition is a conditional UPDATE in SQL: `WHERE status = 'PENDING' AND payer = me`.
> If it updates zero rows, that is `INVALID_STATE`. The rule lives in the database, in the same
> statement that changes the state — not in a JavaScript `if` that two concurrent requests can
> both pass."

#### 1.4 Split a bill

**Click:** **Split a bill** → description "Dinner at Star Kabab", total `3000`, add Karim's
number, tick "I ate too" → create.

> "A ৳3,000 bill split three ways. Watch the shares: they are allocated in poisha and they add up
> to exactly ৳3,000 — never 1,000.00, 1,000.00, 999.99. The remainder is distributed, not rounded
> away. A bill that does not add up is money invented or destroyed."

**Open the split** → show the legs table.

> "Each leg is an independent request that settles on its own. If everyone pays at the same
> instant, that is separate transactions — and there is a concurrency test for exactly that."

#### 1.5 Scheduled payments

**Click:** **Scheduled** → new schedule → Karim, `5000`, Monthly, first payment today → PIN.

> "Rent on the 1st, with nobody pressing a button. The interesting part is the failure mode. Each
> occurrence is keyed by **the instant it was due** — so a duplicate tick, a scheduler restart, or
> two of our three servers waking at the same moment can only ever produce one payment.
> Occurrences are claimed with `FOR UPDATE SKIP LOCKED`."

**Open the schedule** → occurrence history table.

> "Attempts, status, and the resulting transfer reference. A payment that cannot be made is
> retried with backoff and then recorded as FAILED — never silently skipped. And if the service is
> down for a day, a daily standing order does not fire a day's worth of back-dated payments when
> it returns; anything more than six hours late is recorded as SKIPPED and the owner is told."

#### 1.6 Transactions, receipts, statement, reversal

**Click:** **Transactions**.

**Point at the badge in the card header — `served by replica` / `served by primary`:**
> "That badge is real. History reads are routed to a **read replica** to keep them off the write
> path. But if *you* just sent money, your read is pinned to the primary until the replica has
> caught up — read-your-writes. You will never look at your own payment and fail to see it."

**Show the filters, then click Download statement (CSV).**

> "Filters are index-backed and pagination is keyset, not OFFSET — page 10,000 costs the same as
> page 1. That matters at 10 million users."

**Click a payment you sent → receipt modal → Reverse this payment.**

> "Reversal does not edit the record. It writes a **new, opposite movement** and links the two.
> History is history — the ledger has an append-only trigger, so an UPDATE or DELETE on a ledger
> entry raises an exception at the database level."

⚠️ **The reversal window is 60 seconds.** Reverse something you sent moments ago, or the button
will correctly refuse. If it refuses, that is a *feature* — say so:
> "Sixty seconds. This is 'I picked the wrong person', not a dispute process."

---

### ACT 2 — It is correct under pressure (5 min) — **this is the one that matters**

**Click:** **Engineering** in the sidebar.

> "This page exists because everything interesting about this system is invisible from a normal
> money screen. Nothing here is a screenshot — every panel is queried live."

#### 2.1 The four ledger invariants

**Point at the Ledger invariants card — four green PASS badges.**

| Check | What it means |
|---|---|
| `conservation_of_money` | The signed sum of **every** account balance is exactly zero. Money cannot be created or destroyed — every poisha a user holds is a debit against the treasury. |
| `balances_match_ledger` | Every account's balance column equals the signed sum of its ledger entries. |
| `double_entry_complete` | Every transfer has exactly two entries, equal value, opposite direction. |
| `no_orphans` | No entry without its transfer, no negative user balance, no idempotency claim stranded mid-flight. |

> "These run against the database, not against application state. They are also exported as a
> Prometheus gauge, so a broken invariant becomes an alert at 3am rather than a surprise at a
> quarterly audit."

**If asked "doesn't the balance column duplicate the ledger?"** — yes, deliberately:
> "It is a materialised aggregate for O(1) reads, written in the same transaction as the entries,
> and check #2 verifies continuously that it never drifts."

#### 2.2 The idempotency proof — *the money shot of the demo*

**Point at the "Prove idempotency" card. Set it up before clicking:**

> "This is the double-tap a flaky network produces. I am going to send ৳1.00 to Karim **twice,
> simultaneously, with one idempotency key** — two real HTTP requests, fired in parallel, racing
> each other into three different API servers."

**Enter `01711100002`, PIN `1234`, click "Send it twice".**

**Result: a green banner — "One payment, two identical responses."**

> "Same transfer reference. Same balance. The money moved once. Now the important part: **why**."

> "The idempotency record is completed **inside the same database transaction that moves the
> money** — not after it. That single decision is what makes both crash cases correct. Crash after
> the commit, and a retry with the same key finds COMPLETED and replays the stored response. Crash
> before it, and the retry finds nothing and executes cleanly. **There is no third state.**"

#### 2.3 The outbox

**Point at the Outbox card.**

> "Notifications are written in the same transaction as the money, into an outbox table, then
> delivered by a separate dispatcher. An event exists **if and only if** the movement happened.
> Publishing directly to a message broker cannot give you that — the publish can succeed while the
> transaction rolls back, or fail after it commits."

> "The dispatcher pulls with `FOR UPDATE SKIP LOCKED`, which is what makes it safe to run on all
> three API replicas at once. Failed events are kept and retried with backoff, then parked — never
> dropped."

#### 2.4 This instance

**Point at the "This instance" card, then press Re-check two or three times.** The instance id
changes.

> "That is a different container each time. Three stateless API replicas behind nginx — so the
> idempotency guarantee and the outbox both have to hold **across processes**, not just across
> requests inside one process. That is a much harder property, and it is the one being
> demonstrated right now."

#### 2.5 The concurrency case — the burst

This one has no button, so run it from the terminal. **It is the single most convincing thing you
can show.**

```bash
cd backend
node scripts/gate.mjs http://127.0.0.1:18090
```

**While it runs:**
> "It is firing dozens of parallel ৳10,000 transfers out of one ৳100,000 account, through the load
> balancer, into three servers, against one row. Exactly ten can succeed. The rest must be rejected
> with INSUFFICIENT_FUNDS. The final balance must be exactly zero — never negative, not even for a
> microsecond, and not by one poisha."

**When the PASS lines print:**
> "And the last line of defence is not our code. The accounts table has
> `CHECK (balance_minor >= 0)`. If every guard we wrote were wrong, Postgres would still refuse to
> write a negative user balance."

---

### ACT 3 — It survives things going wrong, and it scales (5 min)

#### 3.1 Chaos — break it on purpose

```bash
node scripts/chaos.mjs http://127.0.0.1:18090
```

**Say this up front, clearly:**
> "The claim is *not* that the system stays up under these faults. It will not, and it should not
> pretend to. The claim is that **whatever it does under a fault, the books are never wrong
> afterwards, and the client's retry is always safe.** Every scenario ends the same way: heal the
> fault, then demand that reconciliation passes."

Faults it actually injects — Toxiproxy for network conditions, `docker kill` for process failures.
Nothing is mocked; **the database really dies**:

| Fault | What we assert |
|---|---|
| API severed from Redis | Transfers still commit. Cache and rate limiter are never a source of truth. |
| 4 s latency on every DB round trip | Abandoned on **our** 5 s transaction deadline, not left hanging. Locks released. |
| Connection severed mid-payment | Retry with the same key resolves. The balance is one of exactly **two** legal values — the payment happened once, or not at all. Never one and a half times. |
| API replica killed mid-transfer | No money lost; the total is still exactly accounted for. |
| SIGTERM under load | 30 of 30 in-flight transfers committed while the node drained. |
| Replica frozen mid-read | The payer still saw their own payment (routed to the primary); other users kept using the replica. |
| **Database killed mid-burst** | Requests fail loudly; on restart reconciliation **PASS**, and 20 retries with the original keys all resolved definitively. |

**Then open `docs/chaos-results.md` and scroll to "Six bugs this work found".**

> "This is the part I would most like you to read. Chaos testing that finds nothing is theatre.
> This found six real bugs — including a transaction that could hold row locks far longer than any
> configured Postgres timeout, and a graceful shutdown that was not graceful. Each is written up
> with its fix. We would rather show you the bugs we found than claim we never had any."

#### 3.2 Scale

**Open Grafana (tab 3): http://127.0.0.1:3001** — the TakaFlow dashboard.

> "Throughput, latency percentiles, error taxonomy, lock-wait time, outbox lag, replica lag, and
> reconciliation status. The SLOs are written down, with alert rules behind them."

**Then open `docs/load-results.md`.**

> "Measured, not asserted — and on a laptop running the entire topology, database included. Under
> sustained load: zero failed requests, zero transaction retries, reconciliation PASS afterwards.
> We also ran a deliberately pathological case — every payment into **one** recipient account,
> maximum row contention — and it still committed everything correctly, just slower. We published
> both columns, including the one that looks worse."

**The 10-million-user answer, if asked:**
> "Stateless API replicas behind a load balancer; PgBouncer in transaction pooling mode; a read
> replica with read-your-writes safety; monthly table partitions so the working set stays small;
> keyset pagination so deep pages stay cheap; hot-account balance striping for contended accounts;
> and a Redis cache that is never authoritative. All of it is running on this machine right now —
> it is not a slide."

---

## 3. Every case, and exactly where to show it

The lookup table for when a judge asks "can you show me X?"

| The case a judge will ask about | Where | One-line answer |
|---|---|---|
| Send money | Send | Locks in id order, balance checked under the lock, one transaction |
| Request money | Requests | A proposal with a state machine; never moves money by itself |
| **Double-tap / duplicate submit** | **Engineering → Prove idempotency** | One key per intent; completion written inside the money transaction |
| **Two people spend the same balance** | **`node scripts/gate.mjs`** | `SELECT … FOR UPDATE`, then `CHECK (balance_minor >= 0)` as the floor |
| Overdraft / negative balance | same | Cannot happen; enforced by the database, not by our code |
| Deadlock (A→B while B→A) | Send, or the gate script | Deterministic lock ordering by account id + bounded retry on 40P01 |
| Double-accept a request | Requests → Pay, then again | Conditional UPDATE; 0 rows updated ⇒ `INVALID_STATE` |
| Expired / cancelled request | Requests | Same conditional-update pattern; only the entitled side can act |
| A split that does not divide evenly | Split a bill | Allocated in poisha; shares sum to the bill exactly |
| Scheduled payment fires twice | Scheduled → occurrence history | Occurrence keyed by due instant; `SKIP LOCKED` claim |
| Scheduler was down for a day | Scheduled | 6-hour catch-up grace; later occurrences recorded SKIPPED, not fired |
| Undo a payment | Transactions → receipt → Reverse | Compensating entry, never an edit; 60-second window |
| Can history be tampered with? | Engineering + schema | Append-only trigger — UPDATE/DELETE on a ledger entry raises an exception |
| **Server dies mid-transfer** | **`node scripts/chaos.mjs`** | Rollback; retry sees COMPLETED or nothing. No third state. |
| Network drops mid-payment | chaos script | The balance is one of exactly two legal values |
| Redis is down | chaos script | Money still moves; Redis is a cache and a rate limiter, never truth |
| Event delivery is down | Engineering → Outbox | Transfers still commit; the outbox backs up and drains, no duplicates |
| Stale balance after my own payment | Transactions → `served by` badge | Read-your-writes: pinned to the primary until the replica catches up |
| Does it balance? | Engineering → Ledger invariants | Four checks, live, against the database |
| Does it scale? | Grafana + `docs/load-results.md` | Measured numbers, published including the unflattering column |
| Which server served me? | Engineering → This instance | Changes per refresh; three stateless replicas |
| PIN brute force | any PIN prompt | Locked after 5 failures |
| Stolen refresh token | — | Rotated on every use; reuse of a rotated token revokes the whole family |

---

## 4. Judge Q&A — rehearse these ten

1. **"What happens if the server dies mid-transfer?"**
   Postgres rolls back the uncommitted transaction. Because the idempotency completion is written
   *inside* that same transaction, a retry with the same key either sees COMPLETED — the crash was
   after commit, so we replay the stored response — or sees nothing, and executes cleanly. There is
   no third state, and the chaos suite proves it by actually killing the database.

2. **"Two people send from the same account at the same instant?"**
   Both take `SELECT … FOR UPDATE`; one waits. The balance check happens *after* the lock, not
   before. And `CHECK (balance_minor >= 0)` is a database-level floor even if our application code
   were wrong. Demonstrated with a live parallel burst.

3. **"Why READ COMMITTED and not SERIALIZABLE?"**
   The write path already takes explicit row locks in a deterministic order, which gives the
   isolation we need with far less abort churn. We retry 40001 centrally anyway, so raising the
   level is a one-line change.

4. **"How do you avoid deadlocks?"**
   Locks are always acquired ordered by account id, so opposite transfers request the same rows in
   the same sequence. Plus a `lock_timeout` and a bounded retry on 40P01.

5. **"Doesn't the balance column duplicate the ledger?"**
   Deliberately. It is a materialised aggregate for O(1) reads, written in the same transaction as
   the entries, and invariant #2 verifies continuously that it never drifts.

6. **"How does this reach 10 million users?"**
   Stateless replicas, PgBouncer, a read replica with read-your-writes, monthly partitions, keyset
   pagination, and hot-account striping. All running here — we can show you the dashboards.

7. **"Why an outbox instead of publishing directly?"**
   A direct publish can succeed while the transaction rolls back, or fail after it commits. The
   outbox row commits atomically with the money, so the event exists if and only if the money moved.

8. **"What if Redis is down?"**
   Money still moves. Redis is a cache and a rate limiter, never a source of truth. We test that
   outage rather than assuming it.

9. **"Why Node and not Go or Rust?"**
   Every guarantee that matters here — atomicity, isolation, durability, the non-negative
   constraint, the append-only ledger — is enforced by Postgres, not by the runtime. Changing
   language would not alter a single one of them, and we would rather spend the time on ledger
   correctness and evidence.

10. **"What is *not* done?"**
    Automated shard rebalancing, automated HA failover, real payment rails, real KYC/AML, and mobile
    push. We are stating that deliberately, not being caught out by it. Say this one confidently —
    judges trust a team that knows its own edges.

---

## 5. If something breaks on stage

| Symptom | Do this |
|---|---|
| A page shows a red error banner | It carries a `requestId`. Say so — "every error is traceable to one request" — then reload. |
| Login fails | The access token lives in memory and dies with the tab. Sign in again. |
| Reversal button refuses | The 60-second window closed. **That is correct behaviour** — say so, then reverse a fresh payment. |
| A container is unhealthy | `docker compose ps`, then `docker compose --profile scale --profile obs up -d`. |
| Chaos script left a fault injected | It heals its own faults, but to force it: `docker compose restart toxiproxy` |
| Everything is confusing | Go to **Engineering** and press Re-check. Four green badges rescue any moment. |
| Total reset | `docker compose down -v && docker compose --profile scale --profile obs up -d`, then re-register users. Takes ~2 minutes. **Never do this with under 5 minutes left.** |

---

## 6. What we deliberately did not build

Volunteer this before you are asked. It reads as judgement, not as a gap.

- No real bank, card, or payment-gateway integration — the brief scoped this as a closed system.
- No automated shard rebalancing or automated HA failover.
- No KYC/AML or fraud scoring beyond limits and velocity checks.
- No mobile push notifications; notifications are in-app.
- The admin API is guarded by a shared secret, and is honest about being one rather than pretending
  to be per-person operator credentials.

> "We would rather ship a small system where every claim is checked than a large one where most of
> them are hoped for."

---

## 7. Command cheat-sheet

```bash
cd takaflow

docker compose ps                                    # what is running
docker compose --profile scale --profile obs up -d   # bring everything up
docker compose logs -f api                           # live API logs, all three replicas
docker compose down -v                               # full reset (destroys data)

cd backend
node scripts/gate.mjs   http://127.0.0.1:18090       # concurrency + idempotency, over real HTTP
node scripts/chaos.mjs  http://127.0.0.1:18090       # inject faults, demand reconciliation PASS
node scripts/smoke.mjs                               # quick end-to-end through the load balancer
node scripts/verify-read-your-writes.mjs             # replica routing + read-your-writes
npm test                                             # the full suite (unit → concurrency → property)
```

| Service | URL |
|---|---|
| App | http://127.0.0.1:18080 |
| API (via nginx → 3 replicas) | http://127.0.0.1:18090/api/v1 |
| Grafana | http://127.0.0.1:3001 |
| Prometheus | http://127.0.0.1:9090 |
| Toxiproxy control | http://127.0.0.1:8474 |
| Postgres primary / replica | `127.0.0.1:5433` / `127.0.0.1:5434` |

---

## 8. The closing line

> "Every number on that Engineering page was queried live, from the database, while you watched. If
> any one of those four invariants ever went red, we would want to know before you did — which is
> why it is an alert, not a slide."
