import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceLedger, LedgerIntegrityError } from '../dist/ledger.js';

test('EvidenceLedger: appends and validates hash chain', () => {
  const ledger = new EvidenceLedger();
  ledger.append({ event: 'agent.start', agentId: 'sentinel' });
  ledger.append({ event: 'comment.flagged', commentId: 'yt-123', score: 0.95 });
  ledger.append({ event: 'archivist.persist', objectKey: 's3://ledger/1.json' });

  assert.equal(ledger.getEntries().length, 3);
  assert.equal(ledger.verifyIntegrity(), true);
});

test('EvidenceLedger: detects tampering with intermediate payload hash', () => {
  const ledger = new EvidenceLedger();
  ledger.append({ comment: 'First' });
  ledger.append({ comment: 'Second' });
  ledger.append({ comment: 'Third' });

  // Tamper with second entry
  const entries = ledger.getEntries();
  entries[1].payloadHash = 'tampered-hash-value';

  assert.throws(() => {
    // Reconstruct invalid internal state
    const tamperedLedger = new EvidenceLedger();
    for (const e of entries) {
      tamperedLedger['entries'].push(e);
    }
    tamperedLedger.verifyIntegrity();
  }, LedgerIntegrityError);
});

test('EvidenceLedger: handles high-throughput simulated concurrent streaming', () => {
  const ledger = new EvidenceLedger();
  const streamCount = 500;

  for (let i = 0; i < streamCount; i++) {
    ledger.append({
      streamId: `stream-${i}`,
      author: `user-${i % 20}`,
      message: `Message #${i}`,
      timestamp: Date.now() + i,
    });
  }

  assert.equal(ledger.getEntries().length, streamCount);
  assert.equal(ledger.verifyIntegrity(), true);
});
