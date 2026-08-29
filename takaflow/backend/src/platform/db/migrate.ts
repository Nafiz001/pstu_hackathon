/**
 * Migration runner.
 *
 * Guarded by a session-level advisory lock so that N API replicas booting simultaneously cannot
 * race: the first one migrates, the rest block, then find nothing to do. Each migration runs in
 * its own transaction, so a failure leaves the database on the last complete migration rather
 * than half-way through one.
 *
 * The checksum is recorded to catch a migration file being edited after it was applied — a
 * silent way for two environments to drift apart.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';
import { logger } from '../logging/index.js';

const MIGRATION_LOCK_ID = 947_213_004;

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

async function loadMigrations(): Promise<MigrationFile[]> {
  const entries = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  return Promise.all(
    entries.map(async (name) => {
      const sql = await readFile(join(migrationsDir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16) };
    }),
  );
}

export async function runMigrations(): Promise<{ applied: string[]; alreadyApplied: number }> {
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);

    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const previous = new Map(rows.map((r) => [r.name, r.checksum]));
    const migrations = await loadMigrations();

    for (const migration of migrations) {
      const seen = previous.get(migration.name);

      if (seen !== undefined) {
        if (seen !== migration.checksum) {
          throw new Error(
            `Migration ${migration.name} changed after it was applied ` +
              `(recorded ${seen}, file ${migration.checksum}). ` +
              'Add a new migration instead of editing an applied one.',
          );
        }
        continue;
      }

      logger.info({ migration: migration.name }, 'applying migration');
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [migration.name, migration.checksum],
        );
        await client.query('COMMIT');
        applied.push(migration.name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${migration.name} failed: ${(error as Error).message}`,
          { cause: error },
        );
      }
    }

    return { applied, alreadyApplied: previous.size };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
