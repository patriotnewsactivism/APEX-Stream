import { randomUUID } from 'node:crypto';
import { TaskQueue } from '@apex/agent-runtime';
import { AGENT_REGISTRY, type AgentId, type AgentTask, type TaskKind } from '@apex/core';
import { queueUrlFor, type Config } from './config.js';

/**
 * Sends work to agents.
 *
 * Every task carries an explicit `expiresAt`. This matters most in Beast mode:
 * when four agents are saturated and a run is cancelled, the queues still hold
 * thousands of messages. Rather than purging queues (which destroys in-flight
 * work indiscriminately), tasks simply age out and agents drop them on pickup.
 */
export class Dispatcher {
  private readonly queues = new Map<AgentId, TaskQueue>();

  constructor(private readonly config: Config) {
    for (const agentId of Object.keys(AGENT_REGISTRY) as AgentId[]) {
      this.queues.set(agentId, new TaskQueue(queueUrlFor(config, agentId)));
    }
  }

  async dispatch<T>(input: {
    agent: AgentId;
    kind: TaskKind;
    runId: string;
    payload: T;
    issuedBy: string;
    priority?: number;
    ttlSeconds?: number;
    maxAttempts?: number;
    traceId?: string;
  }): Promise<AgentTask<T>> {
    const queue = this.queues.get(input.agent);
    if (!queue) throw new Error(`no queue for agent "${input.agent}"`);

    const ttl = Math.max(30, input.ttlSeconds ?? 900);
    const task: AgentTask<T> = {
      taskId: randomUUID(),
      runId: input.runId,
      kind: input.kind,
      targetAgent: input.agent,
      issuedBy: input.issuedBy as AgentTask['issuedBy'],
      issuedAt: new Date().toISOString(),
      priority: input.priority ?? 5,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      attempt: 0,
      maxAttempts: input.maxAttempts ?? 3,
      payload: input.payload,
      traceId: input.traceId ?? randomUUID(),
    };

    await queue.send(task);
    return task;
  }

  async fleetDepth(): Promise<Record<AgentId, { visible: number; inFlight: number }>> {
    const entries = await Promise.all(
      [...this.queues.entries()].map(async ([agentId, queue]) => {
        const depth = await queue.depth().catch(() => ({ visible: -1, inFlight: -1 }));
        return [agentId, depth] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<AgentId, { visible: number; inFlight: number }>;
  }
}
