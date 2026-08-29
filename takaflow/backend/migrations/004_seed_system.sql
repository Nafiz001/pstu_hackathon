-- 004_seed_system.sql — the treasury.
--
-- Every poisha in this closed ecosystem is minted from this one account, as a real double-entry
-- movement. The treasury therefore holds the exact negative image of all user money, which is
-- what makes reconciliation invariant #1 (SUM(balance_minor) = 0) meaningful rather than
-- tautological: if it ever fails, money was created or destroyed outside the ledger.

INSERT INTO accounts (id, user_id, type, status, balance_minor)
VALUES ('00000000-0000-0000-0000-000000000001', NULL, 'SYSTEM', 'ACTIVE', 0)
ON CONFLICT (id) DO NOTHING;
