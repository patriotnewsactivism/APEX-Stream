import { buildServerParts, config, log } from './server.js';

/**
 * Entry point. Listens on a port and runs the Beast-run expiry sweep
 * in-process via a timer — the only profile this service runs as.
 */
async function main(): Promise<void> {
  const { app, db, beast } = await buildServerParts();


  const expiryTimer = setInterval(() => {
    void beast.expireOverdueRuns().catch((err) => log.error('run expiry sweep failed', { error: err }));
  }, 60_000);
  expiryTimer.unref();

  const shutdown = async (signal: string): Promise<void> => {
    log.info('shutting down', { signal });
    clearInterval(expiryTimer);
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  log.info('orchestrator listening', { port: config.PORT, env: config.APEX_ENV });
}

main().catch((err) => {
  log.error('failed to start', { error: err });
  process.exit(1);
});
