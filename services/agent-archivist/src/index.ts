import { createExecutor, startHealthServer, Store } from '@apex/agent-runtime';
import { rootLogger } from '@apex/core';
import { Archivist } from './agent.js';

/** Entry point: long-lived process, polls its queue until drained or told to stop. */
const log = rootLogger.child({ service: 'agent-archivist', agentId: 'archivist' });

async function main(): Promise<void> {
  const executor = await createExecutor();
  const agent = new Archivist({
    agentId: 'archivist',
    executor,
    store: new Store(executor),
  });

  startHealthServer(Number(process.env.PORT ?? 8080), log, () => ({
    healthy: true,
    detail: { agent: 'archivist' },
  }));

  await agent.start();
}

main().catch((err) => {
  log.error('agent failed to start', { error: err });
  process.exit(1);
});
