/**
 * The Postgres connection pool.
 *
 * Two deliberate choices here:
 *
 * 1. BIGINT (OID 20) and NUMERIC are parsed as strings, never as JS numbers. Money is BIGINT
 *    poisha; silently rounding it through a float64 is exactly the class of bug this whole
 *    project exists to make impossible. Callers convert to BigInt explicitly.
 *
 * 2. Timeouts are NOT sent as libpq startup `options`. PgBouncer in transaction mode rejects
 *    startup parameters, because session state cannot safely be shared by the clients that take
 *    turns on one server connection — and this pool is meant to sit behind PgBouncer. They are
 *    set on the database role instead (migration 007) and re-asserted with SET LOCAL inside
 *    every money transaction, so they apply on every path into the database.
 */
import pg from 'pg';
import { config } from '../../config/index.js';
import { logger } from '../logging/index.js';

const { Pool, types } = pg;

// int8 / numeric -> string (see note 1 above).
types.setTypeParser(20, (value) => value);
types.setTypeParser(1700, (value) => value);

export type PoolClient = pg.PoolClient;
export type QueryResultRow = pg.QueryResultRow;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.PG_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: `takaflow-api(${config.INSTANCE_ID})`,
});

pool.on('error', (error) => {
  // An idle client failed (server restart, network cut). The pool discards it and carries on;
  // this must never take the process down.
  logger.error({ err: error }, 'idle postgres client error');
});

/** Query outside any transaction. Money paths must use withTransaction instead. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as unknown[]);
}

export async function closePool(): Promise<void> {
  await pool.end();
}
