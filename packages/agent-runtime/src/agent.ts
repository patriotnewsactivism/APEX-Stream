import { randomUUID } from 'node:crypto';
import {
  getAgent,
  Logger,
  rootLogger,
  type AgentDescriptor,
  type AgentHeartbeat,
  type AgentId,
  type AgentState,
  type AgentTask,
  type TaskResult,
} from '@apex/core';
import { AgentMemory } from './memory.js';
import { EventBus, TaskQueue, buildResult, isExpired, type ReceivedTask } from './bus.js';

export interface AgentConfig {
  agentId: AgentId;
  queueUrl: string;
  memoryTableName: string;
  eventBusName: string;
  /** Overrides the registry ceiling downward only — never upward. */
  concurrency?: number;
  version?: string;
  heartbeatIntervalMs?: number;
}

export interface AgentContext {
  memory: AgentMemory;
  events: EventBus;
  log: Logger;
  descriptor: AgentDescriptor;
  /** Extends the task lease. Call it during long work or SQS will redeliver. */
  keepAlive: () => Promise<void>;
}

/**
 * Base class for every agent in the fleet.
 *
 * Subclasses implement `handle()` and nothing else. Everything that is easy to
 * get subtly wrong — lease renewal, concurrency ceilings, retry classification,
 * expiry, graceful drain on SIGTERM — lives here so it is written once and
 * behaves identically across the fleet.
 *
 * Two behaviours worth calling out because they are deliberate:
 *
 * - **Expired tasks are dropped, not retried.** A task that has outlived its
 *   deadline is stale work; running it burns money to produce an answer nobody
 *   is waiting for. Beast mode makes this scenario common, so it is handled
 *   explicitly rather than left to a timeout.
 *
 * - **Non-retryable failures are acked, not nacked.** Retrying a task that
 *   failed on malformed input just re-fails it three more times and then fills
 *   the dead-letter queue with noise. Only transient faults go back on the queue.
 */
export abstract class Agent<TPayload = unknown, TOutput = unknown> {
  protected readonly descriptor: AgentDescriptor;
  protected readonly memory: AgentMemory;
  protected readonly events: EventBus;
  protected readonly queue: TaskQueue;
  protected readonly log: Logger;

  private readonly instanceId = randomUUID();
  private readonly concurrency: number;
  private readonly version: string;
  private readonly heartbeatIntervalMs: number;

  private state: AgentState = 'offline';
  private active = 0;
  private lastTaskAt: string | null = null;
  private draining = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(config: AgentConfig) {
    this.descriptor = getAgent(config.agentId);
    this.concurrency = Math.min(config.concurrency ?? this.descriptor.maxConcurrency, this.descriptor.maxConcurrency);
    this.version = config.version ?? process.env.APEX_VERSION ?? 'dev';
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? 30_000;

    this.memory = new AgentMemory(config.agentId, config.memoryTableName);
    this.events = new EventBus(config.eventBusName);
    this.queue = new TaskQueue(config.queueUrl);
    this.log = rootLogger.child({ service: `agent-${config.agentId}`, agentId: config.agentId, instanceId: this.instanceId });
  }

  /** Implement the actual work here. Throw to fail; return output to succeed. */
  protected abstract handle(task: AgentTask<TPayload>, ctx: AgentContext): Promise<TOutput>;

  /** Optional hook: called once before the loop starts. */
  protected async onStart(): Promise<void> {}
  /** Optional hook: called after the last in-flight task drains. */
  protected async onStop(): Promise<void> {}

  async start(): Promise<void> {
    this.state = 'starting';
    this.log.info('agent starting', {
      concurrency: this.concurrency,
      version: this.version,
      role: this.descriptor.role,
    });

    process.on('SIGTERM', () => this.requestDrain('SIGTERM'));
    process.on('SIGINT', () => this.requestDrain('SIGINT'));

    await this.onStart();
    this.startHeartbeat();
    this.state = 'idle';

    while (!this.draining) {
      try {
        const capacity = this.concurrency - this.active;
        if (capacity <= 0) {
          this.state = 'throttled';
          await sleep(250);
          continue;
        }
        const batch = await this.queue.receive(Math.min(capacity, 10));
        if (batch.length === 0) {
          this.state = this.active > 0 ? 'working' : 'idle';
          continue;
        }
        this.state = 'working';
        for (const received of batch) {
          this.active++;
          void this.process(received).finally(() => {
            this.active--;
          });
        }
      } catch (err) {
        this.state = 'degraded';
        this.log.error('receive loop error', { error: err });
        await sleep(2_000); // do not hot-spin against a failing dependency
      }
    }

    this.state = 'stopping';
    const deadline = Date.now() + 25_000; // stay under ECS stopTimeout
    while (this.active > 0 && Date.now() < deadline) await sleep(200);
    if (this.active > 0) {
      this.log.warn('drain deadline reached with tasks in flight', { active: this.active });
    }

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.onStop();
    await this.emitHeartbeat();
    this.state = 'offline';
    this.log.info('agent stopped');
  }

