import { buildServerParts, config, log } from './server.js';

/**
 * Container entry point. Listens on a port and runs the Beast-run expiry sweep
 * in-process. The lean profile uses `lambda.ts` instead, where expiry is driven
 * by an EventBridge schedule rather than a timer in a long-lived process.
 */
async function main(): Promise<void> {
  const { app, db, beast } = await buildServerParts();

<<<<<<< Updated upstream
  const app = Fastify({
    logger: false, // structured logging goes through @apex/core's logger
    trustProxy: true, // behind an ALB
    bodyLimit: 2 * 1024 * 1024,
    requestIdHeader: 'x-request-id',
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.DASHBOARD_ORIGIN === '*' ? true : config.DASHBOARD_ORIGIN.split(','),
    credentials: true,
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    // Beast activation is expensive; throttle it far harder than reads.
    keyGenerator: (req) => `${req.ip}:${req.url.startsWith('/api/beast') ? 'beast' : 'general'}`,
  });

  // Authenticate everything except health and the OPTIONS preflight.
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS' || request.url === '/health') return;
    const token = bearerFrom(request);
    if (!token) {
      await reply.code(401).send({ error: 'unauthenticated', message: 'Bearer token required.' });
      return;
    }
    try {
      request.principal = await auth.verify(token);
    } catch (err) {
      log.warn('token rejected', { error: err, path: request.url, ip: request.ip });
      await reply.code(401).send({ error: 'invalid_token', message: 'Sign in again.' });
    }
  });

  app.setErrorHandler(async (rawError, request, reply) => {
    const error = rawError as Error & { statusCode?: number; code?: string };
    const status = error.statusCode ?? 500;
    if (status >= 500) log.error('request failed', { error, path: request.url, method: request.method });
    else log.warn('request rejected', { message: error.message, path: request.url, status });
    await reply.code(status).send({
      error: error.code ?? 'internal_error',
      message: status >= 500 ? 'Something went wrong on our side.' : error.message,
      requestId: request.id,
    });
  });

  await registerRoutes(app, { config, db, audit, dispatcher, beast, log });

  // Wall-clock safety net for Beast runs, independent of any external scheduler.
=======
>>>>>>> Stashed changes
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
