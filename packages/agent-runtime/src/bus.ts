import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SendMessageCommand,
  ChangeMessageVisibilityCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import type { AgentId, AgentTask, TaskResult } from '@apex/core';

/** Envelope carried on the wire, with the SQS receipt needed to ack. */
export interface ReceivedTask<T = unknown> {
  task: AgentTask<T>;
  receiptHandle: string;
  approximateReceiveCount: number;
}

export class TaskQueue {
  private readonly sqs: SQSClient;

  constructor(private readonly queueUrl: string, client?: SQSClient) {
    this.sqs = client ?? new SQSClient({});
  }

  /** Long-polls. Returns [] on timeout rather than throwing. */
  async receive(max = 5, waitSeconds = 20, visibilityTimeout = 300): Promise<ReceivedTask[]> {
    const res = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: Math.min(10, Math.max(1, max)),
        WaitTimeSeconds: waitSeconds,
        VisibilityTimeout: visibilityTimeout,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        MessageAttributeNames: ['All'],
      }),
    );
    return (res.Messages ?? []).flatMap((m) => {
      if (!m.Body || !m.ReceiptHandle) return [];
      try {
        return [
          {
            task: JSON.parse(m.Body) as AgentTask,
            receiptHandle: m.ReceiptHandle,
            approximateReceiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? '1'),
          },
        ];
      } catch {
        // Unparseable message: leave it to the redrive policy rather than
        // deleting evidence of a producer bug.
        return [];
      }
    });
  }

  async ack(receiptHandle: string): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle }),
    );
  }

  /** Return a task to the queue immediately, with backoff on retry count. */
  async nack(receiptHandle: string, attempt: number): Promise<void> {
    const backoff = Math.min(900, 2 ** Math.min(attempt, 9));
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: backoff,
      }),
    );
  }

  /** Extends the lease on a task that is still being worked. */
  async heartbeat(receiptHandle: string, seconds = 300): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  async send<T>(task: AgentTask<T>): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(task),
        MessageAttributes: {
          targetAgent: { DataType: 'String', StringValue: task.targetAgent },
          kind: { DataType: 'String', StringValue: task.kind },
          priority: { DataType: 'Number', StringValue: String(task.priority) },
        },
      }),
    );
  }

  async depth(): Promise<{ visible: number; inFlight: number }> {
    const res = await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.queueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    return {
      visible: Number(res.Attributes?.ApproximateNumberOfMessages ?? '0'),
      inFlight: Number(res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0'),
    };
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
 * EventBridge is the fan-out spine: agents publish facts, and workflows,
 * notifiers and the dashboard subscribe. Agents never call each other
 * directly — that keeps the topology a star rather than a mesh, so adding a
 * fifth agent does not require touching the other four.
 */
export class EventBus {
  private readonly client: EventBridgeClient;

  constructor(private readonly busName: string, client?: EventBridgeClient) {
    this.client = client ?? new EventBridgeClient({});
  }

  async publish(
    type: ApexEventType,
    source: AgentId | 'orchestrator',
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.client.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: this.busName,
            Source: `apex.${source}`,
            DetailType: type,
            Detail: JSON.stringify(detail),
            Time: new Date(),
          },
        ],
      }),
    );
  }

  /** Batches up to 10 entries — EventBridge's per-call limit. */
  async publishBatch(
    events: Array<{ type: ApexEventType; source: AgentId | 'orchestrator'; detail: Record<string, unknown> }>,
  ): Promise<void> {
    for (let i = 0; i < events.length; i += 10) {
      const chunk = events.slice(i, i + 10);
      await this.client.send(
        new PutEventsCommand({
          Entries: chunk.map((e) => ({
            EventBusName: this.busName,
            Source: `apex.${e.source}`,
            DetailType: e.type,
            Detail: JSON.stringify(e.detail),
            Time: new Date(),
          })),
        }),
      );
    }
  }
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
