import { createHash } from 'node:crypto';

export interface LedgerEntry {
  sequenceNumber: number;
  timestamp: number;
  payloadHash: string;
  previousHash: string;
  currentHash: string;
  metadata?: Record<string, unknown>;
}

export class LedgerIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerIntegrityError';
  }
}

export function computePayloadHash(payload: unknown): string {
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return createHash('sha256').update(serialized).digest('hex');
}

export function computeEntryHash(sequenceNumber: number, timestamp: number, payloadHash: string, previousHash: string): string {
  return createHash('sha256')
    .update(`${sequenceNumber}:${timestamp}:${payloadHash}:${previousHash}`)
    .digest('hex');
}

export class EvidenceLedger {
  private readonly entries: LedgerEntry[] = [];
  public static readonly GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

  public append(payload: unknown, timestamp = Date.now(), metadata?: Record<string, unknown>): LedgerEntry {
    const sequenceNumber = this.entries.length + 1;
    const previousHash = this.entries.length === 0
      ? EvidenceLedger.GENESIS_HASH
      : this.entries[this.entries.length - 1].currentHash;
    const payloadHash = computePayloadHash(payload);
    const currentHash = computeEntryHash(sequenceNumber, timestamp, payloadHash, previousHash);

    const entry: LedgerEntry = {
      sequenceNumber,
      timestamp,
      payloadHash,
      previousHash,
      currentHash,
      metadata,
    };

    this.entries.push(entry);
    return entry;
  }

  public getEntries(): ReadonlyArray<LedgerEntry> {
    return [...this.entries];
  }

  public verifyIntegrity(): boolean {
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      const expectedPrevious = i === 0 ? EvidenceLedger.GENESIS_HASH : this.entries[i - 1].currentHash;

      if (entry.previousHash !== expectedPrevious) {
        throw new LedgerIntegrityError(
          `Previous hash mismatch at sequence ${entry.sequenceNumber}: expected ${expectedPrevious}, got ${entry.previousHash}`
        );
      }

      const recalculated = computeEntryHash(entry.sequenceNumber, entry.timestamp, entry.payloadHash, entry.previousHash);
      if (entry.currentHash !== recalculated) {
        throw new LedgerIntegrityError(
          `Hash tampering detected at sequence ${entry.sequenceNumber}: expected ${recalculated}, got ${entry.currentHash}`
        );
      }
    }
    return true;
  }
}
