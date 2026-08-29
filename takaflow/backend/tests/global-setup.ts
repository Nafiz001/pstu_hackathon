/**
 * Runs once before the suite: bring the test database up to the current schema.
 *
 * The same migration runner the API uses at boot — tests must never exercise a schema that was
 * hand-crafted for them.
 */
import { runMigrations } from '../src/platform/db/migrate.js';
import { closePool } from '../src/platform/db/pool.js';

export async function setup(): Promise<void> {
  const { applied, alreadyApplied } = await runMigrations();
  if (applied.length > 0) {
    process.stdout.write(`[test-db] applied ${applied.length} migration(s)\n`);
  } else {
    process.stdout.write(`[test-db] schema current (${alreadyApplied} migrations)\n`);
  }
  await closePool();
}
