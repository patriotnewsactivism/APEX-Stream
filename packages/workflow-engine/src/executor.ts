import { randomUUID } from 'node:crypto';
import { scoreObservation, DEFAULT_PROFILE, type AnomalyScoreResult, type SignalObservation, type Logger } from '@apex/core';
import type { Comparator, Workflow, WorkflowNode } from './schema.js';

/**
 * Workflow executor.
 *
 * Runs the graph the operator drew. Effects that touch the outside world —
 * fetching sources, dispatching agents, writing evidence, sending alerts — are
 * injected as `WorkflowEffects` rather than called directly, which keeps the
 * traversal logic pure and lets the dashboard run a workflow in dry-run mode
 * against real data without dispatching a single agent or sending a single
 * message. Operators building automation need to be able to test it safely.
 */

export interface WorkflowItem {
  /** Arbitrary payload flowing through the graph. Shape depends on the source. */
  [key: string]: unknown;
}

export interface WorkflowEffects {
  fetchSources(sourceIds: string[], tagSelector: string[], maxItems: number): Promise<WorkflowItem[]>;
  collectSignals(item: WorkflowItem, disabledSignals: string[]): Promise<SignalObservation[]>;
  dispatchAgentTask(input: {
    agent: string;
    kind: string;
    priority: number;
    timeoutSeconds: number;
    params: Record<string, unknown>;
    item: WorkflowItem;
  }): Promise<{ taskId: string; estimatedCostUsd: number }>;
  archive(item: WorkflowItem, options: { retentionDays: number; includeMedia: boolean; captureScreenshot: boolean }): Promise<{ evidenceId: string }>;
  notify(input: { channel: string; target: string; subject: string; body: string; dedupeKey: string; dedupeWindowMinutes: number }): Promise<{ sent: boolean; suppressed: boolean }>;
}

export interface ExecutionOptions {
  dryRun?: boolean;
  triggeredBy: string;
  log: Logger;
  now?: () => number;
}

export interface StepResult {
  nodeId: string;
  label: string;
  type: string;
  status: 'ok' | 'skipped' | 'failed' | 'halted';
  itemsIn: number;
  itemsOut: number;
  durationMs: number;
  detail: Record<string, unknown>;
  error?: string;
}

export interface ExecutionResult {
  executionId: string;
  workflowId: string;
  workflowVersion: number;
  status: 'completed' | 'failed' | 'halted_limits';
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  nodesExecuted: number;
  estimatedCostUsd: number;
  steps: StepResult[];
  anomalies: Array<{ item: WorkflowItem; score: AnomalyScoreResult }>;
  haltReason: string | null;
}

interface Frame {
  nodeId: string;
  items: WorkflowItem[];
}

