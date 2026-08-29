-- 009_schedule_retry.sql — separate WHEN an occurrence is due from WHEN to try it again.
--
-- 008 used `next_run_at` for both, and the two meanings pull in opposite directions.
--
-- An occurrence is identified by the instant it was due: `occurrence_key = schedule_id +
-- next_run_at`. That is what makes a retry safe — it recomputes the same key, so it can never
-- become a second payment. But a retry that moved `next_run_at` forward changed the very thing
-- the key is derived from, so the retry looked like a NEW occurrence: attempts never accumulated,
-- the abandoned occurrence stayed PENDING forever, and a payment that could never succeed would
-- have been retried without limit, each time under a fresh identity.
--
-- `retry_after` is purely operational: it says "not before this instant", and it leaves the
-- occurrence's identity alone. Cleared whenever the schedule moves on to its next occurrence.

ALTER TABLE scheduled_transfers ADD COLUMN retry_after timestamptz;

COMMENT ON COLUMN scheduled_transfers.next_run_at IS
  'The instant the current occurrence is due. Also its identity: occurrence_key is derived from it.';
COMMENT ON COLUMN scheduled_transfers.retry_after IS
  'Backoff for the CURRENT occurrence after a transient failure. Never changes the occurrence key.';

-- The scheduler''s claim query becomes (next_run_at <= now() AND coalesce(retry_after, now()) <= now()),
-- so the index carries both columns and stays a straight index scan.
DROP INDEX schedules_due_idx;
CREATE INDEX schedules_due_idx
    ON scheduled_transfers (next_run_at, retry_after)
 WHERE status = 'ACTIVE';
