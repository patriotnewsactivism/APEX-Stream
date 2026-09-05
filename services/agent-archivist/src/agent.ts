import { Agent, startHealthServer, Store, type AgentContext } from '@apex/agent-runtime';
import { rootLogger, type AgentTask } from '@apex/core';
import { EvidenceVault } from './vault.js';

/**
 * Archivist — evidence custody.
 *
 * Everything Archivist writes is written once and cannot be deleted before its
 * retention date, by anyone, including the project owner. That constraint is
 * the whole point: evidence that an administrator can quietly remove is not
 * evidence, it is a copy. GCS Object Retention Lock in compliance mode
 * enforces it at the storage layer, and the API and RBAC layers refuse
 * deletion so the system never implies a capability the bucket would reject
 * anyway.
 *
 * Each capture produces a manifest recording what was fetched, when, from
 * where, by which agent, and the SHA-256 of the exact bytes stored. The
 * manifest hash is chained into the custody record, so a stored artefact can
 * later be shown to be byte-identical to what was captured.
 */
interface ArchivePayload {
  observationId?: string;
  anomalyId?: string;
  sourceId?: string;
  retentionDays?: number;
  includeMedia?: boolean;
  captureScreenshot?: boolean;
  includeAudio?: boolean;
  paddingSeconds?: number;
  mode?: 'beast' | 'scheduled';
  sourceTags?: string[];
  sweepUntil?: string;
}

export class Archivist extends Agent<ArchivePayload, { archived: number; bytes: number }> {
  private readonly store: Store;
  private readonly vault = new EvidenceVault();

  constructor(config: ConstructorParameters<typeof Agent>[0] & { store: Store }) {
    super(config);
    this.store = config.store;
  }

  protected override async handle(
    task: AgentTask<ArchivePayload>,
    ctx: AgentContext,
  ): Promise<{ archived: number; bytes: number }> {
    const p = task.payload;

    // Beast mode dispatches Archivist without a specific target: sweep any
    // anomaly that has been detected but never captured. This is the backstop
    // for evidence that would otherwise be lost when a source is edited or
    // taken down between detection and archival.
    const targets = p.observationId
      ? [{ observationId: p.observationId, anomalyId: p.anomalyId ?? null }]
      : await this.store.pendingArchival(200);

    let archived = 0;
    let bytes = 0;

    for (const target of targets) {
      await ctx.keepAlive();
      try {
        const observation = await this.store.getObservation(target.observationId);
        if (!observation) continue;

        const record = await this.vault.capture({
          observation,
          anomalyId: target.anomalyId,
          capturedBy: 'archivist',
          retentionDays: p.retentionDays ?? 365,
          includeMedia: p.includeMedia ?? true,
          captureScreenshot: p.captureScreenshot ?? false,
        });

        await this.store.saveEvidence(record);
        archived++;
        bytes += record.bytes;

        await ctx.events.publish('evidence.archived', 'archivist', {
          evidenceId: record.id,
          observationId: record.observationId,
          anomalyId: record.anomalyId,
          sha256: record.sha256,
          bytes: record.bytes,
          retainUntil: record.retainUntil,
          runId: task.runId,
        });

        ctx.log.info('evidence archived', {
          evidenceId: record.id, sha256: record.sha256.slice(0, 16), bytes: record.bytes, retainUntil: record.retainUntil,
        });
      } catch (err) {
        ctx.log.error('archival failed', { observationId: target.observationId, error: err });
        throw err; // let the runtime decide retry vs DLQ
      }
    }

    return { archived, bytes };
  }
}
