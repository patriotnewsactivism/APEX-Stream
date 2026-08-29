import { GENESIS_HASH, sealEntry, type AuditEntry, type AuditEntryInput } from '@apex/core';
import type { SqlExecutor } from '@apex/agent-runtime';

/**
 * Thin convenience layer over whichever SqlExecutor this deployment uses —
 * a Postgres pool in containers, the RDS Data API under Lambda. Every query in
 * this service is written once and runs unchanged on both.
 */
export class Database {
  constructor(private readonly executor: SqlExecutor) {}

  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    return this.executor.query<T>(text, params);
  }

  async one<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.executor.transaction(fn);
  }

  async healthy(): Promise<boolean> {
    return this.executor.healthy();
  }

  async close(): Promise<void> {
    await this.executor.close();
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
    return this.db.transaction(async (tx) => {
      // Serialises writers so two entries cannot claim the same predecessor and
      // silently fork the chain — which would fail verification later for
      // reasons that have nothing to do with tampering.
      await tx.query('SELECT pg_advisory_xact_lock($1)', [847_211]);
      const head = await tx.query<{ sequence: string; entry_hash: string }>(
        'SELECT sequence, entry_hash FROM audit_log ORDER BY sequence DESC LIMIT 1',
      );
      const prev = head[0];
      const sequence = prev ? Number(prev.sequence) + 1 : 0;
      const prevHash = prev ? prev.entry_hash : GENESIS_HASH;
      const entry = sealEntry(input, sequence, prevHash);

      await tx.query(
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
