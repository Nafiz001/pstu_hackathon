-- 007_role_timeouts.sql — statement and lock timeouts, applied at the role.
--
-- These guards used to be sent as libpq startup `options`, which works against Postgres directly
-- and is rejected outright by PgBouncer in transaction mode: a startup parameter would leak
-- session state across the clients that share a server connection, so the pooler refuses it.
--
-- Setting them on the role is the right answer anyway. They then apply to every session opened
-- as this role, whether it arrives through PgBouncer, through psql, or through a background
-- worker, and they cannot be forgotten by a new connection path. The money transaction still
-- issues its own SET LOCAL, so its window is explicit at the point a reader is looking at it.
--
-- What each one prevents:
--   statement_timeout                    — a runaway query holding row locks indefinitely
--   lock_timeout                         — a transfer queueing forever behind a contended row
--   idle_in_transaction_session_timeout  — an abandoned transaction pinning locks and bloat

DO $$
DECLARE
    role_name text := current_user;
BEGIN
    EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', role_name, '5s');
    EXECUTE format('ALTER ROLE %I SET lock_timeout = %L', role_name, '3s');
    EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', role_name, '10s');
END;
$$;
