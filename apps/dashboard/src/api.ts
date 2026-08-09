/**
 * API client.
 *
 * Every call carries the Cognito access token. A 401 clears the session and
 * bounces to sign-in rather than leaving the UI in a half-authenticated state
 * where some panels load and others silently fail.
 */

export interface ApiError extends Error {
  status: number;
  code?: string;
}

let accessToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

const BASE = import.meta.env.VITE_API_BASE ?? '';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  });

  if (res.status === 401) {
    onUnauthorized?.();
    const err = new Error('Your session expired. Sign in again.') as ApiError;
    err.status = 401;
    throw err;
  }

  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const detail = body as { message?: string; error?: string } | null;
    const err = new Error(detail?.message ?? `Request failed (${res.status})`) as ApiError;
    err.status = res.status;
    err.code = detail?.error;
    throw err;
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// Types mirrored from the orchestrator responses
// ---------------------------------------------------------------------------

export interface AgentStatus {
  id: string;
  displayName: string;
  role: string;
  state: string;
  activeTasks: number;
  maxConcurrency: number;
  version: string | null;
  lastHeartbeatAt: string | null;
  queue: { visible: number; inFlight: number };
  costPerTaskMinuteUsd: number;
}

export interface ScoreComponent {
  signalId: string;
  label: string;
  description: string;
  raw: number;
  normalized: number;
  declaredWeight: number;
  effectiveWeight: number;
  contribution: number;
  included: boolean;
  exclusionReason: string | null;
  evidence: string | null;
  method: string;
  sampleSize: number;
}

export interface Anomaly {
  id: string;
  source_id: string;
  source_label: string | null;
  detected_by: string;
  detected_at: string;
  score: string | number;
  band: 'info' | 'notice' | 'elevated' | 'critical';
  confidence: string | number;
  summary: string;
  components: ScoreComponent[];
  explanation: string;
  input_hash: string;
  scoring_profile_id: string;
  scoring_profile_version: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
}

export interface BeastPreflight {
  allowed: boolean;
  reason: string | null;
  agents: Array<{ agentId: string; sources: number; concurrency: number; projectedCostUsd: number }>;
  totalSources: number;
  projectedCostUsd: number;
  budgetUsd: number;
  durationMinutes: number;
  maxConcurrentTasks: number;
  warning: string | null;
}

export interface Run {
  id: string;
  mode: string;
  status: string;
  initiated_by?: string;
  initiatedBy?: string;
  started_at?: string;
  startedAt?: string;
  expires_at?: string;
  expiresAt?: string;
  budget: { maxCostUsd: number; accruedCostUsd: number; dispatchedTasks: number; maxConcurrentTasks: number };
}

export interface EvidenceItem {
  id: string;
  anomaly_id: string | null;
  captured_at: string;
  s3_key: string;
  sha256: string;
  bytes: number;
  retain_until: string;
  manifest_sha256: string;
  chain_of_custody: Array<{ at: string; actor: string; action: string; detail: string; entryHash: string }>;
}

export interface AuditEntry {
  sequence: number;
  recordedAt: string;
  actor: string;
  actorType: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  outcome: string;
  detail: Record<string, unknown>;
  entryHash: string;
}

export interface ChainVerification {
  valid: boolean;
  entriesChecked: number;
  brokenAtSequence: number | null;
  reason: string | null;
}

export const api = {
  me: () => request<{ principal: { username: string; roles: string[] } | null }>('/api/me'),
  agents: () => request<AgentStatus[]>('/api/agents'),
  anomalies: (params: { band?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.band) q.set('band', params.band);
    q.set('limit', String(params.limit ?? 50));
    return request<Anomaly[]>(`/api/anomalies?${q}`);
  },
  acknowledgeAnomaly: (id: string) => request<Anomaly>(`/api/anomalies/${id}/acknowledge`, { method: 'POST' }),
  beastPreflight: (body: { durationMinutes: number; budgetUsd: number; sourceTags: string[] }) =>
    request<BeastPreflight>('/api/beast/preflight', { method: 'POST', body: JSON.stringify(body) }),
  beastActivate: (body: { durationMinutes: number; budgetUsd: number; sourceTags: string[] }) =>
    request<{ run: Run; dispatched: number }>('/api/beast/activate', { method: 'POST', body: JSON.stringify(body) }),
  beastDeactivate: (runId: string) => request<Run>(`/api/beast/deactivate/${runId}`, { method: 'POST' }),
  activeBeastRun: () => request<{ run: Run | null }>('/api/beast/active'),
  evidence: (limit = 50) => request<EvidenceItem[]>(`/api/evidence?limit=${limit}`),
  audit: (from = 0, limit = 200) => request<AuditEntry[]>(`/api/audit?from=${from}&limit=${limit}`),
  verifyAudit: (from = 0) => request<ChainVerification>(`/api/audit/verify?from=${from}`),
  workflows: () => request<Array<{ id: string; name: string; status: string; definition: unknown }>>('/api/workflows'),
  workflowTemplates: () => request<unknown[]>('/api/workflows/templates'),
  validateWorkflow: (workflow: unknown) =>
    request<{ valid: boolean; issues: Array<{ severity: string; code: string; message: string; nodeId?: string }> }>(
      '/api/workflows/validate',
      { method: 'POST', body: JSON.stringify(workflow) },
    ),
  saveWorkflow: (workflow: unknown) =>
    request<{ workflow: unknown; issues: unknown[] }>('/api/workflows', { method: 'POST', body: JSON.stringify(workflow) }),
  executeWorkflow: (id: string, dryRun: boolean) =>
    request<{ status: string; steps: Array<{ label: string; type: string; status: string; itemsIn: number; itemsOut: number; detail: Record<string, unknown> }>; estimatedCostUsd: number; haltReason: string | null }>(
      `/api/workflows/${id}/execute`,
      { method: 'POST', body: JSON.stringify({ dryRun }) },
    ),
};
