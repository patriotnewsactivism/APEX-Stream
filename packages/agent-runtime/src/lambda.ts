import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import type { AgentTask } from '@apex/core';
import type { Agent } from './agent.js';

/**
 * Adapts an agent to an SQS event source mapping.
 *
 * Two details do the heavy lifting:
 *
 * **Partial batch failures.** Returning `batchItemFailures` means only the
 * messages that actually failed go back on the queue. Without it, one bad
 * message in a batch of ten redelivers all ten, and nine successful tasks are
 * re-run — which for collectors means duplicate fetches and duplicate spend.
 * The function must be configured with `ReportBatchItemFailures` for this to
 * take effect, which the lean stack does.
 *
 * **Lease operations are no-ops.** Under Lambda, SQS visibility is managed by
 * the event source mapping, not the function. Acking is "return without
 * listing this message"; nacking is "list it". There is nothing to extend, so
 * `keepAlive` does nothing — which is also why agents must keep individual
 * tasks well inside the function timeout rather than relying on heartbeats.
 */
export type SqsHandler = (event: SQSEvent) => Promise<SQSBatchResponse>;

export function createSqsHandler<P, O>(agent: Agent<P, O>): SqsHandler {
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const failures: Array<{ itemIdentifier: string }> = [];

    for (const record of event.Records) {
      const parsed = parseRecord<P>(record);
      if (!parsed) {
        // Unparseable body: do not retry it, the producer is broken. Leaving it
        // out of the failure list lets the redrive policy send it to the DLQ on
        // its own schedule rather than churning it here.
        continue;
      }

      const receiveCount = Number(record.attributes.ApproximateReceiveCount ?? '1');
      let shouldRetry = false;

      const outcome = await agent.runTask(parsed, receiveCount, {
        ack: async () => undefined,
        nack: async () => {
          shouldRetry = true;
        },
        keepAlive: async () => undefined,
      });

      if (shouldRetry || outcome === 'retry') {
        failures.push({ itemIdentifier: record.messageId });
      }
    }

    return { batchItemFailures: failures };
  };
}

function parseRecord<P>(record: SQSRecord): AgentTask<P> | null {
  try {
    return JSON.parse(record.body) as AgentTask<P>;
  } catch {
    return null;
  }
}
