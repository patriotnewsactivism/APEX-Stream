import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  AGENT_REGISTRY,
  ROLE_DEFINITIONS,
  verifyChain,
  type AgentId,
  type Logger,
} from '@apex/core';
import {
  WORKFLOW_TEMPLATES,
  executeWorkflow,
  validateWorkflow,
  type Workflow,
} from '@apex/workflow-engine';
import { requirePermission } from '../auth.js';
import type { BeastController } from '../beast.js';
import type { AuditWriter, Database } from '../db.js';
import type { Dispatcher } from '../dispatcher.js';
import { buildEffects } from '../effects.js';
import type { Config } from '../config.js';

export interface RouteDeps {
  config: Config;
  db: Database;
  audit: AuditWriter;
  dispatcher: Dispatcher;
  beast: BeastController;
  log: Logger;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { config, db, audit, dispatcher, beast, log } = deps;
  const guard = (permission: string) => requirePermission(permission, audit);

  // ---- health -------------------------------------------------------------
  app.get('/health', async (_req, reply) => {
    const dbOk = await db.healthy();
    return reply.code(dbOk ? 200 : 503).send({
      status: dbOk ? 'ok' : 'degraded',
      database: dbOk,
      version: process.env.APEX_VERSION ?? 'dev',
      env: config.APEX_ENV,
    });
  });

  // ---- identity -----------------------------------------------------------
  app.get('/api/me', async (request) => ({
    principal: request.principal,
    permissions: request.principal
      ? Object.fromEntries(
          request.principal.roles.map((r) => [r, { grants: ROLE_DEFINITIONS[r].grants, denies: ROLE_DEFINITIONS[r].denies }]),
        )
      : {},
  }));

  // ---- fleet --------------------------------------------------------------
  app.get('/api/agents', { preHandler: guard('agent:read') }, async () => {
    const depths = await dispatcher.fleetDepth();
    const heartbeats = await db.query<{ agent_id: string; state: string; active_tasks: number; emitted_at: string; version: string; instance_id: string }>(
      `SELECT DISTINCT ON (agent_id) agent_id, state, active_tasks, emitted_at, version, instance_id
         FROM agent_heartbeats ORDER BY agent_id, emitted_at DESC`,
    );
    const beatBy = new Map(heartbeats.map((h) => [h.agent_id, h]));

    return (Object.keys(AGENT_REGISTRY) as AgentId[]).map((id) => {
      const descriptor = AGENT_REGISTRY[id];
      const beat = beatBy.get(id);
      const staleMs = beat ? Date.now() - new Date(beat.emitted_at).getTime() : Number.POSITIVE_INFINITY;
      return {
        ...descriptor,
        state: !beat || staleMs > 120_000 ? 'offline' : beat.state,
        activeTasks: beat?.active_tasks ?? 0,
        instanceId: beat?.instance_id ?? null,
        version: beat?.version ?? null,
        lastHeartbeatAt: beat?.emitted_at ?? null,
        queue: depths[id] ?? { visible: -1, inFlight: -1 },
      };
    });
  });

  // ---- beast mode ---------------------------------------------------------
  const beastBody = z.object({
    durationMinutes: z.number().int().min(1).max(720).default(30),
    budgetUsd: z.number().min(0.5).max(1000).default(5),
    sourceTags: z.array(z.string()).default([]),
  });

  app.post('/api/beast/preflight', { preHandler: guard('agent:beast_mode') }, async (request) => {
    const body = beastBody.parse(request.body ?? {});
    return beast.preflight({ ...body, initiatedBy: request.principal?.username ?? 'unknown' });
  });

  app.post('/api/beast/activate', { preHandler: guard('agent:beast_mode') }, async (request, reply) => {
    const body = beastBody.parse(request.body ?? {});
    const result = await beast.activate({
      ...body,
      initiatedBy: request.principal?.username ?? 'unknown',
      traceId: request.id,
    });
    return reply.code(201).send(result);
  });

  app.post('/api/beast/deactivate/:runId', { preHandler: guard('run:cancel') }, async (request) => {
    const { runId } = z.object({ runId: z.string().uuid() }).parse(request.params);
    return beast.deactivate(runId, request.principal?.username ?? 'unknown');
  });

  app.get('/api/beast/active', { preHandler: guard('run:read') }, async () => ({
    run: await beast.activeRun(),
  }));

