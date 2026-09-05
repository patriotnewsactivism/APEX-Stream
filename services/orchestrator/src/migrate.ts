import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExecutor, type SqlExecutor } from '@apex/agent-runtime';
import { rootLogger } from '@apex/core';

/**
 * Migration runner.
 *
 * Runs as a one-off ECS task on the orchestrator image, because Aurora lives in
 * isolated subnets with no route to the internet — a CI runner cannot reach it,
 * and opening a path so it could would be a worse trade than reusing the image
 * that already has network access and credentials.
 *
 * Three properties that matter more than speed here:
 *
 *  - **Each file runs inside its own transaction.** A migration that fails
 *    halfway leaves nothing behind, so the fix is "correct the file and re-run"
 *    rather than "work out what got applied and hand-repair production".
 *  - **Checksums are recorded.** Editing a migration that has already run is a
 *    silent way to make environments diverge; this refuses to continue instead.
 *  - **An advisory lock is held.** Two deploys racing would otherwise both try
 *    to apply the same file.
 */

const log = rootLogger.child({ service: 'migrate' });
const MIGRATION_LOCK = 913_477;

async function main(): Promise<void> {
  const db: SqlExecutor = await createExecutor();

  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/ → services/orchestrator/ → repo root → db/migrations
  const migrationsDir = path.resolve(here, '../../../db/migrations');

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now(),
        duration_ms integer NOT NULL
      )
    `);

    // Serialise concurrent deploys.
    await db.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    if (files.length === 0) {
      log.warn('no migration files found', { migrationsDir });
      return;
    }

    const applied = new Map(
      (await db.query<{ filename: string; checksum: string }>('SELECT filename, checksum FROM schema_migrations'))
        .map((r) => [r.filename, r.checksum]),
    );

    let ran = 0;
    for (const filename of files) {
      const sql = await readFile(path.join(migrationsDir, filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = applied.get(filename);

      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `${filename} has changed since it was applied (recorded ${previous.slice(0, 12)}, now ${checksum.slice(0, 12)}). ` +
              'Add a new migration rather than editing one that has already run.',
          );
        }
        log.debug('already applied', { filename });
        continue;
      }

      const started = Date.now();
      try {
        await db.transaction(async (tx) => {
          await tx.query(sql);
          await tx.query(
            'INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES ($1, $2, $3)',
            [filename, checksum, Date.now() - started],
          );
        });
        ran++;
        log.info('applied migration', { filename, durationMs: Date.now() - started });
      } catch (err) {
        throw new Error(
          `migration ${filename} failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    log.info('migrations complete', { applied: ran, alreadyApplied: files.length - ran, total: files.length });
  } finally {
    await db.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
    await db.close();
  }
}

main().catch((err) => {
  log.error('migration run failed', { error: err });
  process.exit(1);
});
