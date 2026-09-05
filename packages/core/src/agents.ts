import type { AgentDescriptor, AgentId } from './types.js';
import { AGENT_SCOPES } from './security/rbac.js';

/**
 * The fleet roster. Each agent owns its own queue, its own memory namespace
 * and its own IAM role — nothing is shared, so a compromised or misbehaving
 * agent cannot read another's state or drain another's work.
 *
 * `costPerTaskMinuteUsd` figures were calibrated against Fargate Spot pricing
 * and are carried over unchanged now that compute has moved to Cloud Run Jobs
 * -- Cloud Run's per-vCPU-second/per-GiB-second pricing (no spot/on-demand
 * split) doesn't map cleanly onto these, so treat them as directional only
 * until they're recalculated. Used only for budget projection, not billing.
 */
export const AGENT_REGISTRY: Record<AgentId, AgentDescriptor> = {
  aria: {
    id: 'aria',
    displayName: 'Aria',
    role: 'Narrative and text intelligence — RSS, news APIs, press releases, dockets',
    scopes: AGENT_SCOPES.aria ?? [],
    queueName: 'aria-tasks',
    memoryNamespace: 'mem:aria',
    maxConcurrency: 12,
    costPerTaskMinuteUsd: 0.0012,
  },
  atlas: {
    id: 'atlas',
    displayName: 'Atlas',
    role: 'Web and social surface mapping — page diffing, silent-edit detection, spread analysis',
    scopes: AGENT_SCOPES.atlas ?? [],
    queueName: 'atlas-tasks',
    memoryNamespace: 'mem:atlas',
    maxConcurrency: 10,
    costPerTaskMinuteUsd: 0.0018,
  },
  sentinel: {
    id: 'sentinel',
    displayName: 'Sentinel',
    role: 'Live stream watch — continuous audio/video capture, transcription, real-time scoring',
    scopes: AGENT_SCOPES.sentinel ?? [],
    queueName: 'sentinel-tasks',
    memoryNamespace: 'mem:sentinel',
    maxConcurrency: 4,
    costPerTaskMinuteUsd: 0.0095,
  },
  archivist: {
    id: 'archivist',
    displayName: 'Archivist',
    role: 'Evidence custody — hashing, write-once archival, chain of custody, export packages',
    scopes: AGENT_SCOPES.archivist ?? [],
    queueName: 'archivist-tasks',
    memoryNamespace: 'mem:archivist',
    maxConcurrency: 8,
    costPerTaskMinuteUsd: 0.0009,
  },
  // Warden is the only agent that reads a channel the operator owns rather
  // than a third party's public surface, and the only one whose output is
  // addressed to a human for a decision rather than filed as a finding. It
  // still cannot act: posting and moderating are orchestrator operations
  // gated on an explicit human approval.
  warden: {
    id: 'warden',
    displayName: 'Warden',
    role: 'Community watch — live chat and comment ingestion, hostility classification, drafted replies',
    scopes: AGENT_SCOPES.warden ?? [],
    queueName: 'warden-tasks',
    memoryNamespace: 'mem:warden',
    maxConcurrency: 6,
    // Higher than the text agents: every comment costs a model invocation.
    costPerTaskMinuteUsd: 0.0034,
  },
};

export function getAgent(id: AgentId): AgentDescriptor {
  const agent = AGENT_REGISTRY[id];
  if (!agent) throw new Error(`unknown agent: ${id}`);
  return agent;
}

/** Fleet-wide concurrency if every agent ran at its individual ceiling. */
export const FLEET_MAX_CONCURRENCY = Object.values(AGENT_REGISTRY).reduce(
  (sum, a) => sum + a.maxConcurrency,
  0,
);
