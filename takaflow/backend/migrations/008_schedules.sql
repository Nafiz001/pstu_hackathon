-- 008_schedules.sql — scheduled and recurring transfers.
--
-- A scheduler that pays real money has one hard requirement: a duplicate tick, a restart mid-run,
-- or two replicas firing at the same instant must never pay twice.
--
-- The mechanism is `occurrence_key`, a DETERMINISTIC identifier — `schedule_id + occurrence date`
-- — rather than a random one. Two attempts at the same occurrence therefore compute the same key
-- and the second is recognised as a duplicate by the ordinary idempotency machinery, exactly like
-- a client retrying a payment. Nothing scheduler-specific is invented; the guarantee that already
-- protects the API protects the timer too.
--
-- `schedule_occurrences` is the durable record of what has been attempted, so recovery after a
-- crash is a query rather than a guess.

CREATE TYPE schedule_status   AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');
CREATE TYPE schedule_interval AS ENUM ('ONCE', 'DAILY', 'WEEKLY', 'MONTHLY');
CREATE TYPE occurrence_status AS ENUM ('PENDING', 'PAID', 'FAILED', 'SKIPPED');

CREATE TABLE scheduled_transfers (
    id                uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id     uuid              NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    payee_user_id     uuid              NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    amount_minor      bigint            NOT NULL CHECK (amount_minor > 0),
    note              text CHECK (note IS NULL OR length(note) <= 140),
    interval_kind     schedule_interval NOT NULL,
    next_run_at       timestamptz       NOT NULL,
    -- NULL means "until cancelled"; a count lets a user say "pay this five times".
    remaining_runs    integer CHECK (remaining_runs IS NULL OR remaining_runs >= 0),
    status            schedule_status   NOT NULL DEFAULT 'ACTIVE',
    last_run_at       timestamptz,
    created_at        timestamptz       NOT NULL DEFAULT now(),
    updated_at        timestamptz       NOT NULL DEFAULT now(),
    CONSTRAINT no_self_schedule CHECK (owner_user_id <> payee_user_id)
);

CREATE TABLE schedule_occurrences (
    id             uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_id    uuid              NOT NULL REFERENCES scheduled_transfers (id) ON DELETE CASCADE,
    -- The deterministic key described above. UNIQUE is the actual guard against double payment:
    -- even if every other check failed, the database would refuse the second insert.
    occurrence_key text              NOT NULL UNIQUE,
    due_at         timestamptz       NOT NULL,
    status         occurrence_status NOT NULL DEFAULT 'PENDING',
    transfer_id    uuid,
    failure_reason text,
    attempts       integer           NOT NULL DEFAULT 0,
    created_at     timestamptz       NOT NULL DEFAULT now(),
    completed_at   timestamptz,
    CONSTRAINT paid_has_transfer CHECK (status <> 'PAID' OR transfer_id IS NOT NULL)
);

-- The scheduler's only query: claim what is due. Partial, so it stays small forever.
CREATE INDEX schedules_due_idx ON scheduled_transfers (next_run_at) WHERE status = 'ACTIVE';
CREATE INDEX schedules_owner_idx ON scheduled_transfers (owner_user_id, created_at DESC);
CREATE INDEX occurrences_schedule_idx ON schedule_occurrences (schedule_id, due_at DESC);
