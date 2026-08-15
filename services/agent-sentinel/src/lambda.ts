import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { createExecutor, createSqsHandler, Store } from '@apex/agent-runtime';
import { Sentinel } from './agent.js';

/**
 * Lambda entry point: same agent, driven by an SQS event source mapping instead
 * of a polling loop. Used by the `lean` profile, where nothing runs — and
 * nothing is billed — until a message arrives.
 *
 * Construction happens outside the handler so a warm container reuses the
 * database executor and the memory client across invocations.
 */
const handlerPromise = (async () => {
  const agent = new Sentinel({
    agentId: 'sentinel',
    queueUrl: process.env.QUEUE_URL ?? '',
    memoryTableName: process.env.MEMORY_TABLE ?? '',
    eventBusName: process.env.EVENT_BUS_NAME ?? '',
    store: new Store(await createExecutor()),
  });
  return createSqsHandler(agent);
})();

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  return (await handlerPromise)(event);
}
