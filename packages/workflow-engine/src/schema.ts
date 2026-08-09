import { z } from 'zod';
import { AGENT_IDS } from '@apex/core';

/**
 * The workflow DSL.
 *
 * This is the contract between the drag-and-drop canvas in the dashboard and
 * the executor that runs in the orchestrator. The canvas emits exactly this
 * JSON — there is no second, hand-written format — so what an operator sees on
 * screen is what actually executes.
 *
 * Node config is a discriminated union on `type`, which means adding a node
 * type is a single change here and the validator, executor and UI all pick it
 * up from the same definition.
 */

export const NODE_TYPES = [
  'trigger',
  'source',
  'filter',
  'score',
  'branch',
  'agent_task',
  'archive',
  'notify',
  'delay',
  'transform',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

const position = z.object({ x: z.number(), y: z.number() });

const triggerConfig = z.object({
  type: z.literal('trigger'),
  mode: z.enum(['manual', 'schedule', 'event']),
  /** cron or rate expression when mode = schedule */
  schedule: z.string().optional(),
  /** EventBridge detail-type when mode = event */
  eventType: z.string().optional(),
});

const sourceConfig = z.object({
  type: z.literal('source'),
  /** Explicit source ids, or a tag selector to match many. */
  sourceIds: z.array(z.string()).default([]),
  tagSelector: z.array(z.string()).default([]),
  maxItems: z.number().int().min(1).max(500).default(50),
});

const comparators = z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'matches', 'in']);

const filterConfig = z.object({
  type: z.literal('filter'),
  /** All conditions must pass (AND). Use two filters in parallel for OR. */
  conditions: z
    .array(
      z.object({
        field: z.string().min(1),
        op: comparators,
        value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
      }),
    )
    .min(1),
});

const scoreConfig = z.object({
  type: z.literal('score'),
  profileId: z.string().default('apex.default'),
  /** Signals to skip for this workflow, e.g. suppress watchlist on a feed. */
  disabledSignals: z.array(z.string()).default([]),
});

const branchConfig = z.object({
  type: z.literal('branch'),
  /** Evaluated top to bottom; first match wins. `edgeLabel` selects the edge. */
  cases: z
    .array(
      z.object({
        label: z.string().min(1),
        field: z.string().min(1),
        op: comparators,
        value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
      }),
    )
    .min(1),
  defaultLabel: z.string().default('else'),
});

const agentTaskConfig = z.object({
  type: z.literal('agent_task'),
  agent: z.enum(AGENT_IDS),
  kind: z.enum(['collect', 'analyze', 'score', 'archive', 'transcribe', 'diff', 'notify']),
  priority: z.number().int().min(0).max(9).default(5),
  timeoutSeconds: z.number().int().min(5).max(3600).default(300),
  params: z.record(z.unknown()).default({}),
});

const archiveConfig = z.object({
  type: z.literal('archive'),
  /** Object Lock retention. Cannot be shortened once written. */
  retentionDays: z.number().int().min(1).max(3650).default(365),
  includeMedia: z.boolean().default(true),
  captureScreenshot: z.boolean().default(false),
});

const notifyConfig = z.object({
  type: z.literal('notify'),
  channel: z.enum(['email', 'sms', 'webhook', 'dashboard']),
  target: z.string().min(1),
  subjectTemplate: z.string().default('APEX Stream: {{band}} anomaly on {{sourceLabel}}'),
  bodyTemplate: z.string().default('Score {{score}}/100. {{explanation}}'),
  /** Suppress repeats for the same source within this window. */
  dedupeWindowMinutes: z.number().int().min(0).max(1440).default(30),
});

const delayConfig = z.object({
  type: z.literal('delay'),
  seconds: z.number().int().min(1).max(3600),
});

const transformConfig = z.object({
  type: z.literal('transform'),
  /** target field -> source path or literal, e.g. { title: "$.item.headline" } */
  mappings: z.record(z.string()),
});

export const nodeConfigSchema = z.discriminatedUnion('type', [
  triggerConfig,
  sourceConfig,
  filterConfig,
  scoreConfig,
  branchConfig,
  agentTaskConfig,
  archiveConfig,
  notifyConfig,
  delayConfig,
  transformConfig,
]);

export const workflowNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(80),
  position,
  config: nodeConfigSchema,
});

export const workflowEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  /** Required on edges leaving a branch node — must match a case label. */
  label: z.string().optional(),
});

export const workflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).default(''),
  version: z.number().int().min(1).default(1),
  status: z.enum(['draft', 'published', 'disabled']).default('draft'),
  nodes: z.array(workflowNodeSchema).min(1),
  edges: z.array(workflowEdgeSchema).default([]),
  /** Safety rails applied to every execution of this workflow. */
  limits: z
    .object({
      maxNodesExecuted: z.number().int().min(1).max(500).default(100),
      maxDurationSeconds: z.number().int().min(10).max(21600).default(900),
      maxCostUsd: z.number().min(0.01).max(1000).default(5),
    })
    .default({ maxNodesExecuted: 100, maxDurationSeconds: 900, maxCostUsd: 5 }),
  createdBy: z.string().default('system'),
  createdAt: z.string().default(() => new Date().toISOString()),
  updatedAt: z.string().default(() => new Date().toISOString()),
});

export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;
export type Workflow = z.infer<typeof workflowSchema>;
export type NodeConfig = z.infer<typeof nodeConfigSchema>;
export type Comparator = z.infer<typeof comparators>;
