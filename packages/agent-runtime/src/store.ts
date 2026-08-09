import pg from 'pg';
import type { AnomalyScoreResult, SignalObservation } from '@apex/core';

/**
 * Postgres access for collector agents.
 *
 * Deliberately narrow: agents read the sources they own and write observations,
 * signals and anomalies. They cannot read evidence, other agents' rows, or the
 * audit log — the database role backing this pool is scoped to match.
 */
export class Store {
  private readonly pool: pg.Pool;

  constructor(connectionString = process.env.DATABASE_URL) {
    if (!connectionString) throw new Error('DATABASE_URL is required');
    this.pool = new pg.Pool({
      connectionString,
      max: 5,
      statement_timeout: 20_000,
      ssl: process.env.DATABASE_CA_REQUIRED === 'false' ? undefined : { rejectUnauthorized: true },
      application_name: `apex-${process.env.APEX_AGENT_ID ?? 'agent'}`,
    });
  }

  /**
   * Returns the sources this task is responsible for.
   *
   * `shard`/`shardCount` split the source list deterministically by hash so
   * parallel Beast-mode tasks divide the work instead of duplicating it.
   */
  async claimSources(input: {
    ownerAgent: string;
    sourceId?: string;
    tags: string[];
    shard: number;
    shardCount: number;
  }): Promise<Array<{ id: string; label: string; url: string; kind: string; authority: number; intervalSeconds: number }>> {
    const rows = await this.pool.query<{
      id: string; label: string; url: string; kind: string; authority: string; interval_seconds: number;
    }>(
      `SELECT id, label, url, kind, authority, interval_seconds
         FROM sources
        WHERE enabled = true
          AND owner_agent = $1
          AND ($2::uuid IS NULL OR id = $2::uuid)
          AND (cardinality($3::text[]) = 0 OR tags && $3::text[])
          AND (last_polled_at IS NULL OR last_polled_at < now() - (interval_seconds || ' seconds')::interval)
          AND ($5 = 1 OR (abs(hashtext(id::text)) % $5) = $4)
        ORDER BY last_polled_at ASC NULLS FIRST
        LIMIT 200`,
      [input.ownerAgent, input.sourceId ?? null, input.tags, input.shard, Math.max(1, input.shardCount)],
    );
    return rows.rows.map((r) => ({
      id: r.id, label: r.label, url: r.url, kind: r.kind,
      authority: Number(r.authority), intervalSeconds: r.interval_seconds,
    }));
  }

