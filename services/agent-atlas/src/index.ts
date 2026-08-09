import { Agent, startHealthServer, type AgentContext } from '@apex/agent-runtime';
import {
  contentFingerprint,
  fingerprintSimilarity,
  rootLogger,
  scoreObservation,
  sha256,
  type AgentTask,
  type SignalObservation,
} from '@apex/core';
import { Store } from '@apex/agent-runtime';
import { fetchPage, extractReadableText, hasCorrectionNotice } from './page.js';

/**
 * Atlas — web and social surface mapping.
 *
 * Atlas re-fetches watched pages and compares them with the last archived
 * copy. The signal it exists to produce is the silent edit: a page whose
 * substance changed with no correction notice, no new timestamp and no
 * announcement. Public records and news pages get quietly amended more often
 * than most people assume, and once the original is gone it is gone — which is
 * why a detected edit immediately hands off to Archivist rather than waiting
 * for an operator to notice.
 */
interface AtlasPayload {
  mode?: 'beast' | 'scheduled';
  sourceId?: string;
  sourceTags?: string[];
  slot?: number;
  slotCount?: number;
  sweepUntil?: string;
  compareTo?: string;
}

class Atlas extends Agent<AtlasPayload, { pages: number; changed: number }> {
  private readonly store = new Store();

  protected override async handle(
    task: AgentTask<AtlasPayload>,
    ctx: AgentContext,
  ): Promise<{ pages: number; changed: number }> {
    const p = task.payload;
    const sources = await this.store.claimSources({
      ownerAgent: 'atlas',
      sourceId: p.sourceId,
      tags: p.sourceTags ?? [],
      shard: p.slot ?? 0,
      shardCount: p.slotCount ?? 1,
    });

    let pages = 0;
    let changed = 0;
    const sweepUntil = p.sweepUntil ? new Date(p.sweepUntil).getTime() : 0;

    do {
      for (const source of sources) {
        await ctx.keepAlive();
        try {
          const raw = await fetchPage(source.url);
          const text = extractReadableText(raw.html);
          if (!text) {
            await this.store.markPolled(source.id, 'no readable content extracted');
            continue;
          }
          pages++;

          const fingerprint = contentFingerprint(text);
          const previous = await this.store.latestFingerprint(source.id, source.url);
          const signals: SignalObservation[] = [];
          let similarity = 1;

          if (previous) {
            similarity = fingerprintSimilarity(fingerprint, previous.fingerprint);
            const corrected = hasCorrectionNotice(text);
            // A change that is announced is normal editorial practice; a change
            // that is not announced is the thing worth flagging.
            const silentEditScore = similarity >= 0.995 ? 0 : corrected ? 0.15 : Math.min(1, (1 - similarity) * 4);
            signals.push({
              signalId: 'silent_edit',
              raw: silentEditScore,
              sampleSize: 1,
              evidence: corrected
                ? `page changed (${((1 - similarity) * 100).toFixed(1)}% of content) and carries a correction notice`
                : `page changed (${((1 - similarity) * 100).toFixed(1)}% of content) with no correction notice`,
            });
            signals.push({
              signalId: 'content_novelty',
              raw: 1 - similarity,
              sampleSize: 1,
              evidence: `${(similarity * 100).toFixed(1)}% identical to the archived copy`,
            });
          }

          const watchlist = await this.store.watchlistTerms();
          if (watchlist.length) {
            const hits = watchlist.filter((t) => text.toLowerCase().includes(t.toLowerCase()));
            signals.push({
              signalId: 'watchlist_match',
              raw: hits.length,
              sampleSize: 1,
              evidence: hits.length ? `matched: ${hits.slice(0, 5).join(', ')}` : 'no watchlist terms present',
            });
          }

          const result = scoreObservation(signals);
          const observationId = await this.store.saveObservation({
            sourceId: source.id,
            collectedBy: 'atlas',
            title: raw.title,
            content: text,
            contentHash: sha256(text),
            fingerprint,
            url: source.url,
            occurredAt: null,
            metadata: { similarity, etag: raw.etag, lastModified: raw.lastModified, status: raw.status },
            signals,
          });

          if (previous && similarity < 0.995) {
            changed++;
            const anomalyId = await this.store.saveAnomaly({
              runId: task.runId,
              observationId,
              sourceId: source.id,
              detectedBy: 'atlas',
              result,
              summary: `${source.label} changed (${((1 - similarity) * 100).toFixed(1)}% of content)`,
            });
            // Capture both versions before anything else can change again.
            await ctx.events.publish('anomaly.detected', 'atlas', {
              anomalyId, observationId, sourceId: source.id, runId: task.runId,
              score: result.score, band: result.band, similarity,
              previousObservationId: previous.observationId,
              requiresArchive: true,
            });
            ctx.log.info('page change detected', { sourceId: source.id, similarity, band: result.band });
          }

          await this.store.markPolled(source.id, null);
        } catch (err) {
          ctx.log.warn('page fetch failed', { sourceId: source.id, error: err });
          await this.store.markPolled(source.id, err instanceof Error ? err.message : String(err));
        }
      }
      if (sweepUntil > Date.now()) await new Promise((r) => setTimeout(r, 60_000));
    } while (sweepUntil > Date.now());

    return { pages, changed };
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

const log = rootLogger.child({ service: 'agent-atlas', agentId: 'atlas' });
const agent = new Atlas({
  agentId: 'atlas',
  queueUrl: required('QUEUE_URL'),
  memoryTableName: required('MEMORY_TABLE'),
  eventBusName: required('EVENT_BUS_NAME'),
});

startHealthServer(Number(process.env.PORT ?? 8080), log, () => ({ healthy: true, detail: { agent: 'atlas' } }));
void agent.start();
