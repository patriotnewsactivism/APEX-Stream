import { randomUUID } from 'node:crypto';
import type { WorkflowEffects, WorkflowItem } from '@apex/workflow-engine';
import { AGENT_REGISTRY, type AgentId, type SignalObservation } from '@apex/core';
import type { Config } from './config.js';
import type { Database } from './db.js';
import type { Dispatcher } from './dispatcher.js';

/**
 * Binds the pure workflow executor to real infrastructure.
 *
 * Kept separate from the executor so workflows can be unit-tested and dry-run
 * against production data without any side effects.
 */
export function buildEffects(deps: { config: Config; db: Database; dispatcher: Dispatcher }): WorkflowEffects {
  const { db, dispatcher } = deps;

  return {
    async fetchSources(sourceIds, tagSelector, maxItems) {
      const rows = await db.query<Record<string, unknown>>(
        `SELECT o.*, s.label AS source_label, s.authority, s.tags
           FROM observations o JOIN sources s ON s.id = o.source_id
          WHERE s.enabled = true
            AND (cardinality($1::uuid[]) = 0 OR s.id = ANY($1::uuid[]))
            AND (cardinality($2::text[]) = 0 OR s.tags && $2::text[])
            AND o.collected_at > now() - interval '24 hours'
          ORDER BY o.collected_at DESC LIMIT $3`,
        [sourceIds, tagSelector, maxItems],
      );
      return rows.map((r) => ({
        id: r.id,
        sourceId: r.source_id,
        sourceLabel: r.source_label,
        title: r.title,
        content: r.content,
        contentHash: r.content_hash,
        url: r.url,
        authority: r.authority,
        collectedAt: r.collected_at,
        metadata: r.metadata,
      })) as WorkflowItem[];
    },

    async collectSignals(item, disabledSignals) {
      const rows = await db.query<{ signal_id: string; raw: string; sample_size: number; evidence: string | null }>(
        `SELECT signal_id, raw, sample_size, evidence FROM observation_signals WHERE observation_id = $1`,
        [item.id],
      );
      return rows
        .filter((r) => !disabledSignals.includes(r.signal_id))
        .map<SignalObservation>((r) => ({
          signalId: r.signal_id,
          raw: Number(r.raw),
          sampleSize: r.sample_size,
          evidence: r.evidence ?? undefined,
        }));
    },

    async dispatchAgentTask(input) {
      const agent = input.agent as AgentId;
      const descriptor = AGENT_REGISTRY[agent];
      const task = await dispatcher.dispatch({
        agent,
        kind: input.kind as never,
        runId: String(input.item.runId ?? randomUUID()),
        issuedBy: 'orchestrator',
        priority: input.priority,
        ttlSeconds: input.timeoutSeconds,
        payload: { ...input.params, observationId: input.item.id, sourceId: input.item.sourceId },
      });
      // Projection only; the real figure comes back on the task result.
      const estimatedCostUsd = Number(((input.timeoutSeconds / 60) * (descriptor?.costPerTaskMinuteUsd ?? 0.001) * 0.3).toFixed(6));
      return { taskId: task.taskId, estimatedCostUsd };
    },

    async archive(item, options) {
      const task = await dispatcher.dispatch({
        agent: 'archivist',
        kind: 'archive',
        runId: String(item.runId ?? randomUUID()),
        issuedBy: 'orchestrator',
        priority: 2,
        ttlSeconds: 1800,
        payload: {
          observationId: item.id,
          sourceId: item.sourceId,
          retentionDays: options.retentionDays,
          includeMedia: options.includeMedia,
          captureScreenshot: options.captureScreenshot,
        },
      });
      return { evidenceId: task.taskId };
    },

    async notify(input) {
      // Deduplication is checked before enqueueing rather than at send time so
      // a burst on one source cannot produce a hundred queued messages that a
      // downstream filter then has to discard.
      if (input.dedupeWindowMinutes > 0) {
        const recent = await db.one<{ id: string }>(
          `SELECT id FROM notifications
            WHERE dedupe_key = $1 AND sent_at > now() - ($2 || ' minutes')::interval
            LIMIT 1`,
          [input.dedupeKey, String(input.dedupeWindowMinutes)],
        );
        if (recent) {
          await db.query(
            `INSERT INTO notifications (id, channel, target, subject, body, dedupe_key, status, suppression_reason)
             VALUES ($1,$2,$3,$4,$5,$6,'suppressed','duplicate within dedupe window')`,
            [randomUUID(), input.channel, input.target, input.subject, input.body, input.dedupeKey],
          );
          return { sent: false, suppressed: true };
        }
      }

      await db.query(
        `INSERT INTO notifications (id, channel, target, subject, body, dedupe_key, status, sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,'queued', now())`,
        [randomUUID(), input.channel, input.target, input.subject, input.body, input.dedupeKey],
      );
      return { sent: true, suppressed: false };
    },
  };
}
