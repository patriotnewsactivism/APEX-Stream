/**
 * APEX Stream — shared domain types.
 *
 * These types are the contract between the orchestrator, the agents, the
 * workflow engine and the dashboard. Changing anything here is a breaking
 * change across the fleet, so treat this file as a versioned API.
 */

/** Canonical agent identifiers. Adding an agent means adding it here first. */
export const AGENT_IDS = ['aria', 'atlas', 'sentinel', 'archivist', 'warden'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** Orchestrator is not an agent — it is the control plane that commands them. */
export type ActorId = AgentId | 'orchestrator' | 'operator' | 'system';

export type AgentState =
  | 'offline'
  | 'starting'
  | 'idle'
  | 'working'
  | 'throttled'
  | 'degraded'
  | 'stopping'
  | 'error';

export interface AgentDescriptor {
  id: AgentId;
  displayName: string;
  role: string;
  /** Permission scopes this agent may ever hold. Enforced at IAM and app layer. */
  scopes: string[];
  /** Queue this agent consumes from. One queue per agent — no shared inbox. */
  queueName: string;
  /** Isolated memory namespace. Agents cannot read each other's memory. */
  memoryNamespace: string;
  /** Hard ceiling on concurrent tasks for this agent, even in Beast mode. */
  maxConcurrency: number;
  /** Rough cost per task-minute in USD, used for budget projection. */
  costPerTaskMinuteUsd: number;
}

export interface AgentHeartbeat {
  agentId: AgentId;
  instanceId: string;
  state: AgentState;
  activeTasks: number;
  queueDepth: number;
  lastTaskAt: string | null;
  version: string;
  emittedAt: string;
}

// ---------------------------------------------------------------------------
// Sources and observations
// ---------------------------------------------------------------------------

export const SOURCE_KINDS = [
  'rss',
  'http_api',
  'web_page',
  'social',
  'court_docket',
  'live_stream',
  'upload',
  'youtube_live_chat',
  'youtube_video',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface MonitoredSource {
  id: string;
  kind: SourceKind;
  label: string;
  url: string;
  /** Poll interval in seconds. Live streams use 0 (continuous). */
  intervalSeconds: number;
  enabled: boolean;
  /** Agent that owns collection for this source. */
  ownerAgent: AgentId;
  /** Free-form tags used by workflow filters and dashboard grouping. */
  tags: string[];
  /** Operator-declared trust weight 0..1, feeds the source-authority signal. */
  authority: number;
  createdAt: string;
  updatedAt: string;
}

/** A single unit of collected content, before scoring. */
export interface Observation {
  id: string;
  sourceId: string;
  collectedBy: AgentId;
  collectedAt: string;
  /** Publication or utterance time when the source provides one. */
  occurredAt: string | null;
  title: string | null;
  content: string;
  contentHash: string;
  url: string | null;
  mediaRefs: MediaRef[];
  metadata: Record<string, unknown>;
}

export interface MediaRef {
  kind: 'image' | 'audio' | 'video' | 'document';
  s3Key: string;
  bytes: number;
  sha256: string;
  durationSeconds?: number;
  transcriptS3Key?: string;
}

// ---------------------------------------------------------------------------
// Tasks and messaging
// ---------------------------------------------------------------------------

export type TaskKind =
  | 'collect'
  | 'analyze'
  | 'score'
  | 'archive'
  | 'transcribe'
  | 'diff'
  | 'notify'
  | 'workflow_step';

export interface AgentTask<TPayload = unknown> {
  taskId: string;
  runId: string;
  kind: TaskKind;
  targetAgent: AgentId;
  issuedBy: ActorId;
  issuedAt: string;
  /** Lower number runs first when the agent drains its queue. */
  priority: number;
  /** Task is dropped if picked up after this instant. Prevents zombie work. */
  expiresAt: string;
  attempt: number;
  maxAttempts: number;
  payload: TPayload;
  /** Correlation id threaded through logs, audit entries and evidence. */
  traceId: string;
}

export interface TaskResult<TOutput = unknown> {
  taskId: string;
  runId: string;
  agentId: AgentId;
  status: 'succeeded' | 'failed' | 'skipped' | 'expired';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  output?: TOutput;
  error?: { code: string; message: string; retryable: boolean };
  /** Estimated USD cost of this task, accumulated into run budgets. */
  estimatedCostUsd: number;
}

// ---------------------------------------------------------------------------
// Runs and Beast mode
// ---------------------------------------------------------------------------

export type RunMode = 'single_agent' | 'workflow' | 'beast';
export type RunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'budget_halted'
  | 'expired';

export interface Run {
  id: string;
  mode: RunMode;
  status: RunStatus;
  initiatedBy: string;
  participatingAgents: AgentId[];
  workflowId: string | null;
  startedAt: string;
  endedAt: string | null;
  /** Hard stop. Beast mode always sets this. */
  expiresAt: string;
  budget: RunBudget;
  stats: RunStats;
}

export interface RunBudget {
  /** Run halts when accrued cost crosses this. Non-negotiable safety rail. */
  maxCostUsd: number;
  accruedCostUsd: number;
  maxTasks: number;
  dispatchedTasks: number;
  /** Fleet-wide concurrent task ceiling for this run. */
  maxConcurrentTasks: number;
}

export interface RunStats {
  observations: number;
  anomalies: number;
  criticalAnomalies: number;
  evidenceArchived: number;
  notificationsSent: number;
  failures: number;
}

// ---------------------------------------------------------------------------
// Anomalies, evidence, notifications
// ---------------------------------------------------------------------------

export type AnomalyBand = 'info' | 'notice' | 'elevated' | 'critical';

export interface Anomaly {
  id: string;
  runId: string;
  observationId: string;
  sourceId: string;
  detectedBy: AgentId;
  detectedAt: string;
  score: number;
  band: AnomalyBand;
  confidence: number;
  summary: string;
  /** Full transparent breakdown. Never store a score without its components. */
  scoringProfileId: string;
  scoringProfileVersion: string;
  components: ScoreComponentRecord[];
  evidenceIds: string[];
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
}

export interface ScoreComponentRecord {
  signalId: string;
  label: string;
  raw: number;
  normalized: number;
  weight: number;
  contribution: number;
  included: boolean;
  evidence: string | null;
}

export interface EvidenceRecord {
  id: string;
  anomalyId: string | null;
  observationId: string;
  capturedBy: AgentId;
  capturedAt: string;
  s3Bucket: string;
  s3Key: string;
  s3VersionId: string | null;
  sha256: string;
  bytes: number;
  contentType: string;
  /** ISO timestamp until which S3 Object Lock forbids deletion. */
  retainUntil: string;
  /** Hash-chained manifest linking capture context to the stored bytes. */
  manifestSha256: string;
  chainOfCustody: CustodyEvent[];
}

export interface CustodyEvent {
  at: string;
  actor: ActorId | string;
  action: 'captured' | 'hashed' | 'stored' | 'locked' | 'accessed' | 'exported' | 'verified';
  detail: string;
  entryHash: string;
}

export type NotificationChannel = 'email' | 'sms' | 'webhook' | 'dashboard';

export interface Notification {
  id: string;
  anomalyId: string | null;
  runId: string;
  channel: NotificationChannel;
  target: string;
  subject: string;
  body: string;
  sentAt: string | null;
  status: 'queued' | 'sent' | 'failed' | 'suppressed';
  suppressionReason?: string;
}
