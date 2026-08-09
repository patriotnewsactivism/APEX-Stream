import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Logger } from '@apex/core';

/**
 * Live stream session.
 *
 * Pulls an HLS/HTTP audio stream, buffers it into fixed-length segments, and
 * yields transcripts. Transcription is behind a small interface so the
 * deployment can choose Amazon Transcribe streaming, a self-hosted Whisper
 * container, or (in dev) a no-op — swapping providers must not require
 * touching capture or scoring.
 *
 * Segments are written to S3 before they are transcribed. If transcription
 * fails, the audio still exists and can be reprocessed; the reverse is not
 * recoverable, and for evidence work the audio is the artefact that matters.
 */

export interface TranscriptSegment {
  text: string;
  startedAt: string;
  durationSeconds: number;
  confidence: number;
  audioS3Key: string | null;
}

export interface Transcriber {
  transcribe(audio: Buffer, sampleRateHz: number): Promise<{ text: string; confidence: number }>;
}

export interface StreamSessionOptions {
  url: string;
  segmentSeconds: number;
  watchUntil: number;
  log: Logger;
  transcriber?: Transcriber;
  bucket?: string;
  s3?: S3Client;
}

/** Dev/default transcriber. Returns nothing rather than inventing text. */
class NullTranscriber implements Transcriber {
  async transcribe(): Promise<{ text: string; confidence: number }> {
    return { text: '', confidence: 0 };
  }
}

export class StreamSession {
  private controller: AbortController | null = null;
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly transcriber: Transcriber;
  lastError: string | null = null;

  constructor(private readonly options: StreamSessionOptions) {
    this.s3 = options.s3 ?? new S3Client({});
    this.bucket = options.bucket ?? process.env.EVIDENCE_BUCKET ?? '';
    this.transcriber = options.transcriber ?? new NullTranscriber();
  }

  /**
   * Yields one transcript per segment until the watch window closes or the
   * stream ends. Backs off and reconnects on transient stream failures rather
   * than ending the whole watch — live feeds drop constantly.
   */
  async *segments(): AsyncGenerator<TranscriptSegment> {
    const { url, segmentSeconds, watchUntil, log } = this.options;
    const targetBytes = segmentSeconds * 16_000 * 2; // 16 kHz, 16-bit mono
    let consecutiveFailures = 0;

    while (Date.now() < watchUntil) {
      this.controller = new AbortController();
      const timeToLive = watchUntil - Date.now();
      const timer = setTimeout(() => this.controller?.abort(), timeToLive);

      try {
        const res = await fetch(url, {
          signal: this.controller.signal,
          headers: { 'user-agent': 'APEX-Stream/1.0 (+monitoring)' },
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        consecutiveFailures = 0;

        let buffer: Buffer[] = [];
        let buffered = 0;
        let segmentStart = new Date();

        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          if (Date.now() >= watchUntil) break;
          buffer.push(Buffer.from(chunk));
          buffered += chunk.byteLength;
          if (buffered < targetBytes) continue;

          const audio = Buffer.concat(buffer);
          buffer = [];
          buffered = 0;
          const startedAt = segmentStart.toISOString();
          segmentStart = new Date();

          const audioS3Key = await this.persist(audio, startedAt).catch((err) => {
            log.warn('segment upload failed', { error: err });
            return null;
          });

          const { text, confidence } = await this.transcriber
            .transcribe(audio, 16_000)
            .catch((err) => {
              log.warn('transcription failed', { error: err });
              return { text: '', confidence: 0 };
            });

          if (text.trim()) {
            yield { text: text.trim(), startedAt, durationSeconds: segmentSeconds, confidence, audioS3Key };
          }
        }
      } catch (err) {
        if (this.controller?.signal.aborted && Date.now() >= watchUntil) return;
        consecutiveFailures++;
        this.lastError = err instanceof Error ? err.message : String(err);
        const backoff = Math.min(60_000, 2 ** consecutiveFailures * 1_000);
        log.warn('stream dropped, reconnecting', { error: err, backoffMs: backoff, attempt: consecutiveFailures });
        if (consecutiveFailures >= 8) {
          log.error('giving up on stream after repeated failures', { url });
          return;
        }
        await new Promise((r) => setTimeout(r, backoff));
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private async persist(audio: Buffer, startedAt: string): Promise<string | null> {
    if (!this.bucket) return null;
    const key = `streams/${startedAt.slice(0, 10)}/${randomUUID()}.pcm`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: audio,
        ContentType: 'audio/L16',
        ServerSideEncryption: 'aws:kms',
        Metadata: { capturedAt: startedAt, capturedBy: 'sentinel' },
      }),
    );
    return key;
  }

  async close(): Promise<void> {
    this.controller?.abort();
  }
}
