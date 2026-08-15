import pg from 'pg';
import type { SqlExecutor } from './sql.js';

/**
 * Direct Postgres access for container deployments.
 *
 * Pools are small on purpose: Aurora Serverless v2 handles many small pools
 * badly, and a container that opens twenty idle connections it never uses is
 * taking capacity from one that needs them.
 */
/** A transaction-scoped view over one checked-out client. */
class PgTransaction implements SqlExecutor {
  constructor(private readonly client: pg.PoolClient) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.client.query(sql, params as never[]);
    return res.rows as T[];
  }

  // Nested transactions would need savepoints; nothing here needs them, and
  // silently flattening one into the outer transaction would be a trap.
  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    // The pool owns this client; it is released by the caller.
  }
}

export class PgExecutor implements SqlExecutor {
  private readonly pool: pg.Pool;

  constructor(connectionString: string, requireCa = true) {
    this.pool = new pg.Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 20_000,
      ssl: requireCa ? { rejectUnauthorized: true } : undefined,
      application_name: process.env.APEX_SERVICE ?? 'apex',
    });
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query(sql, params as never[]);
    return res.rows as T[];
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PgTransaction(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async healthy(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
