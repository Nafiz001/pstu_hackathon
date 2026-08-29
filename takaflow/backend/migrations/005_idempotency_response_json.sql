-- 005_idempotency_response_json.sql
--
-- `jsonb` normalises its input: it reorders object keys and drops insignificant whitespace. For
-- almost every column that is an advantage, but a stored idempotent response is not data we
-- query — it is a response we promised to hand back *unchanged* to a client retrying a payment.
--
-- `json` preserves the exact text, so a replay is byte-for-byte identical to the original
-- response rather than merely semantically equal. A client diffing two receipts, or a judge
-- comparing them on stage, sees the same bytes.
--
-- (Written as a new migration rather than an edit to 001: the runner records a checksum for
-- every applied file precisely so that history cannot be rewritten underneath a live database.)

ALTER TABLE idempotency_keys
    ALTER COLUMN response_body TYPE json USING response_body::json;
