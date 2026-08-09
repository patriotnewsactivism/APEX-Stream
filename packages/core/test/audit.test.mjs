import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealEntry, verifyChain, GENESIS_HASH, canonicalize } from '../dist/index.js';

const entry = (action, i) => ({
  actor: 'operator@apex',
  actorType: 'human',
  action,
  resourceType: 'run',
  resourceId: `run-${i}`,
  detail: { i },
  outcome: 'allowed',
});

function buildChain(n) {
  const out = [];
  let prev = GENESIS_HASH;
  for (let i = 0; i < n; i++) {
    const e = sealEntry(entry('run.started', i), i, prev, new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
    out.push(e);
    prev = e.entryHash;
  }
  return out;
}

test('a well-formed chain verifies', () => {
  const chain = buildChain(20);
  const v = verifyChain(chain);
  assert.equal(v.valid, true);
  assert.equal(v.entriesChecked, 20);
});

test('mutating an entry breaks the chain at that entry', () => {
  const chain = buildChain(10);
  chain[4].detail = { i: 'tampered' };
  const v = verifyChain(chain);
  assert.equal(v.valid, false);
  assert.equal(v.brokenAtSequence, 4);
  assert.match(v.reason, /do not match the stored hash/);
});

test('deleting an entry is detected', () => {
  const chain = buildChain(10);
  chain.splice(5, 1);
  const v = verifyChain(chain);
  assert.equal(v.valid, false);
  assert.match(v.reason, /sequence gap/);
});

test('re-hashing a tampered entry still fails because the successor commits to it', async () => {
  const chain = buildChain(6);
  // A sophisticated tamper: change entry 2 AND recompute its own hash.
  chain[2].detail = { i: 999 };
  const { computeEntryHash } = await import('../dist/index.js');
  chain[2].entryHash = computeEntryHash(chain[2]);
  const v = verifyChain(chain);
  assert.equal(v.valid, false, 'entry 3 still points at the old hash');
  assert.equal(v.brokenAtSequence, 3);
});

test('canonicalize is key-order independent', () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.equal(canonicalize({ a: { z: 1, y: 2 } }), '{"a":{"y":2,"z":1}}');
});
