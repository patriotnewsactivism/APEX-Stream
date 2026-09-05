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
 * Deliberately separate from starting it: `buildServer()` below returns a
 * ready Fastify instance with no port bound, so it can be driven with
 * `app.inject()` in tests without a real socket.
 */
export async function buildServerParts(): Promise<BuiltServer> {
  const executor = await createExecutor();
  const db = new Database(executor);
  const audit = new AuditWriter(db);
  const dispatcher = new Dispatcher(executor);
  const events = new EventBus(executor);
  const auth = new Authenticator();
  const beast = new BeastController(config, db, audit, dispatcher, events, log);

  const app = Fastify({
    logger: false, // structured logging goes through @apex/core's logger
    // Cloud Run sits exactly one hop in front of this service (Google Front
    // End) — trust that one hop's X-Forwarded-For entry, not the whole
    // client-supplied chain. `true` would let a client spoof request.ip by
    // prepending arbitrary values to its own X-Forwarded-For header, which
    // matters here because request.ip feeds both the rate-limit key below
    // and the audit trail's ipAddress field. Fastify's numeric hop-count
    // shorthand (`trustProxy: 1`) isn't in its shipped TypeScript types even
    // though @fastify/proxy-addr supports it at runtime, so this expresses
    // the identical "trust only hop 0" logic as the function form instead.
    trustProxy: (_address, hop) => hop < 1,
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
