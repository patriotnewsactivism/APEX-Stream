import { randomUUID } from 'node:crypto';
import { Storage, type Bucket } from '@google-cloud/storage';
import { canonicalize, sha256, type CustodyEvent, type EvidenceRecord } from '@apex/core';

/**
 * Write-once evidence storage with a chain of custody.
 *
 * Ordering matters and is deliberate:
 *   1. hash the bytes            — before anything can touch them
 *   2. store the object          — CMEK-encrypted
 *   3. lock retention            — separate call; see the note on capture()
 *   4. store the manifest        — also locked, referencing the artefact generation
 *   5. record custody events     — each committing to the previous event's hash
 *
 * The manifest is written *after* the artefact so it can record the
 * generation number GCS assigned. A manifest that references a generation
 * that does not exist would be worse than no manifest at all.
 *
 * GCS's per-object retention lock (Object Retention Lock, distinct from
 * bucket-level Bucket Lock) is the closest equivalent to S3 Object Lock's
 * compliance mode: `retention.mode: 'Locked'` on an individual object
 * forbids deletion or overwrite before `retention.retainUntilTime`, and
 * once Locked it cannot be shortened or removed by anyone, including the
 * project owner. It is set via a metadata update rather than an upload
 * parameter, so it happens as an explicit second call after the object
 * exists — this repository has no live GCP project to verify the exact
 * request shape against; verify the retention lock actually takes effect
 * (`gcloud storage objects describe --format="value(retention)"`) before
 * relying on it in production.
 */
export interface ObservationInput {
  id: string;
  sourceId: string;
  url: string | null;
  title: string | null;
  content: string;
  contentHash: string;
  collectedAt: string;
  collectedBy: string;
  metadata: Record<string, unknown>;
}

export class EvidenceVault {
  private readonly bucket: Bucket;
  private readonly bucketName: string;
  private readonly kmsKeyName: string | undefined;

  constructor(bucketName = process.env.EVIDENCE_BUCKET, storage?: Storage, kmsKeyName = process.env.GCP_KMS_KEY_NAME) {
    if (!bucketName) throw new Error('EVIDENCE_BUCKET is required');
    this.bucketName = bucketName;
    this.bucket = (storage ?? new Storage()).bucket(bucketName);
    this.kmsKeyName = kmsKeyName;
  }

  async capture(input: {
    observation: ObservationInput;
    anomalyId: string | null;
    capturedBy: string;
    retentionDays: number;
    includeMedia: boolean;
    captureScreenshot: boolean;
  }): Promise<EvidenceRecord> {
    const { observation } = input;
    const evidenceId = randomUUID();
    const capturedAt = new Date().toISOString();
    const retainUntil = new Date(Date.now() + input.retentionDays * 86_400_000);
    const custody: CustodyEvent[] = [];

    const body = Buffer.from(observation.content, 'utf8');
    const digest = sha256(body);
    custody.push(this.custody(custody, capturedAt, input.capturedBy, 'captured', `fetched from ${observation.url ?? 'source ' + observation.sourceId}`));
    custody.push(this.custody(custody, capturedAt, input.capturedBy, 'hashed', `sha256=${digest}`));

    const key = `evidence/${capturedAt.slice(0, 10)}/${observation.sourceId}/${evidenceId}/content.txt`;
    const generation = await this.putLocked(key, body, retainUntil, 'text/plain; charset=utf-8', {
      evidenceid: evidenceId,
      observationid: observation.id,
      sourceid: observation.sourceId,
      capturedby: input.capturedBy,
      capturedat: capturedAt,
    });
    custody.push(this.custody(custody, new Date().toISOString(), input.capturedBy, 'stored', `gs://${this.bucketName}/${key} generation=${generation ?? 'n/a'}`));
    custody.push(this.custody(custody, new Date().toISOString(), 'system', 'locked', `retention locked until ${retainUntil.toISOString()}`));

    const manifest = {
      evidenceId,
      observationId: observation.id,
      anomalyId: input.anomalyId,
      sourceId: observation.sourceId,
      sourceUrl: observation.url,
      title: observation.title,
      capturedBy: input.capturedBy,
      capturedAt,
      collectedAt: observation.collectedAt,
      collectedBy: observation.collectedBy,
      artefact: {
        bucket: this.bucketName,
        key,
        generation,
        sha256: digest,
        bytes: body.byteLength,
        contentType: 'text/plain; charset=utf-8',
      },
      retention: { mode: 'Locked', retainUntil: retainUntil.toISOString(), days: input.retentionDays },
      observationMetadata: observation.metadata,
      custody,
      manifestVersion: 1,
    };

    const manifestBody = Buffer.from(canonicalize(manifest), 'utf8');
    const manifestSha = sha256(manifestBody);
    await this.putLocked(key.replace(/content\.txt$/, 'manifest.json'), manifestBody, retainUntil, 'application/json');

    return {
      id: evidenceId,
      anomalyId: input.anomalyId,
      observationId: observation.id,
      capturedBy: 'archivist',
      capturedAt,
      storageBucket: this.bucketName,
      storageKey: key,
      storageGeneration: generation,
      sha256: digest,
      bytes: body.byteLength,
      contentType: 'text/plain; charset=utf-8',
      retainUntil: retainUntil.toISOString(),
      manifestSha256: manifestSha,
      chainOfCustody: custody,
    };
  }

  /** Uploads an object CMEK-encrypted, then locks its retention. Returns the object generation. */
  private async putLocked(
    key: string,
    body: Buffer,
    retainUntil: Date,
    contentType: string,
    customMetadata?: Record<string, string>,
  ): Promise<string | null> {
    const file = this.bucket.file(key, { kmsKeyName: this.kmsKeyName });
    await file.save(body, {
      resumable: false,
      metadata: {
        contentType,
        ...(customMetadata ? { metadata: customMetadata } : {}),
      },
    });
    const [meta] = await file.setMetadata({
      retention: { mode: 'Locked', retainUntilTime: retainUntil.toISOString() },
    });
    return meta.generation ? String(meta.generation) : null;
  }

  /** Each custody event commits to the hash of the one before it. */
  private custody(
    prior: CustodyEvent[],
    at: string,
    actor: string,
    action: CustodyEvent['action'],
    detail: string,
  ): CustodyEvent {
    const previousHash = prior.length > 0 ? (prior[prior.length - 1]?.entryHash ?? '') : '0'.repeat(64);
    const entryHash = sha256(canonicalize({ at, actor, action, detail, previousHash }));
    return { at, actor, action, detail, entryHash };
  }
}