  private requestDrain(signal: string): void {
    if (this.draining) return;
    this.draining = true;
    this.log.info('drain requested', { signal, active: this.active });
  }

  private async process(received: ReceivedTask): Promise<void> {
    const task = received.task as AgentTask<TPayload>;
    const log = this.log.child({ taskId: task.taskId, runId: task.runId, traceId: task.traceId, kind: task.kind });
    const startedAt = Date.now();

    if (task.targetAgent !== this.descriptor.id) {
      log.warn('task addressed to another agent, returning to queue', { targetAgent: task.targetAgent });
      await this.queue.nack(received.receiptHandle, 1);
      return;
    }

    if (isExpired(task)) {
      log.warn('task expired before pickup, dropping', { expiresAt: task.expiresAt });
      await this.queue.ack(received.receiptHandle);
      await this.report(buildResult(task, this.descriptor.id, startedAt, 'expired', this.descriptor.costPerTaskMinuteUsd));
      return;
    }

    const ctx: AgentContext = {
      memory: this.memory,
      events: this.events,
      log,
      descriptor: this.descriptor,
      keepAlive: () => this.queue.heartbeat(received.receiptHandle),
    };

    try {
      const output = await this.handle(task, ctx);
      this.lastTaskAt = new Date().toISOString();
      await this.queue.ack(received.receiptHandle);
      const result = buildResult(task, this.descriptor.id, startedAt, 'succeeded', this.descriptor.costPerTaskMinuteUsd, output);
      await this.report(result);
      log.info('task succeeded', { durationMs: result.durationMs, costUsd: result.estimatedCostUsd });
    } catch (err) {
      const retryable = isRetryable(err);
      const error = {
        code: (err as { code?: string })?.code ?? 'TASK_FAILED',
        message: err instanceof Error ? err.message : String(err),
        retryable,
      };

      if (retryable && received.approximateReceiveCount < task.maxAttempts) {
        log.warn('task failed, returning for retry', { ...error, attempt: received.approximateReceiveCount });
        await this.queue.nack(received.receiptHandle, received.approximateReceiveCount);
        return;
      }

      // Terminal: ack so it does not churn, and record why.
      await this.queue.ack(received.receiptHandle);
      const result = buildResult(task, this.descriptor.id, startedAt, 'failed', this.descriptor.costPerTaskMinuteUsd, undefined, error);
      await this.report(result);
      log.error('task failed permanently', { ...error, attempts: received.approximateReceiveCount });
    }
  }

  private async report(result: TaskResult): Promise<void> {
    await this.events.publish(
      result.status === 'succeeded' ? 'task.completed' : 'task.failed',
      this.descriptor.id,
      result as unknown as Record<string, unknown>,
    );
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      void this.emitHeartbeat().catch((err) => this.log.warn('heartbeat failed', { error: err }));
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private async emitHeartbeat(): Promise<void> {
    const depth = await this.queue.depth().catch(() => ({ visible: -1, inFlight: -1 }));
    const beat: AgentHeartbeat = {
      agentId: this.descriptor.id,
      instanceId: this.instanceId,
      state: this.state,
      activeTasks: this.active,
      queueDepth: depth.visible,
      lastTaskAt: this.lastTaskAt,
      version: this.version,
      emittedAt: new Date().toISOString(),
    };
    await this.events.publish('agent.heartbeat', this.descriptor.id, beat as unknown as Record<string, unknown>);
  }
}

/**
 * Transient faults get another go; anything that looks like bad input or a
 * permissions problem does not, because retrying it cannot change the outcome.
 */
function isRetryable(err: unknown): boolean {
  if (err && typeof err === 'object') {
    if ('retryable' in err) return Boolean((err as { retryable: unknown }).retryable);
    const name = (err as { name?: string }).name ?? '';
    const code = (err as { code?: string }).code ?? '';
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status && status >= 500) return true;
    if (status === 429) return true;
    if (/Throttl|TooManyRequests|ServiceUnavailable|Timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(`${name} ${code}`)) return true;
    if (/AccessDenied|Validation|NotFound|InvalidParameter/i.test(`${name} ${code}`)) return false;
  }
  return true; // unknown failures are assumed transient once, then DLQ'd
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
