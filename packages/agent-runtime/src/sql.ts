import {
  RDSDataClient,
  ExecuteStatementCommand,
  type Field,
  type SqlParameter,
} from '@aws-sdk/client-rds-data';

/**
 * Database access, abstracted over how the connection is made.
 *
 * Two deployments, one set of queries:
 *
 *  - **Containers** hold a Postgres connection pool and talk to Aurora over a
 *    socket inside the VPC.
 *  - **Lambda** uses the RDS Data API, which is plain HTTPS. That is the whole
 *    reason the lean profile can exist: no VPC attachment means no NAT gateway,
 *    no interface endpoints, and no ENI cold start.
 *
 * The Data API takes *named* parameters (`:p1`) while every query in this
 * codebase is written with positional ones (`$1`). Rather than maintain two
 * dialects, the executor rewrites positional to named on the way through. The
 * SQL that agents and the orchestrator write never changes.
 */
export interface SqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs `fn` inside a transaction. Data API transactions are explicit. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  healthy(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Rewrites `$1, $2, …` to `:p1, :p2, …`.
 *
 * String literals and dollar-quoted blocks are skipped, so a `$1` appearing
 * inside quoted text — or inside a `$$ … $$` function body, which the migration
 * files use — is left alone. Getting this wrong would corrupt SQL silently
 * rather than loudly, which is why it is handled explicitly rather than with a
 * bare regex.
 */
export function toNamedParameters(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];

    if (ch === "'") {
      const end = findClosingQuote(sql, i);
      out += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    if (ch === '$') {
      const dollarTag = sql.slice(i).match(/^\$([A-Za-z_]\w*)?\$/);
      if (dollarTag) {
        const tag = dollarTag[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        out += sql.slice(i, stop);
        i = stop;
        continue;
      }
      const placeholder = sql.slice(i).match(/^\$(\d+)/);
      if (placeholder?.[1]) {
        out += `:p${placeholder[1]}`;
        i += placeholder[0].length;
        continue;
      }
    }

    out += ch;
    i++;
  }
  return out;
}

function findClosingQuote(sql: string, start: number): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === "'") {
      if (sql[i + 1] === "'") { i += 2; continue; } // escaped quote
      return i;
    }
    i++;
  }
  return sql.length - 1;
}

/** Maps a JavaScript value onto a Data API typed field. */
export function toField(value: unknown): SqlParameter['value'] & { [k: string]: unknown } {
  if (value === null || value === undefined) return { isNull: true };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { longValue: value } : { doubleValue: value };
  }
  if (value instanceof Date) return { stringValue: value.toISOString() };
  if (Buffer.isBuffer(value)) return { blobValue: value };
  if (Array.isArray(value)) {
    // Postgres arrays arrive as a literal; casts in the SQL (`$1::text[]`)
    // tell the server how to read it.
    return { stringValue: `{${value.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(',')}}` };
  }
  if (typeof value === 'object') return { stringValue: JSON.stringify(value) };
  return { stringValue: String(value) };
}

function fromField(field: Field): unknown {
  if (field.isNull) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.longValue !== undefined) return field.longValue;
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.blobValue !== undefined) return Buffer.from(field.blobValue);
  if (field.arrayValue !== undefined) {
    const arr = field.arrayValue;
    return (
      arr.stringValues ?? arr.longValues ?? arr.doubleValues ?? arr.booleanValues ?? []
    );
  }
  return null;
}

export interface DataApiConfig {
  resourceArn: string;
  secretArn: string;
  database: string;
  client?: RDSDataClient;
}

export class DataApiExecutor implements SqlExecutor {
  private readonly client: RDSDataClient;

  constructor(
    private readonly config: DataApiConfig,
    private readonly transactionId?: string,
  ) {
    this.client = config.client ?? new RDSDataClient({});
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.client.send(
      new ExecuteStatementCommand({
        resourceArn: this.config.resourceArn,
        secretArn: this.config.secretArn,
        database: this.config.database,
        sql: toNamedParameters(sql),
        parameters: params.map((value, index) => ({ name: `p${index + 1}`, value: toField(value) })),
        includeResultMetadata: true,
        transactionId: this.transactionId,
        // Aurora resumes from zero capacity on demand; without this the first
        // query after an idle period fails instead of waiting for the wake-up.
        continueAfterTimeout: false,
      }),
    );

    const columns = res.columnMetadata ?? [];
    return (res.records ?? []).map((record) => {
      const row: Record<string, unknown> = {};
      record.forEach((field, index) => {
        const meta = columns[index];
        const name = meta?.label ?? meta?.name ?? `column${index}`;
        const raw = fromField(field);
        // jsonb comes back as text over the Data API; parse it so callers see
        // the same shape they would from the pg driver.
        if (typeof raw === 'string' && (meta?.typeName === 'jsonb' || meta?.typeName === 'json')) {
          try {
            row[name] = JSON.parse(raw);
            return;
          } catch {
            /* fall through and keep the string */
          }
        }
        row[name] = raw;
      });
      return row as T;
    });
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const { BeginTransactionCommand, CommitTransactionCommand, RollbackTransactionCommand } =
      await import('@aws-sdk/client-rds-data');

    const begun = await this.client.send(
      new BeginTransactionCommand({
        resourceArn: this.config.resourceArn,
        secretArn: this.config.secretArn,
        database: this.config.database,
      }),
    );
    const transactionId = begun.transactionId;
    if (!transactionId) throw new Error('RDS Data API did not return a transaction id');

    const scoped = new DataApiExecutor(this.config, transactionId);
    try {
      const result = await fn(scoped);
      await this.client.send(
        new CommitTransactionCommand({
          resourceArn: this.config.resourceArn,
          secretArn: this.config.secretArn,
          transactionId,
        }),
      );
      return result;
    } catch (err) {
      await this.client
        .send(
          new RollbackTransactionCommand({
            resourceArn: this.config.resourceArn,
            secretArn: this.config.secretArn,
            transactionId,
          }),
        )
        .catch(() => undefined);
      throw err;
    }
  }

  async healthy(): Promise<boolean> {
    try {
      await this.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    // Data API is stateless HTTPS; nothing to close.
  }
}

/**
 * Builds the right executor for wherever this process is running. Lean
 * deployments set the Data API variables; container deployments set
 * DATABASE_URL.
 */
export async function createExecutor(env: NodeJS.ProcessEnv = process.env): Promise<SqlExecutor> {
  if (env.DB_RESOURCE_ARN && env.DB_SECRET_ARN) {
    return new DataApiExecutor({
      resourceArn: env.DB_RESOURCE_ARN,
      secretArn: env.DB_SECRET_ARN,
      database: env.DB_NAME ?? 'apex',
    });
  }
  if (!env.DATABASE_URL) {
    throw new Error('set either DB_RESOURCE_ARN + DB_SECRET_ARN (Data API) or DATABASE_URL (direct)');
  }
  // Imported lazily so Lambda bundles never pull in the Postgres driver.
  const { PgExecutor } = await import('./sql-pg.js');
  return new PgExecutor(env.DATABASE_URL, env.DATABASE_CA_REQUIRED !== 'false');
}
