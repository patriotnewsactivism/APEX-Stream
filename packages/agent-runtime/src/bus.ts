import type { AgentId, AgentTask, TaskResult } from '@apex/core';
import type { SqlExecutor } from './sql.js';

/** Envelope carried internally, with the lease token needed to ack/nack/heartbeat. */
export interface ReceivedTask<T = unknown> {
  task: AgentTask<T>;
  receiptHandle: string;
  approximateReceiveCount: number;
}

function splitReceipt(receiptHandle: string): { id: string; leaseToken: string } {
  const i = receiptHandle.indexOf(':');
  if (i < 0) throw new Error(`malformed receipt handle: ${receiptHandle}`);
  return { id: receiptHandle.slice(0, i), leaseToken: receiptHandle.slice(i + 1) };
}

/**
 * Postgres-backed task queue. One shared `agent_tasks` table, partitioned by
 * `agent_id`, replaces the one-SQS-queue-per-agent design -- see
 * db/migrations/003_postgres_native_queue_memory_events.sql for the schema
 * and the reasoning on lease tokens.
 *
 * `receive()` preserves SQS's long-poll contract (block up to `waitSeconds`,
 * return [] on timeout) by polling the claim query on a short interval
 * internally -- Postgres has no native long-poll primitive, but callers
 * (the `Agent` base class's loop) do not need to know that.
 */
export class TaskQueue {
  constructor(
    private readonly agentId: AgentId,
    private readonly db: SqlExecutor,
  ) {}

  async receive(max = 5, waitSeconds = 20, visibilityTimeout = 300): Promise<ReceivedTask[]> {
    const deadline = Date.now() + waitSeconds * 1000;
    const limit = Math.min(10, Math.max(1, max));

    for (;;) {
      const rows = await this.db.query<{
        id: string;
        body: unknown;
        receive_count: number;
        lease_token: string;
      }>(
        `UPDATE agent_tasks
           SET status = 'in_flight',
               lease_token = gen_random_uuid(),
               receive_count = receive_count + 1,
               visible_at = now() + make_interval(secs => $3)
         WHERE id IN (
           SELECT id FROM agent_tasks
           WHERE agent_id = $1 AND visible_at <= now()
           ORDER BY priority DESC, visible_at ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, body, receive_count, lease_token`,
        [this.agentId, limit, visibilityTimeout],
      );

      if (rows.length > 0) {
        return rows.map((r) => ({
          task: r.body as AgentTask,
          receiptHandle: `${r.id}:${r.lease_token}`,
          approximateReceiveCount: r.receive_count,
        }));
      }

      if (Date.now() >= deadline) return [];
      await sleep(Math.min(1_000, Math.max(200, deadline - Date.now())));
    }
  }

  async ack(receiptHandle: string): Promise<void> {
    const { id, leaseToken } = splitReceipt(receiptHandle);
    await this.db.query(`DELETE FROM agent_tasks WHERE id = $1 AND lease_token = $2`, [id, leaseToken]);
  }

  /** Returns a task to the queue immediately, with backoff on retry count. */
  async nack(receiptHandle: string, attempt: number): Promise<void> {
    const { id, leaseToken } = splitReceipt(receiptHandle);
    const backoff = Math.min(900, 2 ** Math.min(attempt, 9));
    await this.db.query(
      `UPDATE agent_tasks SET status = 'pending', visible_at = now() + make_interval(secs => $3)
       WHERE id = $1 AND lease_token = $2`,
      [id, leaseToken, backoff],
    );
  }

  /** Extends the lease on a task that is still being worked. */
  async heartbeat(receiptHandle: string, seconds = 300): Promise<void> {
    const { id, leaseToken } = splitReceipt(receiptHandle);
    await this.db.query(
      `UPDATE agent_tasks SET visible_at = now() + make_interval(secs => $3)
       WHERE id = $1 AND lease_token = $2`,
      [id, leaseToken, seconds],
    );
  }

  async send<T>(task: AgentTask<T>): Promise<void> {
    await this.db.query(`INSERT INTO agent_tasks (task_id, agent_id, body, priority) VALUES ($1, $2, $3, $4)`, [
      task.taskId,
      task.targetAgent,
      JSON.stringify(task),
      task.priority,
    ]);
  }

  async depth(): Promise<{ visible: number; inFlight: number }> {
    const [row] = await this.db.query<{ visible: string; in_flight: string }>(
      `SELECT
         count(*) FILTER (WHERE status = 'pending' AND visible_at <= now())  AS visible,
         count(*) FILTER (WHERE status = 'in_flight')                        AS in_flight
       FROM agent_tasks WHERE agent_id = $1`,
      [this.agentId],
    );
    return { visible: Number(row?.visible ?? 0), inFlight: Number(row?.in_flight ?? 0) };
  }
}

export type ApexEventType =
  | 'observation.collected'
  | 'anomaly.detected'
  | 'evidence.archived'
  | 'agent.heartbeat'
  | 'run.status_changed'
  | 'task.completed'
  | 'task.failed'
  | 'budget.threshold_crossed'
  // Warden flagged a comment as something other than routine. Carries the
  // classification only — never an action, since nothing acts without a human.
  | 'comment.flagged'
  | 'reply.posted';

/**
 * Postgres-backed event log, replacing EventBridge as the fan-out spine.
 * Agents publish facts; workflows, notifiers, and the dashboard read from
 * `agent_events` (or `LISTEN apex_events` for near-real-time wake-up — see
 * the migration's trigger). Agents still never call each other directly, so
 * adding a sixth agent does not require touching the other five.
 */
export class EventBus {
  constructor(private readonly db: SqlExecutor) {}

  async publish(
    type: ApexEventType,
    source: AgentId | 'orchestrator',
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.db.query(`INSERT INTO agent_events (event_type, source, detail) VALUES ($1, $2, $3)`, [
      type,
      `apex.${source}`,
      JSON.stringify(detail),
    ]);
  }

  async publishBatch(
    events: Array<{ type: ApexEventType; source: AgentId | 'orchestrator'; detail: Record<string, unknown> }>,
  ): Promise<void> {
    for (const e of events) await this.publish(e.type, e.source, e.detail);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isExpired(task: AgentTask): boolean {
  return new Date(task.expiresAt).getTime() < Date.now();
}

export function buildResult(
  task: AgentTask,
  agentId: AgentId,
  startedAt: number,
  status: TaskResult['status'],
  costPerMinute: number,
  output?: unknown,
  error?: TaskResult['error'],
): TaskResult {
  const finished = Date.now();
  const durationMs = finished - startedAt;
  return {
    taskId: task.taskId,
    runId: task.runId,
    agentId,
    status,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs,
    output,
    error,
    estimatedCostUsd: Number(((durationMs / 60_000) * costPerMinute).toFixed(6)),
  };
}
