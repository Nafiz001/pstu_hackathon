-- 010_bill_splits.sql — "I paid for dinner, everyone owes me their share".
--
-- A split is not a new way to move money. It is a group of money requests created together, so
-- every leg settles through exactly the same path a single request does: the same lock ordering,
-- the same balance check, the same double entry. All this table adds is the grouping and the
-- promise that the legs sum to the whole.
--
-- `total_amount_minor` is stored even though it is derivable, and a trigger-free invariant check
-- lives in the application: the shares are allocated with integer arithmetic (shared/allocate.ts)
-- so they sum to exactly the total. Storing the total is what lets reconciliation *verify* that
-- rather than trust it.

CREATE TABLE bill_splits (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    total_amount_minor bigint      NOT NULL CHECK (total_amount_minor > 0),
    description        text        NOT NULL CHECK (length(description) BETWEEN 1 AND 140),
    participant_count  integer     NOT NULL CHECK (participant_count > 0),
    created_at         timestamptz NOT NULL DEFAULT now()
);

-- A request may belong to a split. Nullable, because most requests do not.
ALTER TABLE money_requests
    ADD COLUMN split_id uuid REFERENCES bill_splits (id) ON DELETE SET NULL;

CREATE INDEX money_requests_split_idx ON money_requests (split_id) WHERE split_id IS NOT NULL;
CREATE INDEX bill_splits_creator_idx  ON bill_splits (creator_user_id, created_at DESC);
