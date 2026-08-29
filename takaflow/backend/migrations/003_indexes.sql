-- 003_indexes.sql — the indexes that keep this correct AND fast at 10M users.
--
-- Every history query is keyset-paginated on (created_at DESC, id DESC), so the composite
-- indexes below are ordered to match exactly: the planner walks the index backwards and stops
-- after LIMIT rows, regardless of how deep the user pages.

-- Transfers: one index per side of the movement (a user's history is the union of both).
-- Unique indexes on a partitioned table must include the partition key; the public reference
-- embeds its own date (TF<YYMMDD>...), so lookups can still prune to a single partition.
CREATE UNIQUE INDEX transfers_reference_uk  ON transfers (reference, created_at);
CREATE INDEX transfers_from_idx             ON transfers (from_account_id, created_at DESC, id DESC);
CREATE INDEX transfers_to_idx               ON transfers (to_account_id, created_at DESC, id DESC);
CREATE INDEX transfers_idempotency_idx      ON transfers (idempotency_key_id) WHERE idempotency_key_id IS NOT NULL;
CREATE INDEX transfers_reversal_idx         ON transfers (reversal_of) WHERE reversal_of IS NOT NULL;

-- Ledger: per-account statement scan, and the reconciliation join by transfer.
CREATE UNIQUE INDEX ledger_entry_uk         ON ledger_entries (transfer_id, account_id, direction, created_at);
CREATE INDEX ledger_account_idx             ON ledger_entries (account_id, created_at DESC, id DESC);
CREATE INDEX ledger_transfer_idx            ON ledger_entries (transfer_id);

-- Money requests: the two inbox views, plus the expiry sweep.
CREATE INDEX requests_payer_idx             ON money_requests (payer_user_id, status, created_at DESC);
CREATE INDEX requests_requester_idx         ON money_requests (requester_user_id, status, created_at DESC);
CREATE INDEX requests_parent_idx            ON money_requests (parent_request_id) WHERE parent_request_id IS NOT NULL;
CREATE INDEX requests_expiry_idx            ON money_requests (expires_at) WHERE status = 'PENDING';

-- Outbox: the dispatcher's only query. Partial, so it stays tiny however large the table grows.
CREATE INDEX outbox_ready_idx               ON outbox_events (next_attempt_at, created_at) WHERE status = 'PENDING';
CREATE INDEX outbox_failed_idx              ON outbox_events (created_at DESC) WHERE status = 'FAILED';

-- Notifications, sessions, audit, idempotency housekeeping.
CREATE INDEX notifications_user_idx         ON notifications (user_id, created_at DESC, id DESC);
CREATE INDEX notifications_unread_idx       ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX refresh_tokens_user_idx        ON refresh_tokens (user_id, created_at DESC);
CREATE INDEX refresh_tokens_family_idx      ON refresh_tokens (family_id);
CREATE INDEX audit_actor_idx                ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX audit_entity_idx               ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX idempotency_expiry_idx         ON idempotency_keys (expires_at);
