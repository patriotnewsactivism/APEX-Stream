import { createExecutor, startHealthServer, Store } from '@apex/agent-runtime';
import { rootLogger } from '@apex/core';
import { Sentinel } from './agent.js';

/**
 * Container entry point: long-lived process, polls its queue until drained or
 * told to stop. Used by the `dev` and `prod` profiles.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

const log = rootLogger.child({ service: 'agent-sentinel', agentId: 'sentinel' });

async function main(): Promise<void> {
  const agent = new Sentinel({
    agentId: 'sentinel',
    queueUrl: required('QUEUE_URL'),
    memoryTableName: required('MEMORY_TABLE'),
    eventBusName: required('EVENT_BUS_NAME'),
    store: new Store(await createExecutor()),
  });

  startHealthServer(Number(process.env.PORT ?? 8080), log, () => ({
    healthy: true,
    detail: { agent: 'sentinel' },
  }));

  await agent.start();
}

main().catch((err) => {
  log.error('agent failed to start', { error: err });
  process.exit(1);
});