  // ---- runs ---------------------------------------------------------------
  app.get('/api/runs', { preHandler: guard('run:read') }, async (request) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query);
    return db.query(`SELECT * FROM runs ORDER BY started_at DESC LIMIT $1`, [limit]);
  });

  app.get('/api/runs/:runId', { preHandler: guard('run:read') }, async (request, reply) => {
    const { runId } = z.object({ runId: z.string().uuid() }).parse(request.params);
    const run = await beast.getRun(runId);
    if (!run) return reply.code(404).send({ error: 'not_found' });
    return run;
  });

  // ---- sources ------------------------------------------------------------
  const sourceBody = z.object({
    kind: z.enum(['rss', 'http_api', 'web_page', 'social', 'court_docket', 'live_stream', 'upload']),
    label: z.string().min(1).max(200),
    url: z.string().url(),
    intervalSeconds: z.number().int().min(0).max(86_400).default(900),
    ownerAgent: z.enum(['aria', 'atlas', 'sentinel', 'archivist']),
    tags: z.array(z.string()).default([]),
    authority: z.number().min(0).max(1).default(0.5),
    enabled: z.boolean().default(true),
  });

  app.get('/api/sources', { preHandler: guard('source:read') }, async () =>
    db.query(`SELECT * FROM sources ORDER BY label ASC`),
  );

  app.post('/api/sources', { preHandler: guard('source:create') }, async (request, reply) => {
    const body = sourceBody.parse(request.body);
    const row = await db.one(
      `INSERT INTO sources (kind, label, url, interval_seconds, owner_agent, tags, authority, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [body.kind, body.label, body.url, body.intervalSeconds, body.ownerAgent, body.tags, body.authority, body.enabled],
    );
    await audit.append({
      actor: request.principal?.username ?? 'unknown',
      actorType: 'human',
      action: 'source.created',
      resourceType: 'source',
      resourceId: String((row as Record<string, unknown>)?.id ?? ''),
      detail: { label: body.label, kind: body.kind, ownerAgent: body.ownerAgent },
      traceId: request.id,
      outcome: 'allowed',
    });
    return reply.code(201).send(row);
  });

  app.patch('/api/sources/:id', { preHandler: guard('source:update') }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = sourceBody.partial().parse(request.body);
    const row = await db.one(
      `UPDATE sources SET
         label = COALESCE($2, label), url = COALESCE($3, url),
         interval_seconds = COALESCE($4, interval_seconds), tags = COALESCE($5, tags),
         authority = COALESCE($6, authority), enabled = COALESCE($7, enabled), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, body.label ?? null, body.url ?? null, body.intervalSeconds ?? null, body.tags ?? null, body.authority ?? null, body.enabled ?? null],
    );
    await audit.append({
      actor: request.principal?.username ?? 'unknown',
      actorType: 'human',
      action: 'source.updated',
      resourceType: 'source',
      resourceId: id,
      detail: body as Record<string, unknown>,
      traceId: request.id,
      outcome: 'allowed',
    });
    return row;
  });

  // ---- anomalies ----------------------------------------------------------
  app.get('/api/anomalies', { preHandler: guard('anomaly:read') }, async (request) => {
    const q = z
      .object({
        band: z.enum(['info', 'notice', 'elevated', 'critical']).optional(),
        minScore: z.coerce.number().min(0).max(100).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(request.query);

    return db.query(
      `SELECT a.*, s.label AS source_label
         FROM anomalies a LEFT JOIN sources s ON s.id = a.source_id
        WHERE ($1::text IS NULL OR a.band = $1)
          AND ($2::numeric IS NULL OR a.score >= $2)
        ORDER BY a.detected_at DESC LIMIT $3`,
      [q.band ?? null, q.minScore ?? null, q.limit],
    );
  });

  app.post('/api/anomalies/:id/acknowledge', { preHandler: guard('anomaly:acknowledge') }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const actor = request.principal?.username ?? 'unknown';
    const row = await db.one(
      `UPDATE anomalies SET acknowledged_by = $2, acknowledged_at = now() WHERE id = $1 RETURNING *`,
      [id, actor],
    );
    await audit.append({
      actor, actorType: 'human', action: 'anomaly.acknowledged',
      resourceType: 'anomaly', resourceId: id, detail: {}, traceId: request.id, outcome: 'allowed',
    });
    return row;
  });

  // ---- evidence -----------------------------------------------------------
  app.get('/api/evidence', { preHandler: guard('evidence:read') }, async (request) => {
    const q = z.object({ anomalyId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query);
    const rows = await db.query(
      `SELECT * FROM evidence WHERE ($1::uuid IS NULL OR anomaly_id = $1) ORDER BY captured_at DESC LIMIT $2`,
      [q.anomalyId ?? null, q.limit],
    );
    await audit.append({
      actor: request.principal?.username ?? 'unknown',
      actorType: 'human',
      action: 'evidence.accessed',
      resourceType: 'evidence',
      resourceId: q.anomalyId ?? null,
      detail: { returned: rows.length },
      traceId: request.id,
      outcome: 'allowed',
    });
    return rows;
  });

  // Evidence deletion is refused at the API as well as at the bucket, and the
  // attempt itself is recorded — an attempted deletion is a security event.
  app.delete('/api/evidence/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await audit.append({
      actor: request.principal?.username ?? 'anonymous',
      actorType: 'human',
      action: 'evidence.delete_denied',
      resourceType: 'evidence',
      resourceId: id,
      detail: { reason: 'evidence is write-once under Object Lock' },
      ipAddress: request.ip,
      traceId: request.id,
      outcome: 'denied',
    });
    return reply.code(403).send({
      error: 'immutable',
      message:
        'Evidence is stored under S3 Object Lock in compliance mode and cannot be deleted by anyone, including account administrators, before its retention date.',
    });
  });

  // ---- workflows ----------------------------------------------------------
  app.get('/api/workflows/templates', { preHandler: guard('workflow:read') }, async () => WORKFLOW_TEMPLATES);

  app.get('/api/workflows', { preHandler: guard('workflow:read') }, async () =>
    db.query(`SELECT * FROM workflows ORDER BY updated_at DESC`),
  );

  app.post('/api/workflows/validate', { preHandler: guard('workflow:read') }, async (request) =>
    validateWorkflow(request.body),
  );

  app.post('/api/workflows', { preHandler: guard('workflow:create') }, async (request, reply) => {
    const result = validateWorkflow(request.body);
    if (!result.valid || !result.workflow) return reply.code(400).send(result);
    const wf = result.workflow;
    const row = await db.one(
      `INSERT INTO workflows (id, name, description, version, status, definition, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description,
         version = workflows.version + 1, definition = EXCLUDED.definition, updated_at = now()
       RETURNING *`,
      [wf.id, wf.name, wf.description, wf.version, wf.status, JSON.stringify(wf), request.principal?.username ?? 'unknown'],
    );
    await audit.append({
      actor: request.principal?.username ?? 'unknown',
      actorType: 'human',
      action: 'workflow.created',
      resourceType: 'workflow',
      resourceId: wf.id,
      detail: { name: wf.name, nodes: wf.nodes.length, warnings: result.issues.length },
      traceId: request.id,
      outcome: 'allowed',
    });
    return reply.code(201).send({ workflow: row, issues: result.issues });
  });

  app.post('/api/workflows/:id/execute', { preHandler: guard('workflow:execute') }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { dryRun } = z.object({ dryRun: z.boolean().default(false) }).parse(request.body ?? {});
    const row = await db.one<{ definition: Workflow }>(`SELECT definition FROM workflows WHERE id = $1`, [id]);
    if (!row) return reply.code(404).send({ error: 'not_found' });

    const result = await executeWorkflow(row.definition, buildEffects({ config, db, dispatcher }), {
      triggeredBy: request.principal?.username ?? 'unknown',
      log,
      dryRun,
    });

    await db.query(
      `INSERT INTO workflow_executions (id, workflow_id, status, dry_run, started_at, finished_at, nodes_executed, estimated_cost_usd, result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [result.executionId, id, result.status, result.dryRun, result.startedAt, result.finishedAt, result.nodesExecuted, result.estimatedCostUsd, JSON.stringify(result)],
    );
    return result;
  });

  // ---- audit --------------------------------------------------------------
  app.get('/api/audit', { preHandler: guard('audit:read') }, async (request) => {
    const q = z.object({ from: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(1000).default(200) }).parse(request.query);
    return audit.range(q.from, q.limit);
  });

  /** Proves the audit chain has not been altered. Cheap enough to run on demand. */
  app.get('/api/audit/verify', { preHandler: guard('audit:read') }, async (request) => {
    const q = z.object({ from: z.coerce.number().int().min(0).default(0) }).parse(request.query);
    const entries = await audit.range(q.from, 2000);
    return { ...verifyChain(entries), from: q.from };
  });
}
