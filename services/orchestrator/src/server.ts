import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { createExecutor, EventBus } from '@apex/agent-runtime';
import { rootLogger } from '@apex/core';
import { loadConfig } from './config.js';
import { AuditWriter, Database } from './db.js';
import { Authenticator, bearerFrom } from './auth.js';
import { Dispatcher } from './dispatcher.js';
import { BeastController } from './beast.js';
import { registerRoutes } from './routes/index.js';

const config = loadConfig();
const log = rootLogger.child({ service: 'orchestrator', env: config.APEX_ENV });

export interface BuiltServer {
  app: FastifyInstance;
  db: Database;
  beast: BeastController;
}

/**
 * Constructs the API.
 *
 * Deliberately separate from starting it: the container entry point listens on
 * a port, the Lambda entry point wraps the same instance in a proxy. Neither
 * knows anything the other does not.
 */
export async function buildServerParts(): Promise<BuiltServer> {
  const db = new Database(await createExecutor());
  const audit = new AuditWriter(db);
  const dispatcher = new Dispatcher(config);
  const events = new EventBus(config.EVENT_BUS_NAME);
  const auth = new Authenticator(config);
  const beast = new BeastController(config, db, audit, dispatcher, events, log);

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
    // The scheduled expiry sweep arrives without a user token; it is invoked
    // by EventBridge inside the account and cannot be reached from outside.
    if (request.method === 'OPTIONS' || request.url === '/health') return;
    if (request.url === '/internal/expire-runs' && request.headers['x-apex-internal'] === 'schedule') return;
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

  app.setErrorHandler(async (error: unknown, request, reply) => {
    // Fastify hands this back loosely typed, and a thrown non-Error is always
    // possible in JavaScript. Normalise once so nothing below can explode
    // while trying to report an error.
    const asRecord = (error ?? {}) as { statusCode?: number; code?: string; message?: string };
    const status = typeof asRecord.statusCode === 'number' ? asRecord.statusCode : 500;
    const message = error instanceof Error ? error.message : String(asRecord.message ?? 'unknown error');

    if (status >= 500) log.error('request failed', { error, path: request.url, method: request.method });
    else log.warn('request rejected', { message, path: request.url, status });

    await reply.code(status).send({
      error: asRecord.code ?? 'internal_error',
      // Never leak internal failure detail to the caller; it is in the logs.
      message: status >= 500 ? 'Something went wrong on our side.' : message,
      requestId: request.id,
    });
  });

  await registerRoutes(app, { config, db, audit, dispatcher, beast, log });


  return { app, db, beast };
}

export async function buildServer(): Promise<FastifyInstance> {
  const { app } = await buildServerParts();
  await app.ready();
  return app;
}

export { config, log };
