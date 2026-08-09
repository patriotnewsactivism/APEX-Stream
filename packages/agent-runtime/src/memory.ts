import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { AgentId } from '@apex/core';

/**
 * Per-agent memory.
 *
 * Isolation is enforced twice, on purpose. In code, every key is prefixed with
 * the agent's namespace and the namespace is fixed at construction. In IAM,
 * each agent's task role carries a `dynamodb:LeadingKeys` condition limiting it
 * to its own partition. Application bugs therefore cannot leak one agent's
 * memory into another, and neither can a compromised container.
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
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly agentId: AgentId,
    private readonly tableName: string,
    client?: DynamoDBClient,
  ) {
    this.doc = DynamoDBDocumentClient.from(client ?? new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  /** Partition key. Never accepts an agent id from a caller. */
  private get namespace(): string {
    return `mem:${this.agentId}`;
  }

  private sortKey(tier: MemoryTier, key: string): string {
    return `${tier}#${key}`;
  }

  async get<T>(tier: MemoryTier, key: string): Promise<T | null> {
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { namespace: this.namespace, sk: this.sortKey(tier, key) },
      }),
    );
    if (!res.Item) return null;
    if (res.Item.expiresAt && res.Item.expiresAt * 1000 < Date.now()) return null;
    return res.Item.value as T;
  }

  async put<T>(tier: MemoryTier, key: string, value: T, ttlSeconds?: number): Promise<void> {
    const now = new Date().toISOString();
    const ttl = ttlSeconds ?? DEFAULT_TTL_SECONDS[tier];
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          namespace: this.namespace,
          sk: this.sortKey(tier, key),
          tier,
          key,
          value,
          createdAt: now,
          updatedAt: now,
          expiresAt: ttl > 0 ? Math.floor(Date.now() / 1000) + ttl : null,
        },
      }),
    );
  }

  async delete(tier: MemoryTier, key: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { namespace: this.namespace, sk: this.sortKey(tier, key) },
      }),
    );
  }

  /** Lists keys in a tier under an optional prefix. Paginated by the caller. */
  async list<T>(tier: MemoryTier, prefix = '', limit = 100): Promise<MemoryRecord<T>[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: '#ns = :ns AND begins_with(sk, :prefix)',
        ExpressionAttributeNames: { '#ns': 'namespace' },
        ExpressionAttributeValues: { ':ns': this.namespace, ':prefix': `${tier}#${prefix}` },
        Limit: limit,
      }),
    );
    return (res.Items ?? []) as MemoryRecord<T>[];
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
