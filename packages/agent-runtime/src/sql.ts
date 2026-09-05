/**
 * Database access.
 *
 * A single executor interface so the SQL every agent and the orchestrator
 * writes never has to think about how the connection is made. Historically
 * this module also supported the AWS RDS Data API for a "lean" Lambda
 * profile with no VPC attachment; that profile is retired along with the
 * rest of the platform's AWS dependency (see PgExecutor in sql-pg.ts, the
 * only implementation now). Positional parameters (`$1`, `$2`, ...) are the
 * only dialect this interface needs to support going forward.
 */
export interface SqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs `fn` inside a transaction. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  healthy(): Promise<boolean>;
  close(): Promise<void>;
}

/** Builds the executor. One implementation: direct Postgres via DATABASE_URL. */
export async function createExecutor(env: NodeJS.ProcessEnv = process.env): Promise<SqlExecutor> {
  if (!env.DATABASE_URL) {
    throw new Error('set DATABASE_URL');
  }
  const { PgExecutor } = await import('./sql-pg.js');
  return new PgExecutor(env.DATABASE_URL, env.DATABASE_CA_REQUIRED !== 'false');
}
