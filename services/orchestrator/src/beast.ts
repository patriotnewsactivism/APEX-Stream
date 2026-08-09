import { randomUUID } from 'node:crypto';
import { EventBus } from '@apex/agent-runtime';
import {
  AGENT_REGISTRY,
  BudgetExceededError,
  ValidationError,
  type AgentId,
  type Logger,
  type Run,
  type RunBudget,
} from '@apex/core';
import type { Config } from './config.js';
import type { AuditWriter, Database } from './db.js';
import type { Dispatcher } from './dispatcher.js';

/**
 * Beast mode — every agent, every source, at once.
 *
 * The feature is genuinely useful in exactly one situation: something is
 * happening right now and you want maximum coverage while it happens. It is
 * also the single most expensive button in the product, so the design assumption
 * is that it will be pressed under time pressure by someone who is not thinking
 * about their AWS bill.
 *
 * Four rails, all mandatory and none of them overridable from the UI:
 *
 *   1. **Cost ceiling.** The run halts itself when accrued spend crosses the
 *      budget. Cost accrues from real task results, not estimates.
 *   2. **Wall-clock expiry.** Every run has a hard end time. Forgetting to turn
 *      Beast mode off is the expected failure mode, so it turns itself off.
 *   3. **Concurrency ceiling.** Per agent and fleet-wide, so a burst cannot
 *      scale ECS into a bill-shaped hole.
 *   4. **Single-flight.** One Beast run at a time. Two operators reacting to
 *      the same event must not double the spend.
 *
 * A preflight projection is returned before activation so the operator sees the
 * likely cost *before* committing, not in next month's invoice.
 */

export interface BeastPreflight {
  allowed: boolean;
  reason: string | null;
  agents: Array<{ agentId: AgentId; sources: number; concurrency: number; projectedCostUsd: number }>;
  totalSources: number;
  projectedCostUsd: number;
  budgetUsd: number;
  durationMinutes: number;
  maxConcurrentTasks: number;
  /** Set when the projection exceeds the budget — the run would halt early. */
  warning: string | null;
}

export interface BeastRequest {
  durationMinutes: number;
  budgetUsd: number;
  sourceTags?: string[];
  initiatedBy: string;
  traceId?: string;
}

