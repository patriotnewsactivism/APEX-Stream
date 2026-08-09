import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Envelope encryption.
 *
 * KMS never sees your plaintext and you never hold a long-lived symmetric key:
 * KMS mints a one-time data key, we encrypt locally with AES-256-GCM, and we
 * store the KMS-wrapped copy of that key alongside the ciphertext. Rotating
 * the KMS key re-wraps future data keys without touching existing records.
 *
 * The KMS client is injected rather than imported so this module stays
 * testable and free of AWS SDK weight in the shared package.
 */

export interface DataKeyProvider {
  /** Returns a fresh data key: plaintext for local use, ciphertext to store. */
  generateDataKey(): Promise<{ plaintext: Buffer; ciphertext: Buffer }>;
  /** Unwraps a stored data key. */
  decryptDataKey(ciphertext: Buffer): Promise<Buffer>;
}

export interface EnvelopeCiphertext {
  /** Format version so we can change algorithms without ambiguity. */
  v: 1;
  alg: 'AES-256-GCM';
  /** KMS-wrapped data key, base64. */
  wrappedKey: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  /** Additional authenticated data — binds ciphertext to its context. */
  aad: string | null;
}

const IV_BYTES = 12;

export async function encryptEnvelope(
  provider: DataKeyProvider,
  plaintext: Buffer | string,
  aad?: string,
): Promise<EnvelopeCiphertext> {
  const { plaintext: key, ciphertext: wrapped } = await provider.generateDataKey();
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
    const buf = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
    return {
      v: 1,
      alg: 'AES-256-GCM',
      wrappedKey: wrapped.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: enc.toString('base64'),
      aad: aad ?? null,
    };
  } finally {
    key.fill(0); // do not leave the data key sitting in the heap
  }
}

export async function decryptEnvelope(
  provider: DataKeyProvider,
  envelope: EnvelopeCiphertext,
): Promise<Buffer> {
  if (envelope.v !== 1 || envelope.alg !== 'AES-256-GCM') {
    throw new Error(`unsupported envelope format: v${envelope.v} ${envelope.alg}`);
  }
  const key = await provider.decryptDataKey(Buffer.from(envelope.wrappedKey, 'base64'));
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    if (envelope.aad) decipher.setAAD(Buffer.from(envelope.aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]);
  } finally {
    key.fill(0);
  }
}

/** SHA-256 of arbitrary bytes — used for content hashing and custody records. */
export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Constant-time comparison for hashes, tokens and signatures. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * MinHash fingerprint for near-duplicate detection.
 *
 * This backs the "silent edit" and "content novelty" signals, so it needs to
 * answer one question reliably: *how much of this document is the same as the
 * copy we archived earlier?*
 *
 * Features are word unigrams plus bigrams, and the signature estimates
 * Jaccard similarity over that feature set. MinHash is used rather than
 * SimHash because SimHash's bit-majority vote is unstable on short documents —
 * with only a few dozen features, many bit sums sit near zero and flip on
 * trivial edits, producing similarity scores that swing without meaning. A
 * detection signal that is noisy on short inputs is worse than no signal,
 * because it manufactures anomalies the operator then has to disprove.
 *
 * Interpreting the score (see `fingerprintSimilarity`): the shorter the text,
 * the more a single word moves the number. On an article-length document a
 * one-word edit shifts similarity by well under a percent; on a one-line
 * headline it can shift it by twenty. Compare like with like.
 */

const PERMUTATIONS = 32;
const MERSENNE_PRIME = 2147483647; // 2^31 - 1

/** Deterministic coefficients — identical across processes and deploys. */
const COEFFICIENTS: ReadonlyArray<readonly [number, number]> = Array.from(
  { length: PERMUTATIONS },
  (_, i) => {
    const seed = createHash('sha256').update(`apex.minhash.v1.${i}`).digest();
    const a = (seed.readUInt32BE(0) % (MERSENNE_PRIME - 1)) + 1; // must be non-zero
    const b = seed.readUInt32BE(4) % MERSENNE_PRIME;
    return [a, b] as const;
  },
);

function featureSet(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);

  const features = new Set<string>(tokens);
  for (let i = 0; i + 1 < tokens.length; i++) features.add(`${tokens[i]}_${tokens[i + 1]}`);
  return features;
}

function baseHash(feature: string): number {
  return createHash('sha256').update(feature).digest().readUInt32BE(0) % MERSENNE_PRIME;
}

/** Returns a hex MinHash signature. Empty input yields an all-zero signature. */
export function contentFingerprint(text: string): string {
  const features = featureSet(text);
  if (features.size === 0) return '0'.repeat(PERMUTATIONS * 8);

  const signature = new Array<number>(PERMUTATIONS).fill(MERSENNE_PRIME);
  for (const feature of features) {
    const base = baseHash(feature);
    for (let i = 0; i < PERMUTATIONS; i++) {
      const [a, b] = COEFFICIENTS[i] ?? [1, 0];
      const value = (a * base + b) % MERSENNE_PRIME;
      if (value < (signature[i] ?? MERSENNE_PRIME)) signature[i] = value;
    }
  }
  return signature.map((v) => v.toString(16).padStart(8, '0')).join('');
}

/**
 * Estimated Jaccard similarity, 0..1. Read it as "roughly this fraction of
 * the document's word features are shared".
 *
 * Rough guidance for article-length text:
 *   > 0.95  same document, minor edit — typo, timestamp, one word changed
 *   0.80-0.95  same document, meaningfully revised
 *   0.40-0.80  same story, independently written
 *   < 0.40  unrelated
 */
export function fingerprintSimilarity(a: string, b: string): number {
  if (a.length !== b.length || a.length === 0) return 0;
  if (a.length % 8 !== 0) return 0;
  const slots = a.length / 8;
  let matches = 0;
  for (let i = 0; i < slots; i++) {
    if (a.slice(i * 8, i * 8 + 8) === b.slice(i * 8, i * 8 + 8)) matches++;
  }
  return matches / slots;
}

/** Exact Jaccard over the feature sets. Slower; use to calibrate thresholds. */
export function exactSimilarity(textA: string, textB: string): number {
  const a = featureSet(textA);
  const b = featureSet(textB);
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const f of a) if (b.has(f)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
