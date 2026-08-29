/** `npm run migrate` — apply pending migrations and exit. */
import { runMigrations } from './migrate.js';
import { closePool } from './pool.js';

try {
  const { applied, alreadyApplied } = await runMigrations();
  if (applied.length === 0) {
    process.stdout.write(`No pending migrations (${alreadyApplied} already applied).\n`);
  } else {
    process.stdout.write(`Applied ${applied.length} migration(s):\n`);
    for (const name of applied) process.stdout.write(`  ${name}\n`);
  }
  await closePool();
  process.exit(0);
} catch (error) {
  process.stderr.write(`Migration failed: ${(error as Error).message}\n`);
  await closePool().catch(() => undefined);
  process.exit(1);
}
