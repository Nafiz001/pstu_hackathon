/**
 * Metrics.
 *
 * What gets measured here is chosen to answer the questions an operator of a money system
 * actually asks at 3am, in order:
 *
 *   1. "Are the books correct?"        -> takaflow_reconciliation_ok, takaflow_ledger_net_minor
 *   2. "Is money still moving?"        -> takaflow_transfers_total by outcome
 *   3. "Why is it slow?"               -> lock wait, transaction retries, pool saturation
 *   4. "Is anything stuck?"            -> outbox backlog and age
 *
 * Note what is deliberately NOT a counter: correctness. `takaflow_reconciliation_ok` is a gauge
 * sampled from the database, because "we believe we are correct" is worth nothing next to "we
 * just asked the ledger and it agrees".
 */
import client from 'prom-client';
import { config } from '../../config/index.js';
import { pool } from '../db/pool.js';
import { logger } from '../logging/index.js';

export const registry = new client.Registry();

registry.setDefaultLabels({ service: 'takaflow-api', instance: config.INSTANCE_ID });
client.collectDefaultMetrics({ register: registry, prefix: 'takaflow_node_' });

// --- request layer ---------------------------------------------------------

export const httpRequests = new client.Counter({
  name: 'takaflow_http_requests_total',
  help: 'HTTP requests by route, method, and status class',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpDuration = new client.Histogram({
  name: 'takaflow_http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status'] as const,
  // Buckets chosen around the SLO (p99 transfer < 250ms) rather than the defaults, so the
  // histogram has resolution where the alert threshold sits.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// --- money -----------------------------------------------------------------

export const transfers = new client.Counter({
  name: 'takaflow_transfers_total',
  help: 'Money movements attempted, by type and outcome',
  labelNames: ['type', 'outcome'] as const,
  registers: [registry],
});

export const transferAmount = new client.Histogram({
  name: 'takaflow_transfer_amount_taka',
  help: 'Distribution of successful transfer amounts, in Taka',
  buckets: [10, 50, 100, 500, 1_000, 5_000, 10_000, 50_000],
  registers: [registry],
});

// --- transaction machinery -------------------------------------------------

export const txRetries = new client.Counter({
  name: 'takaflow_transaction_retries_total',
  help: 'Transactions retried after a serialization failure or deadlock',
  labelNames: ['sqlstate'] as const,
  registers: [registry],
});

export const txDeadlineExceeded = new client.Counter({
  name: 'takaflow_transaction_deadline_exceeded_total',
  help: 'Transactions abandoned because they exhausted their wall-clock budget',
  registers: [registry],
});

export const txDuration = new client.Histogram({
  name: 'takaflow_transaction_duration_seconds',
  help: 'Time from BEGIN to COMMIT — this is how long row locks are held',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5],
  registers: [registry],
});

// --- async work ------------------------------------------------------------

export const outboxProcessed = new client.Counter({
  name: 'takaflow_outbox_events_total',
  help: 'Outbox events by result',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const scheduleRuns = new client.Counter({
  name: 'takaflow_schedule_runs_total',
  help: 'Scheduled transfer occurrences by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

// --- sampled gauges --------------------------------------------------------
//
// Collected on scrape rather than on a timer: a metric nobody is reading should not be putting
// load on the database.

new client.Gauge({
  name: 'takaflow_db_pool_connections',
  help: 'Connection pool state',
  labelNames: ['state'] as const,
  registers: [registry],
  collect() {
    this.set({ state: 'total' }, pool.totalCount);
    this.set({ state: 'idle' }, pool.idleCount);
    // Anything waiting means requests are queued on the pool — the first sign of saturation.
    this.set({ state: 'waiting' }, pool.waitingCount);
  },
});

const outboxBacklog = new client.Gauge({
  name: 'takaflow_outbox_backlog',
  help: 'Outbox events not yet delivered, by status',
  labelNames: ['status'] as const,
  registers: [registry],
});

const outboxOldestSeconds = new client.Gauge({
  name: 'takaflow_outbox_oldest_pending_seconds',
  help: 'Age of the oldest undelivered event — the async pipeline\'s true lag',
  registers: [registry],
});

const reconciliationOk = new client.Gauge({
  name: 'takaflow_reconciliation_ok',
  help: '1 when every money invariant holds, 0 when any is violated',
  registers: [registry],
});

const ledgerNet = new client.Gauge({
  name: 'takaflow_ledger_net_minor',
  help: 'Signed sum of every account balance. MUST be 0. Anything else means money was created or destroyed.',
  registers: [registry],
});

/**
 * Samples the database-backed gauges. Called on scrape, guarded so a database hiccup degrades
 * the metrics endpoint rather than failing it — a monitoring endpoint that goes down during an
 * incident is worse than useless.
 */
export async function sampleDatabaseGauges(): Promise<void> {
  try {
    const { rows: backlog } = await pool.query<{ status: string; count: string; oldest_seconds: string | null }>(
      `SELECT status::text AS status,
              count(*)::text AS count,
              EXTRACT(EPOCH FROM (now() - min(created_at)))::text AS oldest_seconds
         FROM outbox_events
        GROUP BY status`,
    );

    outboxBacklog.reset();
    outboxOldestSeconds.set(0);
    for (const row of backlog) {
      outboxBacklog.set({ status: row.status }, Number(row.count));
      if (row.status === 'PENDING' && row.oldest_seconds) {
        outboxOldestSeconds.set(Number(row.oldest_seconds));
      }
    }

    const { rows: net } = await pool.query<{ net: string; drift: string }>(
      `SELECT (SELECT COALESCE(SUM(balance_minor), 0)::text FROM accounts) AS net,
              (SELECT count(*)::text FROM (
                 SELECT a.id
                   FROM accounts a
                   LEFT JOIN ledger_entries e ON e.account_id = a.id
                  GROUP BY a.id, a.balance_minor
                 HAVING a.balance_minor <> COALESCE(SUM(
                          CASE e.direction WHEN 'CREDIT' THEN e.amount_minor ELSE -e.amount_minor END
                        ), 0)
               ) drifted) AS drift`,
    );

    const netMinor = Number(net[0]?.net ?? '0');
    const drifted = Number(net[0]?.drift ?? '0');
    ledgerNet.set(netMinor);
    reconciliationOk.set(netMinor === 0 && drifted === 0 ? 1 : 0);
  } catch (error) {
    logger.warn({ err: (error as Error).message }, 'metrics sampling failed');
  }
}
