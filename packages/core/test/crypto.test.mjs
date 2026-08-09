import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  encryptEnvelope, decryptEnvelope, sha256, contentFingerprint, fingerprintSimilarity, exactSimilarity,
} from '../dist/index.js';

// Local stand-in for KMS: wraps the data key with a fixed XOR so tests do not
// need AWS. Production injects the real KMS-backed provider.
const provider = () => {
  const mask = randomBytes(32);
  return {
    async generateDataKey() {
      const plaintext = randomBytes(32);
      const ciphertext = Buffer.from(plaintext.map((b, i) => b ^ mask[i]));
      return { plaintext: Buffer.from(plaintext), ciphertext };
    },
    async decryptDataKey(ciphertext) {
      return Buffer.from(ciphertext.map((b, i) => b ^ mask[i]));
    },
  };
};

test('envelope round-trips', async () => {
  const p = provider();
  const env = await encryptEnvelope(p, 'sensitive source configuration', 'source:abc123');
  assert.equal(env.alg, 'AES-256-GCM');
  assert.notEqual(env.ciphertext, Buffer.from('sensitive source configuration').toString('base64'));
  const out = await decryptEnvelope(p, env);
  assert.equal(out.toString('utf8'), 'sensitive source configuration');
});

test('tampered ciphertext fails authentication', async () => {
  const p = provider();
  const env = await encryptEnvelope(p, 'do not modify me');
  const bytes = Buffer.from(env.ciphertext, 'base64');
  bytes[0] ^= 0xff;
  env.ciphertext = bytes.toString('base64');
  await assert.rejects(() => decryptEnvelope(p, env));
});

test('wrong AAD fails — ciphertext is bound to its context', async () => {
  const p = provider();
  const env = await encryptEnvelope(p, 'payload', 'source:correct');
  env.aad = 'source:attacker';
  await assert.rejects(() => decryptEnvelope(p, env));
});

test('sha256 is stable', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

// Article-length text: this is the realistic case for silent-edit detection.
const ARTICLE = `The department confirmed on Tuesday that the officer involved in the March incident
was placed on paid administrative leave pending the outcome of an internal review. According to the
statement, the review is being conducted by the professional standards division and is expected to
conclude within ninety days. The department declined to identify the officer, citing an ongoing
investigation. Body-worn camera footage from the incident has been retained but has not been released
to the public. A spokesperson said the department would provide an update once the review concludes.`;

const ARTICLE_EDITED = ARTICLE.replace('placed on paid administrative leave', 'placed on unpaid administrative leave');

const ARTICLE_REWRITTEN = `Officials said Tuesday the officer connected to the March incident has been
suspended without pay while an internal inquiry proceeds. The professional standards division is
handling the inquiry, which officials expect to wrap up inside three months. Citing the open
investigation, the department would not name the officer. Camera footage exists but remains unreleased.`;

const UNRELATED = `Quarterly earnings exceeded analyst expectations across all three business segments,
driven by stronger subscription renewals and a favourable currency environment. Management raised
full-year guidance and announced an expanded share repurchase programme during the earnings call.`;

test('a one-word edit stays nearly identical on article-length text', () => {
  const sim = fingerprintSimilarity(contentFingerprint(ARTICLE), contentFingerprint(ARTICLE_EDITED));
  assert.ok(sim > 0.9, `edited article similarity too low: ${sim}`);
  assert.ok(sim < 1.0, 'an edit must be detectable at all');
});

test('similarity separates edited, rewritten and unrelated documents', () => {
  const fp = contentFingerprint(ARTICLE);
  const edited = fingerprintSimilarity(fp, contentFingerprint(ARTICLE_EDITED));
  const rewritten = fingerprintSimilarity(fp, contentFingerprint(ARTICLE_REWRITTEN));
  const unrelated = fingerprintSimilarity(fp, contentFingerprint(UNRELATED));
  assert.ok(edited > rewritten, `edited ${edited} should beat rewritten ${rewritten}`);
  assert.ok(rewritten > unrelated, `rewritten ${rewritten} should beat unrelated ${unrelated}`);
  assert.ok(unrelated < 0.2, `unrelated similarity too high: ${unrelated}`);
});

test('MinHash signature approximates exact Jaccard within tolerance', () => {
  const estimated = fingerprintSimilarity(contentFingerprint(ARTICLE), contentFingerprint(ARTICLE_REWRITTEN));
  const exact = exactSimilarity(ARTICLE, ARTICLE_REWRITTEN);
  assert.ok(Math.abs(estimated - exact) < 0.2, `estimate ${estimated} vs exact ${exact}`);
});

test('identical text yields identical fingerprints', () => {
  assert.equal(contentFingerprint(ARTICLE), contentFingerprint(ARTICLE));
  assert.equal(fingerprintSimilarity(contentFingerprint(ARTICLE), contentFingerprint(ARTICLE)), 1);
});

test('fingerprint ignores punctuation and case but not word order', () => {
  const a = contentFingerprint('the officer was placed on leave');
  const b = contentFingerprint('The Officer was placed on leave!');
  const c = contentFingerprint('leave on placed was officer the');
  assert.equal(fingerprintSimilarity(a, b), 1);
  assert.ok(fingerprintSimilarity(a, c) < 1, 'bigrams must capture word order');
});
