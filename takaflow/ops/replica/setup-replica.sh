#!/bin/sh
# Build a streaming replica from the primary with pg_basebackup.
#
# Runs once, before the replica's Postgres starts: waits for the primary, takes a base backup,
# and leaves the data directory in standby mode.
#
# `-R` writes standby.signal and primary_conninfo; `-C -S` creates a physical replication slot so
# the primary retains WAL the replica has not consumed yet, instead of the replica falling
# irrecoverably behind after a disconnect.
#
# The backup runs as the `postgres` user via gosu, not as root. Files written by root would be
# unreadable to the server process that starts immediately afterwards, and the container would
# die one line later with a permissions error. (postgres:18-alpine ships gosu, not su-exec.)
set -e

DATA_DIR="${PGDATA:-/var/lib/postgresql/18/docker}"

if [ -s "$DATA_DIR/PG_VERSION" ]; then
  echo "replica: data directory already initialised, starting as standby"
else
  echo "replica: waiting for primary..."
  until pg_isready -h db -p 5432 -U takaflow -q; do
    sleep 1
  done

  echo "replica: taking base backup from primary"
  mkdir -p "$DATA_DIR"
  chown -R postgres:postgres /var/lib/postgresql
  rm -rf "${DATA_DIR:?}"/*

  gosu postgres env PGPASSWORD="$POSTGRES_PASSWORD" pg_basebackup \
    --host=db --port=5432 --username=replicator \
    --pgdata="$DATA_DIR" \
    --wal-method=stream \
    --create-slot --slot=takaflow_replica \
    --write-recovery-conf \
    --checkpoint=fast \
    --progress --verbose

  chown -R postgres:postgres "$DATA_DIR"
  chmod 0700 "$DATA_DIR"
  echo "replica: base backup complete"
fi

# "$@" carries the tuning flags from compose. A hot standby must be configured with at
# least the primary's max_connections or it refuses to start, so those flags are not
# optional here.
exec docker-entrypoint.sh postgres "$@"
