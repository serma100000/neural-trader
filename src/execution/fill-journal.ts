import { createHash } from 'node:crypto';
import type { VerifiedToken } from '../shared/types.js';
import type { FillReport } from './types.js';

export interface JournalEntry {
  fill: FillReport;
  tokenId: string;
  positionHash: string;
  chainHash: string;
  recordedAtNs: bigint;
}

/**
 * Append-only fill journal with cryptographic hash chain.
 * Each entry includes a chainHash that links to the previous entry,
 * forming a tamper-evident log of all execution activity.
 */
export class FillJournal {
  private readonly entries: JournalEntry[] = [];
  private lastChainHash = 'genesis';

  constructor() {
    // Intentionally empty; genesis hash is set above
  }

  /**
   * Record a fill into the journal with hash chain linking.
   */
  record(fill: FillReport, token: VerifiedToken, positionHash: string): void {
    const recordedAtNs = BigInt(Date.now()) * 1_000_000n;

    const chainHash = this.computeChainHash(
      this.lastChainHash,
      fill,
      token.tokenId,
      positionHash,
      recordedAtNs,
    );

    const entry: JournalEntry = {
      fill,
      tokenId: token.tokenId,
      positionHash,
      chainHash,
      recordedAtNs,
    };

    this.entries.push(entry);
    this.lastChainHash = chainHash;
  }

  /**
   * Retrieve entries within a time range (inclusive).
   */
  getEntries(startNs: bigint, endNs: bigint): JournalEntry[] {
    return this.entries.filter(
      (e) => e.recordedAtNs >= startNs && e.recordedAtNs <= endNs,
    );
  }

  /**
   * Validate the entire hash chain from genesis.
   * Returns true if no entries have been tampered with.
   */
  validateChain(): boolean {
    let previousHash = 'genesis';

    for (const entry of this.entries) {
      const expectedHash = this.computeChainHash(
        previousHash,
        entry.fill,
        entry.tokenId,
        entry.positionHash,
        entry.recordedAtNs,
      );

      if (expectedHash !== entry.chainHash) {
        return false;
      }

      previousHash = entry.chainHash;
    }

    return true;
  }

  /**
   * Return the total number of journal entries.
   */
  size(): number {
    return this.entries.length;
  }

  /**
   * Get all entries (for testing/inspection).
   */
  getAllEntries(): JournalEntry[] {
    return [...this.entries];
  }

  // --- Private helpers ---

  private computeChainHash(
    previousHash: string,
    fill: FillReport,
    tokenId: string,
    positionHash: string,
    recordedAtNs: bigint,
  ): string {
    const hasher = createHash('sha256');
    hasher.update(previousHash);
    hasher.update(serializeFillReport(fill));
    hasher.update(tokenId);
    hasher.update(positionHash);
    hasher.update(recordedAtNs.toString());
    return hasher.digest('hex');
  }
}

/**
 * Deterministic serialization of a FillReport for hashing.
 */
function serializeFillReport(fill: FillReport): string {
  switch (fill.type) {
    case 'filled':
      return `filled:${fill.fillPriceFp}:${fill.fillQtyFp}:${fill.tsNs}`;
    case 'partial_fill':
      return `partial_fill:${fill.fillPriceFp}:${fill.fillQtyFp}:${fill.remainingQtyFp}:${fill.tsNs}`;
    case 'rejected':
      return `rejected:${fill.reason}:${fill.tsNs}`;
    case 'cancelled':
      return `cancelled:${fill.tsNs}`;
  }
}
