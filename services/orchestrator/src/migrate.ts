import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { loadConfig } from './config.js';
import { loadRdsCaBundle } from './rds-ca.js';

/**
 * Applies every *.sql file in db/migrations, in filename order, tracked in a
 * schema_migrations table so re-runs are idempotent. Deliberately standalone
 * (no Fastify app, no queues/SNS/Cognito wiring) -- the CI pipeline runs this
 * as a one-off ECS task override of the orchestrator's own task definition
 * (same image, same env, different command), specifically because Aurora
 * sits in isolated subnets with no route from the GitHub Actions runner.
 *
 * Each migration file runs inside its own transaction. A failure partway
 * through a file rolls back that file's own changes but leaves prior
 * successfully-applied migrations recorded -- re-running after a fix picks
 * up exactly where it left off.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const ca = config.DATABASE_CA_REQUIRED ? loadRdsCaBundle() : undefined;
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 1,
    ssl: config.DATABASE_CA_REQUIRED ? (ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: false }) : undefined,
    application_name: 'apex-orchestrator-migrate',
  });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      );
    `);

    const migrationsDir = join(process.cwd(), 'db/migrations');
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log(`no migration files found in ${migrationsDir}`);
      return;
    }

    const { rows: appliedRows } = await pool.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations',
    );
    const applied = new Set(appliedRows.map((r) => r.filename));

    let ranCount = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip (already applied): ${file}`);
        continue;
      }

      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`applied: ${file}`);
        ranCount += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration failed on ${file}: ${(err as Error).message}`, { cause: err });
      } finally {
        client.release();
      }
    }

    console.log(`migrations complete: ${ranCount} applied, ${files.length - ranCount} already up to date`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('migration run failed:', err);
  process.exit(1);
});
