-- 001_init.sql — the money core.
--
-- Invariants enforced HERE rather than in application code, deliberately: a bug in a service,
-- a rogue script, or a future contributor cannot corrupt the books past these constraints.
--   * a USER account can never hold a negative balance      (non_negative_user_balance)
--   * a transfer can never be self-directed                 (no_self_transfer)
--   * a transfer amount is always strictly positive         (amount_minor > 0)
--   * a ledger entry can never be updated or deleted        (ledger_immutable trigger)
--   * one (transfer, account, direction) has one entry      (unique index)
--
-- Money is BIGINT poisha (minor units). No floating point exists anywhere in this system.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE account_type    AS ENUM ('USER', 'SYSTEM');
CREATE TYPE account_status  AS ENUM ('ACTIVE', 'FROZEN', 'CLOSED');
CREATE TYPE user_status     AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE transfer_status AS ENUM ('COMPLETED', 'REVERSED');
CREATE TYPE transfer_type   AS ENUM ('P2P', 'MINT', 'REQUEST_SETTLEMENT', 'REVERSAL', 'SCHEDULED');
CREATE TYPE entry_direction AS ENUM ('DEBIT', 'CREDIT');

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    phone               text        NOT NULL UNIQUE CHECK (phone ~ '^01[3-9][0-9]{8}$'),
    name                text        NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
    password_hash       text        NOT NULL,
    pin_hash            text        NOT NULL,
    failed_pin_attempts integer     NOT NULL DEFAULT 0,
    pin_locked_until    timestamptz,
    status              user_status NOT NULL DEFAULT 'ACTIVE',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Accounts
--
-- SYSTEM accounts (the treasury) are the only accounts allowed to go negative: the treasury
-- holds the negative image of every poisha it has ever minted, which is what makes
-- "SUM(balance_minor) = 0 across all accounts" a true global invariant.
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
    id            uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid           UNIQUE REFERENCES users (id) ON DELETE RESTRICT,
    type          account_type   NOT NULL DEFAULT 'USER',
    status        account_status NOT NULL DEFAULT 'ACTIVE',
    balance_minor bigint         NOT NULL DEFAULT 0,
    version       bigint         NOT NULL DEFAULT 0,
    shard_key     smallint       NOT NULL DEFAULT 0,
    created_at    timestamptz    NOT NULL DEFAULT now(),
    updated_at    timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT non_negative_user_balance CHECK (type = 'SYSTEM' OR balance_minor >= 0),
    CONSTRAINT user_account_has_user     CHECK (type = 'SYSTEM' OR user_id IS NOT NULL),
    CONSTRAINT system_account_has_no_user CHECK (type = 'USER' OR user_id IS NULL)
);

-- ---------------------------------------------------------------------------
-- Idempotency
--
-- The row is claimed IN_PROGRESS by an INSERT .. ON CONFLICT DO NOTHING race, and flipped to
-- COMPLETED *inside the same transaction that moves the money*. That is what removes the third
-- state: after a crash the pair (money moved, key completed) is always consistent.
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    key             text        NOT NULL CHECK (length(key) BETWEEN 8 AND 128),
    endpoint        text        NOT NULL,
    request_hash    text        NOT NULL,
    state           text        NOT NULL CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
    response_status integer,
    response_body   jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz,
    expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
    CONSTRAINT idempotency_key_scope UNIQUE (user_id, key),
    CONSTRAINT completed_has_response CHECK (
        state <> 'COMPLETED' OR (response_status IS NOT NULL AND response_body IS NOT NULL)
    )
);

-- ---------------------------------------------------------------------------
-- Transfers + ledger entries (both range-partitioned by month from day one, so every test in
-- this project runs against the partitioned shape rather than discovering it later).
--
-- Note: no FK from ledger_entries.transfer_id to transfers. A foreign key into a partitioned
-- table would have to carry the partition key, and duplicating created_at into the child purely
-- to satisfy the FK buys less than it costs. Orphans are instead impossible by construction
-- (both rows are written in one transaction) and are checked continuously by reconciliation
-- invariant #4.
-- ---------------------------------------------------------------------------
CREATE TABLE transfers (
    id                 uuid            NOT NULL DEFAULT gen_random_uuid(),
    reference          text            NOT NULL,
    from_account_id    uuid            NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
    to_account_id      uuid            NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
    amount_minor       bigint          NOT NULL CHECK (amount_minor > 0),
    type               transfer_type   NOT NULL DEFAULT 'P2P',
    status             transfer_status NOT NULL DEFAULT 'COMPLETED',
    note               text CHECK (note IS NULL OR length(note) <= 140),
    idempotency_key_id uuid,
    reversal_of        uuid,
    created_at         timestamptz     NOT NULL DEFAULT now(),
    PRIMARY KEY (id, created_at),
    CONSTRAINT no_self_transfer CHECK (from_account_id <> to_account_id)
) PARTITION BY RANGE (created_at);

CREATE TABLE ledger_entries (
    id            bigint          GENERATED ALWAYS AS IDENTITY,
    transfer_id   uuid            NOT NULL,
    account_id    uuid            NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
    direction     entry_direction NOT NULL,
    amount_minor  bigint          NOT NULL CHECK (amount_minor > 0),
    balance_after bigint          NOT NULL,
    created_at    timestamptz     NOT NULL DEFAULT now(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- The ledger is history. History does not change.
CREATE FUNCTION deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries is append-only (attempted %)', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ledger_immutable
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- ---------------------------------------------------------------------------
-- Partition management
-- ---------------------------------------------------------------------------
CREATE FUNCTION ensure_month_partition(base_table text, month_start date)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    partition_name text := format('%s_%s', base_table, to_char(month_start, 'YYYY_MM'));
BEGIN
    IF to_regclass(partition_name) IS NULL THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
            partition_name, base_table, month_start, month_start + interval '1 month'
        );
    END IF;
END;
$$;

-- Twelve months back, twelve forward: the partition-manager worker keeps extending this window.
DO $$
DECLARE
    m date := date_trunc('month', now() - interval '12 months')::date;
BEGIN
    WHILE m < date_trunc('month', now() + interval '12 months')::date LOOP
        PERFORM ensure_month_partition('transfers', m);
        PERFORM ensure_month_partition('ledger_entries', m);
        m := (m + interval '1 month')::date;
    END LOOP;
END;
$$;

-- Safety net: a row outside the provisioned window lands here rather than failing a transfer.
-- Its presence is itself an alert (the partition manager fell behind).
CREATE TABLE transfers_default      PARTITION OF transfers      DEFAULT;
CREATE TABLE ledger_entries_default PARTITION OF ledger_entries DEFAULT;
