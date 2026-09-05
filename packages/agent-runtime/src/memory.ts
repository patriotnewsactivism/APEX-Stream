import type { AgentId } from '@apex/core';
import type { SqlExecutor } from './sql.js';

/**
 * Per-agent memory, backed by Postgres (replaces DynamoDB).
 *
 * Isolation: every key is scoped by `agent_id`, fixed at construction and
 * never accepted from a caller — the same code-level guarantee DynamoDB's
 * key-namespacing provided. DynamoDB additionally scoped each agent's IAM
 * task role to its own partition; that layer has no direct equivalent while
 * every agent shares one `DATABASE_URL` role (see the migration file's
 * comment for the row-level-security path if per-agent credentials are
 * introduced later).
 *
 * Two tiers:
 *   working  — short-lived scratch state, TTL in hours, survives task retries
 *   episodic — durable observations the agent learned, TTL in days-to-months
 */

export type MemoryTier = 'working' | 'episodic';

export interface MemoryRecord<T = unknown> {
  key: string;
  tier: MemoryTier;
  value: T;
  createdAt: string;
  updatedAt: string;
  expiresAt: number | null;
}

const DEFAULT_TTL_SECONDS: Record<MemoryTier, number> = {
  working: 60 * 60 * 6, // 6 hours
  episodic: 60 * 60 * 24 * 90, // 90 days
};

export class AgentMemory {
  constructor(
    private readonly agentId: AgentId,
    private readonly db: SqlExecutor,
  ) {}

  async get<T>(tier: MemoryTier, key: string): Promise<T | null> {
    const [row] = await this.db.query<{ value: T }>(
      `SELECT value FROM agent_memory
       WHERE agent_id = $1 AND tier = $2 AND key = $3 AND (expires_at IS NULL OR expires_at > now())`,
      [this.agentId, tier, key],
    );
    return row ? row.value : null;
  }

  async put<T>(tier: MemoryTier, key: string, value: T, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds ?? DEFAULT_TTL_SECONDS[tier];
    await this.db.query(
      `INSERT INTO agent_memory (agent_id, tier, key, value, expires_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $5::integer > 0 THEN now() + make_interval(secs => $5) ELSE NULL END)
       ON CONFLICT (agent_id, tier, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now(), expires_at = EXCLUDED.expires_at`,
      [this.agentId, tier, key, JSON.stringify(value), ttl],
    );
  }

  async delete(tier: MemoryTier, key: string): Promise<void> {
    await this.db.query(`DELETE FROM agent_memory WHERE agent_id = $1 AND tier = $2 AND key = $3`, [
      this.agentId,
      tier,
      key,
    ]);
  }

  /** Lists keys in a tier under an optional prefix. Paginated by the caller. */
  async list<T>(tier: MemoryTier, prefix = '', limit = 100): Promise<MemoryRecord<T>[]> {
    const rows = await this.db.query<{
      key: string;
      value: T;
      created_at: string;
      updated_at: string;
      expires_at: string | null;
    }>(
      `SELECT key, value, created_at, updated_at, expires_at FROM agent_memory
       WHERE agent_id = $1 AND tier = $2 AND key LIKE $3 AND (expires_at IS NULL OR expires_at > now())
       ORDER BY key LIMIT $4`,
      [this.agentId, tier, `${escapeLike(prefix)}%`, limit],
    );
    return rows.map((r) => ({
      key: r.key,
      tier,
      value: r.value,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      expiresAt: r.expires_at ? Math.floor(new Date(r.expires_at).getTime() / 1000) : null,
    }));
  }

  /**
   * Rolling numeric baseline used by the velocity and tone signals.
   * Stores an exponentially weighted mean and variance so an agent can ask
   * "how unusual is this value for this source?" without replaying history.
   */
  async updateBaseline(key: string, sample: number, alpha = 0.2): Promise<Baseline> {
    const prior = (await this.get<Baseline>('episodic', `baseline:${key}`)) ?? {
      mean: sample,
      variance: 0,
      count: 0,
      updatedAt: new Date().toISOString(),
    };
    const delta = sample - prior.mean;
    const mean = prior.mean + alpha * delta;
    const variance = (1 - alpha) * (prior.variance + alpha * delta * delta);
    const next: Baseline = {
      mean,
      variance,
      count: prior.count + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.put('episodic', `baseline:${key}`, next);
    return next;
  }

  async getBaseline(key: string): Promise<Baseline | null> {
    return this.get<Baseline>('episodic', `baseline:${key}`);
  }
}

export interface Baseline {
  mean: number;
  variance: number;
  count: number;
  updatedAt: string;
}

/** Standard deviations from baseline. Returns 0 when there is no history. */
export function zScore(sample: number, baseline: Baseline | null): number {
  if (!baseline || baseline.count < 2) return 0;
  const sd = Math.sqrt(Math.max(baseline.variance, 1e-9));
  return (sample - baseline.mean) / sd;
}

/** Escapes `%` and `_` so a literal key prefix cannot be read as a LIKE pattern. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
