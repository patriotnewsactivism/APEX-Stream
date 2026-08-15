import { Agent, startHealthServer, Store, zScore, type AgentContext } from '@apex/agent-runtime';
import {
  contentFingerprint,
  fingerprintSimilarity,
  rootLogger,
  scoreObservation,
  sha256,
  type AgentTask,
  type SignalObservation,
} from '@apex/core';
import { StreamSession, type TranscriptSegment } from './stream.js';

/**
 * Sentinel — live stream watch.
 *
 * The expensive agent, and the reason it runs on long-lived Fargate tasks
 * rather than Lambda: a stream watch is measured in hours, not the fifteen
 * minutes a Lambda gets. Sentinel holds the connection, buffers rolling audio,
 * transcribes in near real time, and scores each segment as it lands.
 *
 * Two cost controls are built in rather than bolted on, because a forgotten
 * stream watch is the most plausible way to burn a credit balance overnight:
 *  - every session has a hard `watchUntil` and stops itself;
 *  - transcription only runs while the stream is actually producing audio,
 *    so a dead feed costs the price of a socket, not the price of an ASR stream.
 */
interface SentinelPayload {
  mode?: 'beast' | 'scheduled';
  sourceId?: string;
  sourceTags?: string[];
  slot?: number;
  slotCount?: number;
  sweepUntil?: string;
  /** Segment length fed to scoring. Shorter = faster alerts, more cost. */
  segmentSeconds?: number;
}

export class Sentinel extends Agent<SentinelPayload, { segments: number; anomalies: number; streams: number }> {
  private readonly store: Store;

  constructor(config: ConstructorParameters<typeof Agent>[0] & { store: Store }) {
    super(config);
    this.store = config.store;
  }

  protected override async handle(
    task: AgentTask<SentinelPayload>,
    ctx: AgentContext,
  ): Promise<{ segments: number; anomalies: number; streams: number }> {
    const p = task.payload;
    const sources = await this.store.claimSources({
      ownerAgent: 'sentinel',
      sourceId: p.sourceId,
      tags: p.sourceTags ?? [],
      shard: p.slot ?? 0,
      shardCount: p.slotCount ?? 1,
    });
    if (sources.length === 0) return { segments: 0, anomalies: 0, streams: 0 };

    // One task watches one stream. Watching several in a single container makes
    // a single bad feed able to stall the others.
    const source = sources[0];
    if (!source) return { segments: 0, anomalies: 0, streams: 0 };

    const watchUntil = p.sweepUntil
      ? new Date(p.sweepUntil).getTime()
      : Date.now() + 30 * 60_000;

    ctx.log.info('sentinel watch starting', {
      sourceId: source.id, url: source.url, watchUntilIso: new Date(watchUntil).toISOString(),
    });

    const watchlist = await this.store.watchlistTerms();
    const session = new StreamSession({
      url: source.url,
      segmentSeconds: p.segmentSeconds ?? 30,
      watchUntil,
      log: ctx.log,
    });

    let segments = 0;
    let anomalies = 0;

    try {
      for await (const segment of session.segments()) {
        await ctx.keepAlive();
        segments++;
        const outcome = await this.scoreSegment(source, segment, watchlist, ctx, task.runId);
        if (outcome.band !== 'info') anomalies++;
      }
    } finally {
      await session.close();
      await this.store.markPolled(source.id, session.lastError);
    }

    ctx.log.info('sentinel watch finished', { sourceId: source.id, segments, anomalies });
    return { segments, anomalies, streams: 1 };
  }

  private async scoreSegment(
    source: { id: string; label: string; authority: number },
    segment: TranscriptSegment,
    watchlist: string[],
    ctx: AgentContext,
    runId: string,
  ): Promise<{ band: string }> {
    const signals: SignalObservation[] = [];

    if (watchlist.length > 0) {
      const hits = watchlist.filter((t) => segment.text.toLowerCase().includes(t.toLowerCase()));
      signals.push({
        signalId: 'watchlist_match',
        raw: hits.length,
        sampleSize: 1,
        evidence: hits.length ? `spoken: ${hits.slice(0, 5).join(', ')}` : 'no watchlist terms in this segment',
      });
    }

    // Speech-rate deviation: a sharp change in words per minute usually means
    // a handoff, a breaking-news cut-in, or an unscripted moment.
    const wordsPerMinute = (segment.text.split(/\s+/).filter(Boolean).length / Math.max(1, segment.durationSeconds)) * 60;
    const baseline = await ctx.memory.getBaseline(`wpm:${source.id}`);
    if (baseline && baseline.count >= 6) {
      const z = Math.abs(zScore(wordsPerMinute, baseline));
      signals.push({
        signalId: 'sentiment_shift',
        raw: z,
        sampleSize: baseline.count,
        evidence: `${wordsPerMinute.toFixed(0)} wpm vs a ${baseline.mean.toFixed(0)} wpm baseline (${z.toFixed(1)}σ)`,
      });
    }
    await ctx.memory.updateBaseline(`wpm:${source.id}`, wordsPerMinute);

    const recent = await this.store.recentFingerprints(source.id, 30);
    const fingerprint = contentFingerprint(segment.text);
    if (recent.length >= 3) {
      const closest = Math.max(...recent.map((f) => fingerprintSimilarity(fingerprint, f)));
      signals.push({
        signalId: 'content_novelty',
        raw: 1 - closest,
        sampleSize: recent.length,
        evidence: `${(closest * 100).toFixed(0)}% similar to recent coverage on this stream`,
      });
    }

    const result = scoreObservation(signals);
    const observationId = await this.store.saveObservation({
      sourceId: source.id,
      collectedBy: 'sentinel',
      title: `${source.label} — ${segment.startedAt}`,
      content: segment.text,
      contentHash: sha256(segment.text),
      fingerprint,
      url: null,
      occurredAt: segment.startedAt,
      metadata: {
        durationSeconds: segment.durationSeconds,
        wordsPerMinute: Math.round(wordsPerMinute),
        audioS3Key: segment.audioS3Key ?? null,
        confidence: segment.confidence,
      },
      signals,
    });

    if (result.band !== 'info' && observationId) {
      const anomalyId = await this.store.saveAnomaly({
        runId, observationId, sourceId: source.id, detectedBy: 'sentinel', result,
        summary: `${source.label} live: "${segment.text.slice(0, 120)}"`,
      });
      await ctx.events.publish('anomaly.detected', 'sentinel', {
        anomalyId, observationId, sourceId: source.id, runId,
        score: result.score, band: result.band, confidence: result.confidence,
        audioS3Key: segment.audioS3Key ?? null,
        requiresArchive: true,
      });
    }

    return { band: result.band };
  }
}
