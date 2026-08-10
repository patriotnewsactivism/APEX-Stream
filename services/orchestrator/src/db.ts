import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENESIS_HASH, sealEntry, type AuditEntry, type AuditEntryInput } from '@apex/core';
import type { Config } from './config.js';

// AWS RDS's TLS cert chain roots at Amazon's own RDS CA, which is not in
// Node's default trust store -- `rejectUnauthorized: true` with no `ca`
// option guarantees "self-signed certificate in certificate chain" on every
// connection, always (confirmed live: this was silently breaking every DB
// call from this service). The bundle is a small, public, permanent AWS file
// (https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem),
// committed at packages/core/certs/ (shipped into every service image
// since Dockerfiles COPY the whole `packages` dir) so real cert validation
// can actually succeed instead of being silently disabled.
function loadRdsCaBundle(): string | undefined {
  try {
    return readFileSync(join(process.cwd(), 'packages/core/certs/rds-global-bundle.pem'), 'utf8');
  } catch (err) {
    // Fail loud in logs but don't crash the process over a missing cert file
    // -- fall back to encrypted-but-unverified rather than no TLS at all.
    console.error('rds ca bundle missing, falling back to rejectUnauthorized:false', err);
    return undefined;
  }
}

/**
 * Postgres access.
 *
 * Aurora Serverless v2 scales connections poorly if every task opens its own
 * pool, so the pool is small and shared, and long analytical reads are pushed
 * to the reader endpoint. Statements carry a timeout so a pathological query
 * cannot pin a connection indefinitely.
 */
export class Database {
  private readonly pool: pg.Pool;

  constructor(config: Config) {
    this.pool = new pg.Pool({
      connectionString: config.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
      ssl: config.DATABASE_CA_REQUIRED
        ? (() => {
            const ca = loadRdsCaBundle();
            return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: false };
          })()
        : undefined,
      application_name: 'apex-orchestrator',
    });
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const res = await this.pool.query<T>(text, params as never[]);
    return res.rows;
  }

  async one<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
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

/**
 * Append-only audit writer.
 *
 * The insert takes a transaction-scoped advisory lock so two concurrent
 * writers cannot both read the same head and produce two entries claiming the
 * same predecessor — which would silently fork the chain and make later
 * verification fail for reasons that have nothing to do with tampering.
 */
export class AuditWriter {
  constructor(private readonly db: Database) {}

  async append(input: AuditEntryInput): Promise<AuditEntry> {
    return this.db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [847_211]);
      const head = await client.query<{ sequence: string; entry_hash: string }>(
        'SELECT sequence, entry_hash FROM audit_log ORDER BY sequence DESC LIMIT 1',
      );
      const prev = head.rows[0];
      const sequence = prev ? Number(prev.sequence) + 1 : 0;
      const prevHash = prev ? prev.entry_hash : GENESIS_HASH;
      const entry = sealEntry(input, sequence, prevHash);

      await client.query(
        `INSERT INTO audit_log
           (sequence, recorded_at, actor, actor_type, action, resource_type, resource_id,
            detail, ip_address, user_agent, trace_id, outcome, prev_hash, entry_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          entry.sequence,
          entry.recordedAt,
          entry.actor,
          entry.actorType,
          entry.action,
          entry.resourceType,
          entry.resourceId,
          JSON.stringify(entry.detail),
          entry.ipAddress,
          entry.userAgent,
          entry.traceId,
          entry.outcome,
          entry.prevHash,
          entry.entryHash,
        ],
      );
      return entry;
    });
  }

  async range(fromSequence: number, limit = 500): Promise<AuditEntry[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM audit_log WHERE sequence >= $1 ORDER BY sequence ASC LIMIT $2`,
      [fromSequence, Math.min(limit, 2000)],
    );
    return rows.map(rowToEntry);
  }
}

function rowToEntry(row: Record<string, unknown>): AuditEntry {
  return {
    sequence: Number(row.sequence),
    recordedAt: new Date(row.recorded_at as string).toISOString(),
    actor: row.actor as string,
    actorType: row.actor_type as AuditEntry['actorType'],
    action: row.action as AuditEntry['action'],
    resourceType: row.resource_type as string,
    resourceId: (row.resource_id as string | null) ?? null,
    detail: (row.detail as Record<string, unknown>) ?? {},
    ipAddress: (row.ip_address as string | null) ?? null,
    userAgent: (row.user_agent as string | null) ?? null,
    traceId: (row.trace_id as string | null) ?? null,
    outcome: row.outcome as AuditEntry['outcome'],
    prevHash: row.prev_hash as string,
    entryHash: row.entry_hash as string,
  };
}
