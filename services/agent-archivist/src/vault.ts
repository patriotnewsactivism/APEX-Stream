import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { canonicalize, sha256, type CustodyEvent, type EvidenceRecord } from '@apex/core';

/**
 * Write-once evidence storage with a chain of custody.
 *
 * Ordering matters and is deliberate:
 *   1. hash the bytes            — before anything can touch them
 *   2. store under Object Lock   — retention set at write time, immutable after
 *   3. store the manifest        — also locked, referencing the artefact hash
 *   4. record custody events     — each committing to the previous event's hash
 *
 * The manifest is written *after* the artefact so it can record the version id
 * S3 assigned. A manifest that references a version that does not exist would
 * be worse than no manifest at all.
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
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(bucket = process.env.EVIDENCE_BUCKET, client?: S3Client) {
    if (!bucket) throw new Error('EVIDENCE_BUCKET is required');
    this.bucket = bucket;
    this.s3 = client ?? new S3Client({});
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
    const put = await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'text/plain; charset=utf-8',
        ChecksumSHA256: Buffer.from(digest, 'hex').toString('base64'),
        ServerSideEncryption: 'aws:kms',
        ObjectLockMode: 'COMPLIANCE',
        ObjectLockRetainUntilDate: retainUntil,
        Metadata: {
          evidenceid: evidenceId,
          observationid: observation.id,
          sourceid: observation.sourceId,
          capturedby: input.capturedBy,
          capturedat: capturedAt,
        },
      }),
    );
    custody.push(this.custody(custody, new Date().toISOString(), input.capturedBy, 'stored', `s3://${this.bucket}/${key} version=${put.VersionId ?? 'n/a'}`));
    custody.push(this.custody(custody, new Date().toISOString(), 'system', 'locked', `object lock COMPLIANCE until ${retainUntil.toISOString()}`));

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
        bucket: this.bucket,
        key,
        versionId: put.VersionId ?? null,
        sha256: digest,
        bytes: body.byteLength,
        contentType: 'text/plain; charset=utf-8',
      },
      retention: { mode: 'COMPLIANCE', retainUntil: retainUntil.toISOString(), days: input.retentionDays },
      observationMetadata: observation.metadata,
      custody,
      manifestVersion: 1,
    };

    const manifestBody = Buffer.from(canonicalize(manifest), 'utf8');
    const manifestSha = sha256(manifestBody);
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${key.replace(/content\.txt$/, '')}manifest.json`,
        Body: manifestBody,
        ContentType: 'application/json',
        ChecksumSHA256: Buffer.from(manifestSha, 'hex').toString('base64'),
        ServerSideEncryption: 'aws:kms',
        ObjectLockMode: 'COMPLIANCE',
        ObjectLockRetainUntilDate: retainUntil,
      }),
    );

    return {
      id: evidenceId,
      anomalyId: input.anomalyId,
      observationId: observation.id,
      capturedBy: 'archivist',
      capturedAt,
      s3Bucket: this.bucket,
      s3Key: key,
      s3VersionId: put.VersionId ?? null,
      sha256: digest,
      bytes: body.byteLength,
      contentType: 'text/plain; charset=utf-8',
      retainUntil: retainUntil.toISOString(),
      manifestSha256: manifestSha,
      chainOfCustody: custody,
    };
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