export class BeastController {
  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly audit: AuditWriter,
    private readonly dispatcher: Dispatcher,
    private readonly events: EventBus,
    private readonly log: Logger,
  ) {}

  /** Cost/scope projection. Cheap, read-only, safe to call from the UI on input. */
  async preflight(request: BeastRequest): Promise<BeastPreflight> {
    const duration = clamp(request.durationMinutes, 1, this.config.BEAST_MAX_DURATION_MINUTES);
    const budget = clamp(request.budgetUsd, 0.5, this.config.BEAST_MAX_BUDGET_USD);

    const active = await this.activeRun();
    const sources = await this.sourceCounts(request.sourceTags ?? []);
    const totalSources = Object.values(sources).reduce((a, b) => a + b, 0);

    const agents = (Object.keys(AGENT_REGISTRY) as AgentId[]).map((agentId) => {
      const descriptor = AGENT_REGISTRY[agentId];
      const assigned = sources[agentId] ?? 0;
      // Concurrency is bounded by the agent's ceiling, its share of the
      // fleet-wide cap, and the work actually available.
      const fleetShare = Math.floor(this.config.BEAST_MAX_CONCURRENT_TASKS / 4);
      const concurrency = Math.max(1, Math.min(descriptor.maxConcurrency, fleetShare, Math.max(1, assigned)));
      const projectedCostUsd = Number((concurrency * duration * descriptor.costPerTaskMinuteUsd).toFixed(4));
      return { agentId, sources: assigned, concurrency, projectedCostUsd };
    });

    const projectedCostUsd = Number(agents.reduce((s, a) => s + a.projectedCostUsd, 0).toFixed(4));

    let reason: string | null = null;
    if (active) reason = `Beast run ${active.id} is already active until ${active.expiresAt}. Stop it before starting another.`;
    else if (totalSources === 0) reason = 'No enabled sources match the requested tags — there is nothing to monitor.';

    return {
      allowed: reason === null,
      reason,
      agents,
      totalSources,
      projectedCostUsd,
      budgetUsd: budget,
      durationMinutes: duration,
      maxConcurrentTasks: this.config.BEAST_MAX_CONCURRENT_TASKS,
      warning:
        projectedCostUsd > budget
          ? `Projected spend $${projectedCostUsd.toFixed(2)} exceeds the $${budget.toFixed(2)} budget — the run will halt itself partway through. Raise the budget or shorten the window.`
          : null,
    };
  }

  async activate(request: BeastRequest): Promise<{ run: Run; dispatched: number; preflight: BeastPreflight }> {
    const preflight = await this.preflight(request);
    if (!preflight.allowed) throw new ValidationError(preflight.reason ?? 'Beast mode cannot start', { preflight });

    const runId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + preflight.durationMinutes * 60_000);

    const budget: RunBudget = {
      maxCostUsd: preflight.budgetUsd,
      accruedCostUsd: 0,
      maxTasks: preflight.agents.reduce((s, a) => s + a.concurrency, 0) * preflight.durationMinutes,
      dispatchedTasks: 0,
      maxConcurrentTasks: this.config.BEAST_MAX_CONCURRENT_TASKS,
    };

    const run: Run = {
      id: runId,
      mode: 'beast',
      status: 'running',
      initiatedBy: request.initiatedBy,
      participatingAgents: preflight.agents.map((a) => a.agentId),
      workflowId: null,
      startedAt: now.toISOString(),
      endedAt: null,
      expiresAt: expiresAt.toISOString(),
      budget,
      stats: { observations: 0, anomalies: 0, criticalAnomalies: 0, evidenceArchived: 0, notificationsSent: 0, failures: 0 },
    };

    await this.db.query(
      `INSERT INTO runs (id, mode, status, initiated_by, participating_agents, workflow_id,
                         started_at, ended_at, expires_at, budget, stats)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        run.id, run.mode, run.status, run.initiatedBy, JSON.stringify(run.participatingAgents), null,
        run.startedAt, null, run.expiresAt, JSON.stringify(run.budget), JSON.stringify(run.stats),
      ],
    );

    // Sweep tasks are dispatched per agent up to its computed concurrency. The
    // TTL is the remaining run window, so nothing outlives the run itself.
    const ttlSeconds = Math.floor((expiresAt.getTime() - now.getTime()) / 1000);
    let dispatched = 0;
    for (const plan of preflight.agents) {
      for (let slot = 0; slot < plan.concurrency; slot++) {
        await this.dispatcher.dispatch({
          agent: plan.agentId,
          kind: 'collect',
          runId,
          issuedBy: 'orchestrator',
          priority: 1,
          ttlSeconds,
          traceId: request.traceId,
          payload: {
            mode: 'beast',
            slot,
            slotCount: plan.concurrency,
            sourceTags: request.sourceTags ?? [],
            sweepUntil: expiresAt.toISOString(),
          },
        });
        dispatched++;
      }
    }

    await this.db.query(`UPDATE runs SET budget = jsonb_set(budget, '{dispatchedTasks}', $2::jsonb) WHERE id = $1`, [
      runId,
      JSON.stringify(dispatched),
    ]);

    await this.audit.append({
      actor: request.initiatedBy,
      actorType: 'human',
      action: 'beast.activated',
      resourceType: 'run',
      resourceId: runId,
      detail: {
        durationMinutes: preflight.durationMinutes,
        budgetUsd: preflight.budgetUsd,
        projectedCostUsd: preflight.projectedCostUsd,
        agents: preflight.agents,
        dispatched,
        sourceTags: request.sourceTags ?? [],
      },
      traceId: request.traceId ?? null,
      outcome: 'allowed',
    });

    await this.events.publish('run.status_changed', 'orchestrator', { runId, status: 'running', mode: 'beast' });
    this.log.warn('BEAST MODE ACTIVATED', { runId, dispatched, budgetUsd: preflight.budgetUsd, expiresAt: run.expiresAt });

    return { run: { ...run, budget: { ...budget, dispatchedTasks: dispatched } }, dispatched, preflight };
  }

  async deactivate(runId: string, actor: string, reason = 'operator stopped the run'): Promise<Run> {
    const run = await this.getRun(runId);
    if (!run) throw new ValidationError(`run ${runId} not found`);
    if (run.status !== 'running') return run;

    await this.db.query(`UPDATE runs SET status = 'cancelled', ended_at = now() WHERE id = $1`, [runId]);
    await this.audit.append({
      actor,
      actorType: actor === 'system' ? 'system' : 'human',
      action: 'beast.deactivated',
      resourceType: 'run',
      resourceId: runId,
      detail: { reason, accruedCostUsd: run.budget.accruedCostUsd, stats: run.stats },
      outcome: 'allowed',
    });
    await this.events.publish('run.status_changed', 'orchestrator', { runId, status: 'cancelled', reason });
    this.log.info('beast mode deactivated', { runId, reason });

    // Queued tasks are left to expire rather than purged: purging a queue also
    // destroys unrelated in-flight work, and every task already carries a TTL.
    return { ...run, status: 'cancelled', endedAt: new Date().toISOString() };
  }

  /**
   * Applies a completed task's cost to its run and halts the run if the budget
   * is gone. Called from the task-result consumer, not from a request handler.
   */
  async accrue(runId: string, costUsd: number): Promise<{ halted: boolean; accrued: number }> {
    const row = await this.db.one<{ budget: RunBudget; status: string }>(
      `UPDATE runs
          SET budget = jsonb_set(budget, '{accruedCostUsd}',
                to_jsonb(round(((budget->>'accruedCostUsd')::numeric + $2::numeric), 6)))
        WHERE id = $1
        RETURNING budget, status`,
      [runId, costUsd],
    );
    if (!row) return { halted: false, accrued: 0 };

    const accrued = Number(row.budget.accruedCostUsd);
    const limit = Number(row.budget.maxCostUsd);

    if (row.status === 'running' && accrued >= limit) {
      await this.db.query(`UPDATE runs SET status = 'budget_halted', ended_at = now() WHERE id = $1`, [runId]);
      await this.audit.append({
        actor: 'system',
        actorType: 'system',
        action: 'run.halted',
        resourceType: 'run',
        resourceId: runId,
        detail: { reason: 'budget exhausted', accruedCostUsd: accrued, maxCostUsd: limit },
        outcome: 'allowed',
      });
      await this.events.publish('budget.threshold_crossed', 'orchestrator', { runId, accrued, limit });
      this.log.warn('run halted on budget', { runId, accrued, limit });
      throw new BudgetExceededError(runId, accrued, limit);
    }

    // Early warning at 80% so the operator can extend before work stops.
    if (row.status === 'running' && accrued >= limit * 0.8 && accrued - costUsd < limit * 0.8) {
      await this.events.publish('budget.threshold_crossed', 'orchestrator', { runId, accrued, limit, threshold: 0.8 });
    }

    return { halted: false, accrued };
  }

  /** Ends runs whose wall-clock window has passed. Called on a schedule. */
  async expireOverdueRuns(): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE runs SET status = 'expired', ended_at = now()
        WHERE status = 'running' AND expires_at < now()
        RETURNING id`,
    );
    for (const row of rows) {
      await this.audit.append({
        actor: 'system',
        actorType: 'system',
        action: 'run.halted',
        resourceType: 'run',
        resourceId: row.id,
        detail: { reason: 'run window expired' },
        outcome: 'allowed',
      });
      this.log.info('run expired', { runId: row.id });
    }
    return rows.map((r) => r.id);
  }

  async activeRun(): Promise<Run | null> {
    const row = await this.db.one<Record<string, unknown>>(
      `SELECT * FROM runs WHERE mode = 'beast' AND status = 'running' ORDER BY started_at DESC LIMIT 1`,
    );
    return row ? rowToRun(row) : null;
  }

  async getRun(runId: string): Promise<Run | null> {
    const row = await this.db.one<Record<string, unknown>>(`SELECT * FROM runs WHERE id = $1`, [runId]);
    return row ? rowToRun(row) : null;
  }

  private async sourceCounts(tags: string[]): Promise<Record<string, number>> {
    const rows = tags.length
      ? await this.db.query<{ owner_agent: string; count: string }>(
          `SELECT owner_agent, count(*)::text FROM sources
            WHERE enabled = true AND tags && $1::text[] GROUP BY owner_agent`,
          [tags],
        )
      : await this.db.query<{ owner_agent: string; count: string }>(
          `SELECT owner_agent, count(*)::text FROM sources WHERE enabled = true GROUP BY owner_agent`,
        );
    return Object.fromEntries(rows.map((r) => [r.owner_agent, Number(r.count)]));
  }
}

function rowToRun(row: Record<string, unknown>): Run {
  return {
    id: row.id as string,
    mode: row.mode as Run['mode'],
    status: row.status as Run['status'],
    initiatedBy: row.initiated_by as string,
    participatingAgents: (row.participating_agents as AgentId[]) ?? [],
    workflowId: (row.workflow_id as string | null) ?? null,
    startedAt: new Date(row.started_at as string).toISOString(),
    endedAt: row.ended_at ? new Date(row.ended_at as string).toISOString() : null,
    expiresAt: new Date(row.expires_at as string).toISOString(),
    budget: row.budget as RunBudget,
    stats: row.stats as Run['stats'],
  };
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}
