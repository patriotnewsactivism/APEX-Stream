import { createHash } from 'node:crypto';
import type { ActorId } from '../types.js';

/**
 * Tamper-evident audit ledger.
 *
 * Each entry commits to the hash of the entry before it, so altering or
 * deleting any historical row invalidates every hash after it. This does not
 * make the log immutable — a determined admin with write access to the
 * database can rewrite the whole chain — but it makes silent, partial
 * tampering detectable, which is the realistic threat. For stronger
 * guarantees, `anchorDigest()` produces a digest to publish externally
 * (S3 Object Lock, a second account, or a public timestamp) on a schedule.
 */

export const GENESIS_HASH = '0'.repeat(64);

export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'run.started'
  | 'run.halted'
  | 'run.completed'
  | 'beast.activated'
  | 'beast.deactivated'
  | 'agent.dispatched'
  | 'agent.result'
  | 'anomaly.detected'
  | 'anomaly.acknowledged'
  | 'evidence.captured'
  | 'evidence.accessed'
  | 'evidence.exported'
  | 'evidence.delete_denied'
  | 'workflow.created'
  | 'workflow.published'
  | 'workflow.deleted'
  | 'source.created'
  | 'source.updated'
  | 'source.deleted'
  | 'rbac.role_granted'
  | 'rbac.role_revoked'
  | 'rbac.denied'
  | 'config.changed'
  | 'secret.rotated';

export interface AuditEntryInput {
  actor: ActorId | string;
  actorType: 'human' | 'agent' | 'system';
  action: AuditAction;
  resourceType: string;
  resourceId: string | null;
  /** Never put secrets or raw evidence content here. Identifiers only. */
  detail: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
  traceId?: string | null;
  outcome: 'allowed' | 'denied' | 'error';
}

export interface AuditEntry extends AuditEntryInput {
  sequence: number;
  recordedAt: string;
  prevHash: string;
  entryHash: string;
}

/** Deterministic JSON with sorted keys — the hash depends on it being stable. */
export function canonicalize(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(',')}}`;
}

export function computeEntryHash(
  entry: Omit<AuditEntry, 'entryHash'>,
): string {
  return createHash('sha256')
    .update(
      canonicalize({
        sequence: entry.sequence,
        recordedAt: entry.recordedAt,
        actor: entry.actor,
        actorType: entry.actorType,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        detail: entry.detail,
        outcome: entry.outcome,
        traceId: entry.traceId ?? null,
        prevHash: entry.prevHash,
      }),
    )
    .digest('hex');
}

export function sealEntry(
  input: AuditEntryInput,
  sequence: number,
  prevHash: string,
  now: Date = new Date(),
): AuditEntry {
  const partial: Omit<AuditEntry, 'entryHash'> = {
    ...input,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    traceId: input.traceId ?? null,
    sequence,
    recordedAt: now.toISOString(),
    prevHash,
  };
  return { ...partial, entryHash: computeEntryHash(partial) };
}

export interface ChainVerification {
  valid: boolean;
  entriesChecked: number;
  /** Sequence number of the first entry that failed, if any. */
  brokenAtSequence: number | null;
  reason: string | null;
}

export function verifyChain(entries: AuditEntry[]): ChainVerification {
  let expectedPrev = GENESIS_HASH;
  let expectedSeq: number | null = null;

  for (const entry of entries) {
    if (expectedSeq !== null && entry.sequence !== expectedSeq) {
      return {
        valid: false,
        entriesChecked: entry.sequence,
        brokenAtSequence: entry.sequence,
        reason: `sequence gap: expected ${expectedSeq}, found ${entry.sequence}`,
      };
    }
    if (entry.prevHash !== expectedPrev) {
      return {
        valid: false,
        entriesChecked: entry.sequence,
        brokenAtSequence: entry.sequence,
        reason: 'prevHash does not match the previous entry — a row was altered or removed',
      };
    }
    const recomputed = computeEntryHash(entry);
    if (recomputed !== entry.entryHash) {
      return {
        valid: false,
        entriesChecked: entry.sequence,
        brokenAtSequence: entry.sequence,
        reason: 'entry contents do not match the stored hash — this row was modified',
      };
    }
    expectedPrev = entry.entryHash;
    expectedSeq = entry.sequence + 1;
  }

  return { valid: true, entriesChecked: entries.length, brokenAtSequence: null, reason: null };
}

/**
 * Digest to publish outside the primary database so the chain head cannot be
 * quietly rewritten. Write this to the write-once evidence bucket hourly.
 */
export function anchorDigest(headHash: string, sequence: number, at: Date = new Date()): string {
  return createHash('sha256')
    .update(canonicalize({ headHash, sequence, at: at.toISOString() }))
    .digest('hex');
}