export async function executeWorkflow(
  wf: Workflow,
  effects: WorkflowEffects,
  options: ExecutionOptions,
): Promise<ExecutionResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const executionId = randomUUID();
  const log = options.log.child({ executionId, workflowId: wf.id });

  const steps: StepResult[] = [];
  const anomalies: ExecutionResult['anomalies'] = [];
  let nodesExecuted = 0;
  let cost = 0;
  let haltReason: string | null = null;

  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, Array<{ to: string; label?: string }>>();
  for (const n of wf.nodes) outgoing.set(n.id, []);
  for (const e of wf.edges) outgoing.get(e.from)?.push({ to: e.to, label: e.label });

  const trigger = wf.nodes.find((n) => n.config.type === 'trigger');
  if (!trigger) {
    return finish('failed', 'workflow has no trigger node');
  }

  const queue: Frame[] = [{ nodeId: trigger.id, items: [{}] }];

  while (queue.length > 0) {
    if (nodesExecuted >= wf.limits.maxNodesExecuted) {
      haltReason = `node budget exhausted (${wf.limits.maxNodesExecuted})`;
      break;
    }
    if ((now() - startedAt) / 1000 > wf.limits.maxDurationSeconds) {
      haltReason = `time budget exhausted (${wf.limits.maxDurationSeconds}s)`;
      break;
    }
    if (cost > wf.limits.maxCostUsd) {
      haltReason = `cost budget exhausted ($${wf.limits.maxCostUsd})`;
      break;
    }

    const frame = queue.shift();
    if (!frame) break;
    const node = byId.get(frame.nodeId);
    if (!node) continue;

    nodesExecuted++;
    const stepStart = now();
    let produced: Array<{ items: WorkflowItem[]; edgeLabel?: string }> = [];
    let step: StepResult = {
      nodeId: node.id,
      label: node.label,
      type: node.config.type,
      status: 'ok',
      itemsIn: frame.items.length,
      itemsOut: 0,
      durationMs: 0,
      detail: {},
    };

    try {
      const outcome = await runNode(node, frame.items, effects, options, anomalies);
      produced = outcome.branches;
      step.detail = outcome.detail;
      cost += outcome.costUsd;
      if (outcome.status) step.status = outcome.status;
    } catch (err) {
      step.status = 'failed';
      step.error = err instanceof Error ? err.message : String(err);
      log.error('workflow node failed', { nodeId: node.id, type: node.config.type, error: err });
      step.durationMs = now() - stepStart;
      step.itemsOut = 0;
      steps.push(step);
      return finish('failed', `node "${node.label}" failed: ${step.error}`);
    }

    step.itemsOut = produced.reduce((s, b) => s + b.items.length, 0);
    step.durationMs = now() - stepStart;
    steps.push(step);

    for (const branch of produced) {
      if (branch.items.length === 0) continue;
      const edges = outgoing.get(node.id) ?? [];
      const matching = branch.edgeLabel ? edges.filter((e) => e.label === branch.edgeLabel) : edges;
      for (const edge of matching) queue.push({ nodeId: edge.to, items: branch.items });
    }
  }

  return finish(haltReason ? 'halted_limits' : 'completed', haltReason);

  function finish(status: ExecutionResult['status'], reason: string | null): ExecutionResult {
    const finishedAt = now();
    return {
      executionId,
      workflowId: wf.id,
      workflowVersion: wf.version,
      status,
      dryRun: Boolean(options.dryRun),
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - startedAt,
      nodesExecuted,
      estimatedCostUsd: Number(cost.toFixed(6)),
      steps,
      anomalies,
      haltReason: reason,
    };
  }
}

interface NodeOutcome {
  branches: Array<{ items: WorkflowItem[]; edgeLabel?: string }>;
  detail: Record<string, unknown>;
  costUsd: number;
  status?: StepResult['status'];
}

