-- 002_support.sql — money requests, reliable side effects, sessions, audit.

CREATE TYPE request_status AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED');
CREATE TYPE outbox_status  AS ENUM ('PENDING', 'PROCESSED', 'FAILED');

-- ---------------------------------------------------------------------------
-- Money requests: "my friend owes me BDT 1,200 and I want to collect it".
--
-- Every transition is a conditional UPDATE guarded on the current status, so a double-tap, two
-- devices, or an accept racing a cancel resolve in the database rather than in a read-then-write
-- window in application code. rowCount = 0 IS the error path.
-- ---------------------------------------------------------------------------
CREATE TABLE money_requests (
    id                  uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_request_id   uuid           REFERENCES money_requests (id) ON DELETE CASCADE,
    requester_user_id   uuid           NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    payer_user_id       uuid           NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    amount_minor        bigint         NOT NULL CHECK (amount_minor > 0),
    note                text CHECK (note IS NULL OR length(note) <= 140),
    status              request_status NOT NULL DEFAULT 'PENDING',
    expires_at          timestamptz    NOT NULL,
    settled_transfer_id uuid,
    decline_reason      text,
    version             bigint         NOT NULL DEFAULT 0,
    created_at          timestamptz    NOT NULL DEFAULT now(),
    updated_at          timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT no_self_request CHECK (requester_user_id <> payer_user_id),
    CONSTRAINT settled_iff_accepted CHECK (
        (status = 'ACCEPTED' AND settled_transfer_id IS NOT NULL)
        OR (status <> 'ACCEPTED' AND settled_transfer_id IS NULL)
    )
);

-- ---------------------------------------------------------------------------
-- Transactional outbox.
--
-- Written inside the money transaction, so an event exists if and only if the money moved.
-- Consumed with FOR UPDATE SKIP LOCKED, which is what lets N API replicas each run a dispatcher
-- without any of them handling the same event twice.
-- ---------------------------------------------------------------------------
CREATE TABLE outbox_events (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type      text          NOT NULL,
    aggregate_type  text          NOT NULL,
    aggregate_id    uuid          NOT NULL,
    payload         jsonb         NOT NULL,
    status          outbox_status NOT NULL DEFAULT 'PENDING',
    attempts        integer       NOT NULL DEFAULT 0,
    last_error      text,
    next_attempt_at timestamptz   NOT NULL DEFAULT now(),
    created_at      timestamptz   NOT NULL DEFAULT now(),
    processed_at    timestamptz
);

-- ---------------------------------------------------------------------------
-- In-app notifications. Consumers dedupe on event_id, so redelivery is harmless.
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    event_id   uuid        NOT NULL,
    type       text        NOT NULL,
    payload    jsonb       NOT NULL,
    read_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT notification_once_per_event UNIQUE (user_id, event_id)
);

-- ---------------------------------------------------------------------------
-- Sessions: refresh tokens are stored hashed and rotated on every use. Presenting a token that
-- has already been rotated means it leaked, so the whole family is revoked.
-- ---------------------------------------------------------------------------
CREATE TABLE refresh_tokens (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    family_id     uuid        NOT NULL,
    token_hash    text        NOT NULL UNIQUE,
    user_agent    text,
    ip            inet,
    expires_at    timestamptz NOT NULL,
    revoked_at    timestamptz,
    replaced_by   uuid,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Audit log: append-only record of every state-changing action.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
    id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_user_id uuid        REFERENCES users (id) ON DELETE SET NULL,
    action        text        NOT NULL,
    entity_type   text        NOT NULL,
    entity_id     text,
    metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    ip            inet,
    user_agent    text,
    request_id    text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER audit_immutable
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION deny_mutation();
