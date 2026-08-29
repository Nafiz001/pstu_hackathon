-- 006_treasury_stripes.sql — hot-account balance striping.
--
-- THE PROBLEM. Every registration mints BDT 100,000 out of the treasury, and every mint takes a
-- row lock on the treasury account. One row, one lock, so registrations serialise: the tenth
-- concurrent signup waits behind nine others no matter how many API replicas are running. The
-- ledger is not the bottleneck — a single contended row is.
--
-- THE FIX. Split the hot account into N stripes and send each write to a random one. Contention
-- falls by a factor of N because two concurrent mints now collide only when they pick the same
-- stripe. This is the standard remedy for a hot row, and it applies to any high-inbound account:
-- a treasury, a merchant, a payroll float.
--
-- WHY STRIPES ARE ACCOUNTS RATHER THAN A NEW TABLE. A separate `account_stripes` table would
-- need its own locking rules, its own aggregation, and its own place in reconciliation — a
-- second way to hold money, which is exactly what this codebase refuses to have. Modelling a
-- stripe as an ordinary SYSTEM account means the ledger, the double-entry rules, the constraints
-- and all four invariants apply to it unchanged. "The treasury" simply becomes a set of accounts
-- whose balances sum to the negative of all money issued.

INSERT INTO accounts (id, user_id, type, status, balance_minor, shard_key)
SELECT ('00000000-0000-0000-0000-00000000000' || to_hex(n))::uuid, NULL, 'SYSTEM', 'ACTIVE', 0, n
  FROM generate_series(2, 8) AS n
ON CONFLICT (id) DO NOTHING;

-- Stripe 1 is the original treasury from migration 004; label it consistently.
UPDATE accounts SET shard_key = 1 WHERE id = '00000000-0000-0000-0000-000000000001';