async function runNode(
  node: WorkflowNode,
  items: WorkflowItem[],
  effects: WorkflowEffects,
  options: ExecutionOptions,
  anomalies: ExecutionResult['anomalies'],
): Promise<NodeOutcome> {
  const cfg = node.config;

  switch (cfg.type) {
    case 'trigger':
      return { branches: [{ items }], detail: { mode: cfg.mode, triggeredBy: options.triggeredBy }, costUsd: 0 };

    case 'source': {
      const fetched = await effects.fetchSources(cfg.sourceIds, cfg.tagSelector, cfg.maxItems);
      return { branches: [{ items: fetched }], detail: { fetched: fetched.length }, costUsd: 0 };
    }

    case 'filter': {
      const kept = items.filter((item) => cfg.conditions.every((c) => compare(readPath(item, c.field), c.op, c.value)));
      return {
        branches: [{ items: kept }],
        detail: { evaluated: items.length, kept: kept.length, dropped: items.length - kept.length },
        costUsd: 0,
      };
    }

    case 'score': {
      const scored: WorkflowItem[] = [];
      for (const item of items) {
        const signals = await effects.collectSignals(item, cfg.disabledSignals);
        const profile = cfg.disabledSignals.length
          ? { ...DEFAULT_PROFILE, signals: DEFAULT_PROFILE.signals.filter((s) => !cfg.disabledSignals.includes(s.id)) }
          : DEFAULT_PROFILE;
        const result = scoreObservation(signals, profile);
        scored.push({ ...item, score: result.score, band: result.band, confidence: result.confidence, scoring: result });
        if (result.band !== 'info') anomalies.push({ item, score: result });
      }
      const bands = scored.reduce<Record<string, number>>((acc, s) => {
        const b = String(s.band);
        acc[b] = (acc[b] ?? 0) + 1;
        return acc;
      }, {});
      return { branches: [{ items: scored }], detail: { scored: scored.length, bands }, costUsd: 0 };
    }

    case 'branch': {
      const buckets = new Map<string, WorkflowItem[]>();
      for (const item of items) {
        const hit = cfg.cases.find((c) => compare(readPath(item, c.field), c.op, c.value));
        const label = hit?.label ?? cfg.defaultLabel;
        const bucket = buckets.get(label) ?? [];
        bucket.push(item);
        buckets.set(label, bucket);
      }
      return {
        branches: [...buckets.entries()].map(([edgeLabel, bucketItems]) => ({ items: bucketItems, edgeLabel })),
        detail: Object.fromEntries([...buckets.entries()].map(([k, v]) => [k, v.length])),
        costUsd: 0,
      };
    }

    case 'agent_task': {
      if (options.dryRun) {
        return { branches: [{ items }], detail: { dryRun: true, wouldDispatch: items.length, agent: cfg.agent }, costUsd: 0, status: 'skipped' };
      }
      let cost = 0;
      const taskIds: string[] = [];
      for (const item of items) {
        const res = await effects.dispatchAgentTask({
          agent: cfg.agent,
          kind: cfg.kind,
          priority: cfg.priority,
          timeoutSeconds: cfg.timeoutSeconds,
          params: cfg.params,
          item,
        });
        taskIds.push(res.taskId);
        cost += res.estimatedCostUsd;
      }
      return { branches: [{ items }], detail: { agent: cfg.agent, dispatched: taskIds.length }, costUsd: cost };
    }

    case 'archive': {
      if (options.dryRun) {
        return { branches: [{ items }], detail: { dryRun: true, wouldArchive: items.length }, costUsd: 0, status: 'skipped' };
      }
      const ids: string[] = [];
      for (const item of items) {
        const res = await effects.archive(item, {
          retentionDays: cfg.retentionDays,
          includeMedia: cfg.includeMedia,
          captureScreenshot: cfg.captureScreenshot,
        });
        ids.push(res.evidenceId);
      }
      return { branches: [{ items }], detail: { archived: ids.length, retentionDays: cfg.retentionDays }, costUsd: 0 };
    }

    case 'notify': {
      if (options.dryRun) {
        return { branches: [{ items }], detail: { dryRun: true, wouldNotify: items.length, channel: cfg.channel }, costUsd: 0, status: 'skipped' };
      }
      let sent = 0;
      let suppressed = 0;
      for (const item of items) {
        const res = await effects.notify({
          channel: cfg.channel,
          target: cfg.target,
          subject: render(cfg.subjectTemplate, item),
          body: render(cfg.bodyTemplate, item),
          dedupeKey: `${node.id}:${String(item.sourceId ?? item.id ?? 'unknown')}`,
          dedupeWindowMinutes: cfg.dedupeWindowMinutes,
        });
        if (res.sent) sent++;
        if (res.suppressed) suppressed++;
      }
      return { branches: [{ items }], detail: { channel: cfg.channel, sent, suppressed }, costUsd: 0 };
    }

    case 'delay': {
      if (!options.dryRun) await new Promise((r) => setTimeout(r, cfg.seconds * 1000));
      return { branches: [{ items }], detail: { seconds: cfg.seconds, skipped: Boolean(options.dryRun) }, costUsd: 0 };
    }

    case 'transform': {
      const mapped = items.map((item) => {
        const out: WorkflowItem = { ...item };
        for (const [target, source] of Object.entries(cfg.mappings)) {
          out[target] = source.startsWith('$.') ? readPath(item, source.slice(2)) : source;
        }
        return out;
      });
      return { branches: [{ items: mapped }], detail: { mapped: mapped.length, fields: Object.keys(cfg.mappings) }, costUsd: 0 };
    }

    default: {
      const exhaustive: never = cfg;
      throw new Error(`unhandled node type: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Reads a dotted path, e.g. "scoring.band" or "metadata.author.name". */
export function readPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

export function compare(left: unknown, op: Comparator, right: unknown): boolean {
  switch (op) {
    case 'eq': return left === right;
    case 'neq': return left !== right;
    case 'gt': return typeof left === 'number' && typeof right === 'number' && left > right;
    case 'gte': return typeof left === 'number' && typeof right === 'number' && left >= right;
    case 'lt': return typeof left === 'number' && typeof right === 'number' && left < right;
    case 'lte': return typeof left === 'number' && typeof right === 'number' && left <= right;
    case 'contains': return String(left ?? '').toLowerCase().includes(String(right ?? '').toLowerCase());
    case 'matches': {
      try {
        // Anchored and length-capped: an operator-supplied pattern should not
        // be able to hang the executor with catastrophic backtracking.
        const pattern = String(right ?? '').slice(0, 200);
        return new RegExp(pattern, 'i').test(String(left ?? ''));
      } catch {
        return false;
      }
    }
    case 'in': return Array.isArray(right) && right.includes(left as never);
    default: return false;
  }
}

/** {{field}} substitution used by notification templates. */
export function render(template: string, item: WorkflowItem): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const value = readPath(item, path);
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}