  async markPolled(sourceId: string, error: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE sources
          SET last_polled_at = now(),
              consecutive_failures = CASE WHEN $2::text IS NULL THEN 0 ELSE consecutive_failures + 1 END,
              last_error = $2
        WHERE id = $1`,
      [sourceId, error],
    );
  }

  async observationExists(sourceId: string, contentHash: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM observations WHERE source_id = $1 AND content_hash = $2 LIMIT 1`,
      [sourceId, contentHash],
    );
    return res.rowCount ? res.rowCount > 0 : false;
  }

  async recentFingerprints(sourceId: string, limit: number): Promise<string[]> {
    const res = await this.pool.query<{ fingerprint: string }>(
      `SELECT fingerprint FROM observations
        WHERE source_id = $1 AND fingerprint IS NOT NULL
        ORDER BY collected_at DESC LIMIT $2`,
      [sourceId, limit],
    );
    return res.rows.map((r) => r.fingerprint);
  }

  async latestFingerprint(sourceId: string, url: string): Promise<{ fingerprint: string; observationId: string } | null> {
    const res = await this.pool.query<{ fingerprint: string; id: string }>(
      `SELECT fingerprint, id FROM observations
        WHERE source_id = $1 AND url = $2 AND fingerprint IS NOT NULL
        ORDER BY collected_at DESC LIMIT 1`,
      [sourceId, url],
    );
    const row = res.rows[0];
    return row ? { fingerprint: row.fingerprint, observationId: row.id } : null;
  }

  async itemsInLastHour(sourceId: string): Promise<number> {
    const res = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text FROM observations WHERE source_id = $1 AND collected_at > now() - interval '1 hour'`,
      [sourceId],
    );
    return Number(res.rows[0]?.count ?? '0');
  }

  async watchlistTerms(): Promise<string[]> {
    const res = await this.pool.query<{ term: string }>(`SELECT term FROM watchlist WHERE enabled = true`);
    return res.rows.map((r) => r.term);
  }

  async saveObservation(input: {
    sourceId: string;
    collectedBy: string;
    title: string | null;
    content: string;
    contentHash: string;
    fingerprint: string;
    url: string | null;
    occurredAt: string | null;
    metadata: Record<string, unknown>;
    signals: SignalObservation[];
  }): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query<{ id: string }>(
        `INSERT INTO observations
           (source_id, collected_by, collected_at, occurred_at, title, content, content_hash, fingerprint, url, metadata)
         VALUES ($1,$2,now(),$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (source_id, content_hash) DO NOTHING
         RETURNING id`,
        [
          input.sourceId, input.collectedBy, input.occurredAt, input.title, input.content,
          input.contentHash, input.fingerprint, input.url, JSON.stringify(input.metadata),
        ],
      );
      const observationId = res.rows[0]?.id;
      if (!observationId) {
        await client.query('ROLLBACK');
        return '';
      }
      for (const signal of input.signals) {
        await client.query(
          `INSERT INTO observation_signals (observation_id, signal_id, raw, sample_size, evidence)
           VALUES ($1,$2,$3,$4,$5)`,
          [observationId, signal.signalId, signal.raw, signal.sampleSize, signal.evidence ?? null],
        );
      }
      await client.query('COMMIT');
      return observationId;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async saveAnomaly(input: {
    runId: string;
    observationId: string;
    sourceId: string;
    detectedBy: string;
    result: AnomalyScoreResult;
    summary: string;
  }): Promise<string> {
    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO anomalies
         (run_id, observation_id, source_id, detected_by, detected_at, score, band, confidence,
          summary, scoring_profile_id, scoring_profile_version, components, input_hash, explanation)
       VALUES ($1,$2,$3,$4,now(),$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        input.runId, input.observationId, input.sourceId, input.detectedBy,
        input.result.score, input.result.band, input.result.confidence, input.summary,
        input.result.profileId, input.result.profileVersion,
        JSON.stringify(input.result.components), input.result.inputHash, input.result.explanation,
      ],
    );
    return res.rows[0]?.id ?? '';
  }

  /** Anomalies detected but never archived — Archivist's backstop sweep. */
  async pendingArchival(limit: number): Promise<Array<{ observationId: string; anomalyId: string | null }>> {
    const res = await this.pool.query<{ observation_id: string; id: string }>(
      `SELECT a.observation_id, a.id
         FROM anomalies a
    LEFT JOIN evidence e ON e.anomaly_id = a.id
        WHERE e.id IS NULL AND a.band <> 'info'
        ORDER BY a.detected_at ASC
        LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => ({ observationId: r.observation_id, anomalyId: r.id }));
  }

  async getObservation(id: string): Promise<{
    id: string; sourceId: string; url: string | null; title: string | null;
    content: string; contentHash: string; collectedAt: string; collectedBy: string;
    metadata: Record<string, unknown>;
  } | null> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT id, source_id, url, title, content, content_hash, collected_at, collected_by, metadata
         FROM observations WHERE id = $1`,
      [id],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id as string,
      sourceId: r.source_id as string,
      url: (r.url as string | null) ?? null,
      title: (r.title as string | null) ?? null,
      content: r.content as string,
      contentHash: r.content_hash as string,
      collectedAt: new Date(r.collected_at as string).toISOString(),
      collectedBy: r.collected_by as string,
      metadata: (r.metadata as Record<string, unknown>) ?? {},
    };
  }

  async saveEvidence(record: {
    id: string; anomalyId: string | null; observationId: string; capturedBy: string;
    capturedAt: string; s3Bucket: string; s3Key: string; s3VersionId: string | null;
    sha256: string; bytes: number; contentType: string; retainUntil: string;
    manifestSha256: string; chainOfCustody: unknown;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO evidence
         (id, anomaly_id, observation_id, captured_by, captured_at, s3_bucket, s3_key, s3_version_id,
          sha256, bytes, content_type, retain_until, manifest_sha256, chain_of_custody)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO NOTHING`,
      [
        record.id, record.anomalyId, record.observationId, record.capturedBy, record.capturedAt,
        record.s3Bucket, record.s3Key, record.s3VersionId, record.sha256, record.bytes,
        record.contentType, record.retainUntil, record.manifestSha256, JSON.stringify(record.chainOfCustody),
      ],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
