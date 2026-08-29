#!/bin/bash
# Creates the database the test suite uses.
#
# Here rather than in a README step: a fresh clone should be able to run `docker compose up`
# followed by `npm test` with nothing in between. The schema itself is applied by the migration
# runner, which the test suite invokes in its global setup.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
    CREATE DATABASE takaflow_test OWNER ${POSTGRES_USER};
EOSQL

echo "primary: takaflow_test database created"
