/**
 * Background workers.
 *
 * Every API replica runs these. That is safe by construction rather than by configuration:
 * the outbox dispatcher claims rows with FOR UPDATE SKIP LOCKED and the expiry worker does the
 * same, so N replicas share the work without a leader, a lock service, or a "only run this on
 * box 1" deployment note that someone will eventually get wrong.
 *
 * Each tick is scheduled *after* the previous one finishes, not on a fixed interval. With
 * setInterval, a tick that runs longer than its period stacks up behind itself until the pool is
 * exhausted; this cannot.
 */
import { dispatchBatch } from './outbox.dispatcher.js';
import { expireRequests } from './request-expiry.worker.js';
import { runDueSchedules } from './schedule.worker.js';
import { config } from '../config/index.js';
import { logger } from '../platform/logging/index.js';

export interface WorkerHandle {
  stop: () => Promise<void>;
}

interface LoopOptions {
  name: string;
  intervalMs: number;
  /** Run again immediately when a tick reports there is more work waiting. */
  run: () => Promise<{ hadWork: boolean }>;
}

function startLoop({ name, intervalMs, run }: LoopOptions): WorkerHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(tick, delay);
    timer.unref();
  };

  const tick = (): void => {
    inFlight = (async () => {
      try {
        const { hadWork } = await run();
        // A backlog drains at full speed instead of one batch per interval.
        schedule(hadWork ? 0 : intervalMs);
      } catch (error) {
        logger.error({ err: error, worker: name }, 'worker tick failed');
        schedule(intervalMs);
      }
    })();
  };

  schedule(intervalMs);

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Let the tick in progress finish so shutdown never interrupts a batch mid-transaction.
      await inFlight;
    },
  };
}

export function startWorkers(): WorkerHandle {
  const handles = [
    startLoop({
      name: 'outbox-dispatcher',
      intervalMs: 500,
      run: async () => {
        const result = await dispatchBatch();
        return { hadWork: result.claimed > 0 };
      },
    }),
    startLoop({
      name: 'request-expiry',
      intervalMs: 60_000,
      run: async () => {
        const expired = await expireRequests();
        return { hadWork: expired > 0 };
      },
    }),
    startLoop({
      name: 'scheduler',
      intervalMs: config.SCHEDULE_TICK_MS,
      run: async () => {
        const result = await runDueSchedules();
        // Only real progress asks for another immediate tick. Treating a deferred schedule as
        // work would spin this loop against a payment that is not due again for fifteen minutes.
        return { hadWork: result.paid + result.failed + result.skipped + result.duplicate > 0 };
      },
    }),
  ];

  logger.info(
    { workers: ['outbox-dispatcher', 'request-expiry', 'scheduler'] },
    'background workers started',
  );

  return {
    stop: async () => {
      await Promise.all(handles.map((h) => h.stop()));
      logger.info('background workers stopped');
    },
  };
}
