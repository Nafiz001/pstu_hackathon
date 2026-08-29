#!/bin/bash
# Runs once, on first initialisation of the primary.
#
# Creates the replication role and opens pg_hba for it. Kept as an init script rather than baked
# into a custom image so the primary stays a stock postgres:18-alpine.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '${POSTGRES_PASSWORD}';
EOSQL

# Replication connections are matched by a dedicated pg_hba line; the catch-all "all databases"
# rule does not cover them.
cat >> "$PGDATA/pg_hba.conf" <<-EOF

# Streaming replication from the standby container.
host    replication     replicator      all                     scram-sha-256
EOF

echo "primary: replication role and pg_hba rule configured"
