import { Agent, startHealthServer, zScore, type AgentContext } from '@apex/agent-runtime';
import {
  contentFingerprint,
  fingerprintSimilarity,
  scoreObservation,
  sha256,
  type AgentTask,
  rootLogger,
  type SignalObservation,
} from '@apex/core';
import { Store } from '@apex/agent-runtime';
import { fetchFeed, type FeedItem } from './feed.js';

/**
 * Aria — narrative and text intelligence.
 *
 * Pulls RSS, JSON APIs, press-release wires and docket feeds, then measures
 * each item against what this source normally does. Aria's job is not to
 * decide what matters; it is to produce honest signal values and let the
 * scoring engine and the operator decide.
 */
interface CollectPayload {
  mode?: 'beast' | 'scheduled';
  sourceId?: string;
  sourceTags?: string[];
  slot?: number;
  slotCount?: number;
  sweepUntil?: string;
}

class Aria extends Agent<CollectPayload, { observations: number; anomalies: number }> {
  private readonly store = new Store();

  protected override async handle(
    task: AgentTask<CollectPayload>,
    ctx: AgentContext,
  ): Promise<{ observations: number; anomalies: number }> {
    const payload = task.payload;
    const sources = await this.store.claimSources({
      ownerAgent: 'aria',
      sourceId: payload.sourceId,
      tags: payload.sourceTags ?? [],
      // In Beast mode several Aria tasks run in parallel; sharding by slot
      // keeps them off each other's sources instead of racing on the same feed.
      shard: payload.slot ?? 0,
      shardCount: payload.slotCount ?? 1,
    });

    ctx.log.info('aria sweep starting', { sources: sources.length, mode: payload.mode ?? 'scheduled' });

    let observations = 0;
    let anomalies = 0;
    const sweepUntil = payload.sweepUntil ? new Date(payload.sweepUntil).getTime() : 0;

    do {
      for (const source of sources) {
        await ctx.keepAlive();
        try {
          const items = await fetchFeed(source.url, source.kind);
          for (const item of items) {
            const stored = await this.ingest(source, item, ctx, task.runId);
            if (stored.isNew) observations++;
            if (stored.band !== 'info') anomalies++;
          }
          await this.store.markPolled(source.id, null);
        } catch (err) {
          ctx.log.warn('source fetch failed', { sourceId: source.id, url: source.url, error: err });
          await this.store.markPolled(source.id, err instanceof Error ? err.message : String(err));
        }
      }
      // Beast mode: keep sweeping until the run window closes.
      if (sweepUntil > Date.now()) await new Promise((r) => setTimeout(r, 30_000));
    } while (sweepUntil > Date.now());

    return { observations, anomalies };
  }

  private async ingest(
    source: { id: string; label: string; authority: number },
    item: FeedItem,
    ctx: AgentContext,
    runId: string,
  ): Promise<{ isNew: boolean; band: string }> {
    const contentHash = sha256(item.content);
    if (await this.store.observationExists(source.id, contentHash)) return { isNew: false, band: 'info' };

    const fingerprint = contentFingerprint(item.content);
    const signals: SignalObservation[] = [];

    // --- novelty against the last 50 items from this source ---
    const recent = await this.store.recentFingerprints(source.id, 50);
    if (recent.length > 0) {
      const closest = Math.max(...recent.map((f) => fingerprintSimilarity(fingerprint, f)));
      signals.push({
        signalId: 'content_novelty',
        raw: 1 - closest,
        sampleSize: recent.length,
        evidence: `closest of ${recent.length} recent items was ${(closest * 100).toFixed(0)}% similar`,
      });
    }

    // --- publication velocity against this source's own baseline ---
    const perHour = await this.store.itemsInLastHour(source.id);
    const baseline = await ctx.memory.getBaseline(`velocity:${source.id}`);
    const z = zScore(perHour, baseline);
    if (baseline && baseline.count >= 8) {
      signals.push({
        signalId: 'velocity_burst',
        raw: z,
        sampleSize: baseline.count,
        evidence: `${perHour} items this hour vs a ${baseline.mean.toFixed(1)} average (${z.toFixed(1)}σ)`,
      });
    }
    await ctx.memory.updateBaseline(`velocity:${source.id}`, perHour);

    // --- watchlist density ---
    const watchlist = await this.store.watchlistTerms();
    const hits = watchlist.filter((term) => item.content.toLowerCase().includes(term.toLowerCase()));
    if (watchlist.length > 0) {
      signals.push({
        signalId: 'watchlist_match',
        raw: hits.length,
        sampleSize: 1,
        evidence: hits.length ? `matched: ${hits.slice(0, 5).join(', ')}` : 'no watchlist terms present',
      });
    }

    // --- off-cycle publishing ---
    const hourHistogram = await ctx.memory.get<number[]>('episodic', `hours:${source.id}`);
    const publishedHour = new Date(item.publishedAt ?? Date.now()).getUTCHours();
    if (hourHistogram && hourHistogram.reduce((a, b) => a + b, 0) >= 10) {
      const total = hourHistogram.reduce((a, b) => a + b, 0);
      const share = (hourHistogram[publishedHour] ?? 0) / total;
      signals.push({
        signalId: 'temporal_anomaly',
        raw: Math.max(0, 1 - share * 24),
        sampleSize: total,
        evidence: `${(share * 100).toFixed(1)}% of this source's items normally publish in hour ${publishedHour}Z`,
      });
    }
    const nextHistogram = hourHistogram ?? new Array<number>(24).fill(0);
    nextHistogram[publishedHour] = (nextHistogram[publishedHour] ?? 0) + 1;
    await ctx.memory.put('episodic', `hours:${source.id}`, nextHistogram);

    const result = scoreObservation(signals);
    const observationId = await this.store.saveObservation({
      sourceId: source.id,
      collectedBy: 'aria',
      title: item.title,
      content: item.content,
      contentHash,
      fingerprint,
      url: item.url,
      occurredAt: item.publishedAt,
      metadata: { authorityWeight: source.authority },
      signals,
    });

    if (result.band !== 'info') {
      const anomalyId = await this.store.saveAnomaly({
        runId,
        observationId,
        sourceId: source.id,
        detectedBy: 'aria',
        result,
        summary: `${source.label}: ${item.title ?? 'untitled item'}`,
      });
      await ctx.events.publish('anomaly.detected', 'aria', {
        anomalyId, observationId, sourceId: source.id, runId,
        score: result.score, band: result.band, confidence: result.confidence,
        topDrivers: result.topDrivers.map((d) => ({ label: d.label, contribution: d.contribution })),
      });
      ctx.log.info('anomaly detected', { anomalyId, score: result.score, band: result.band });
    }

    await ctx.events.publish('observation.collected', 'aria', { observationId, sourceId: source.id, runId, band: result.band });
    return { isNew: true, band: result.band };
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

const log = rootLogger.child({ service: 'agent-aria', agentId: 'aria' });

const agent = new Aria({
  agentId: 'aria',
  queueUrl: required('QUEUE_URL'),
  memoryTableName: required('MEMORY_TABLE'),
  eventBusName: required('EVENT_BUS_NAME'),
});

startHealthServer(Number(process.env.PORT ?? 8080), log, () => ({ healthy: true, detail: { agent: 'aria' } }));

void agent.start();
