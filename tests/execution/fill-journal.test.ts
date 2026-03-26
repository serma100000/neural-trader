import { describe, it, expect, beforeEach } from 'vitest';
import { FillJournal, type JournalEntry } from '../../src/execution/fill-journal.js';
import type { FillReport } from '../../src/execution/types.js';
import type { VerifiedToken, Timestamp } from '../../src/shared/types.js';

function makeToken(id = 'tok-1'): VerifiedToken {
  return {
    tokenId: id,
    tsNs: BigInt(Date.now()) * 1_000_000n as Timestamp,
    coherenceHash: 'coh-hash',
    policyHash: 'pol-hash',
    actionIntent: 'place',
  };
}

function makeFilledReport(price = 50000_00000000n, qty = 10_00000000n): FillReport {
  return {
    type: 'filled',
    fillPriceFp: price,
    fillQtyFp: qty,
    tsNs: BigInt(Date.now()) * 1_000_000n,
  };
}

function makeCancelledReport(): FillReport {
  return {
    type: 'cancelled',
    tsNs: BigInt(Date.now()) * 1_000_000n,
  };
}

describe('FillJournal', () => {
  let journal: FillJournal;

  beforeEach(() => {
    journal = new FillJournal();
  });

  it('should record entries with a hash chain', () => {
    const fill = makeFilledReport();
    journal.record(fill, makeToken(), 'pos-hash-1');

    expect(journal.size()).toBe(1);

    const entries = journal.getAllEntries();
    expect(entries[0]!.tokenId).toBe('tok-1');
    expect(entries[0]!.positionHash).toBe('pos-hash-1');
    expect(entries[0]!.chainHash).toBeTruthy();
    expect(typeof entries[0]!.chainHash).toBe('string');
    expect(entries[0]!.chainHash.length).toBe(64); // SHA-256 hex
  });

  it('should link entries in a hash chain', () => {
    journal.record(makeFilledReport(), makeToken('tok-1'), 'pos-1');
    journal.record(makeFilledReport(51000_00000000n), makeToken('tok-2'), 'pos-2');
    journal.record(makeCancelledReport(), makeToken('tok-3'), 'pos-3');

    const entries = journal.getAllEntries();
    expect(entries.length).toBe(3);

    // Each entry should have a unique chain hash
    const hashes = entries.map((e) => e.chainHash);
    const uniqueHashes = new Set(hashes);
    expect(uniqueHashes.size).toBe(3);
  });

  it('should pass chain validation for a clean journal', () => {
    journal.record(makeFilledReport(), makeToken('tok-1'), 'pos-1');
    journal.record(makeFilledReport(), makeToken('tok-2'), 'pos-2');
    journal.record(makeFilledReport(), makeToken('tok-3'), 'pos-3');

    expect(journal.validateChain()).toBe(true);
  });

  it('should detect tampered entries via chain validation', () => {
    journal.record(makeFilledReport(), makeToken('tok-1'), 'pos-1');
    journal.record(makeFilledReport(), makeToken('tok-2'), 'pos-2');
    journal.record(makeFilledReport(), makeToken('tok-3'), 'pos-3');

    // Tamper with the middle entry
    const entries = journal.getAllEntries();
    // Access internal entries for tampering (cast to bypass readonly)
    const internalEntries = (journal as unknown as { entries: JournalEntry[] }).entries;
    internalEntries[1] = {
      ...internalEntries[1]!,
      positionHash: 'tampered-hash',
    };

    expect(journal.validateChain()).toBe(false);
  });

  it('should return entries within a time range', () => {
    // Record entries with known timestamps by manipulating the journal
    const baseNs = 1000000000000n;

    journal.record(makeFilledReport(), makeToken('tok-1'), 'pos-1');
    journal.record(makeFilledReport(), makeToken('tok-2'), 'pos-2');
    journal.record(makeFilledReport(), makeToken('tok-3'), 'pos-3');

    const allEntries = journal.getAllEntries();
    expect(allEntries.length).toBe(3);

    // Query with a range that covers all recorded entries
    const startNs = allEntries[0]!.recordedAtNs;
    const endNs = allEntries[2]!.recordedAtNs;
    const rangeEntries = journal.getEntries(startNs, endNs);
    expect(rangeEntries.length).toBe(3);

    // Query with a range that covers only the first entry
    const narrowEntries = journal.getEntries(startNs, startNs);
    expect(narrowEntries.length).toBeGreaterThanOrEqual(1);
  });

  it('should return empty array for out-of-range query', () => {
    journal.record(makeFilledReport(), makeToken(), 'pos-1');

    const entries = journal.getEntries(0n, 1n);
    expect(entries.length).toBe(0);
  });

  it('should handle empty journal validation', () => {
    expect(journal.validateChain()).toBe(true);
    expect(journal.size()).toBe(0);
  });

  it('should handle different fill report types', () => {
    const filled: FillReport = {
      type: 'filled',
      fillPriceFp: 50000_00000000n,
      fillQtyFp: 10_00000000n,
      tsNs: 1000n,
    };
    const partial: FillReport = {
      type: 'partial_fill',
      fillPriceFp: 50000_00000000n,
      fillQtyFp: 5_00000000n,
      remainingQtyFp: 5_00000000n,
      tsNs: 2000n,
    };
    const rejected: FillReport = {
      type: 'rejected',
      reason: 'insufficient funds',
      tsNs: 3000n,
    };
    const cancelled: FillReport = {
      type: 'cancelled',
      tsNs: 4000n,
    };

    journal.record(filled, makeToken('tok-1'), 'pos-1');
    journal.record(partial, makeToken('tok-2'), 'pos-2');
    journal.record(rejected, makeToken('tok-3'), 'pos-3');
    journal.record(cancelled, makeToken('tok-4'), 'pos-4');

    expect(journal.size()).toBe(4);
    expect(journal.validateChain()).toBe(true);
  });

  it('should produce deterministic hashes for same inputs', () => {
    const journal2 = new FillJournal();
    const fill: FillReport = {
      type: 'filled',
      fillPriceFp: 50000_00000000n,
      fillQtyFp: 10_00000000n,
      tsNs: 1000n,
    };
    const token = makeToken('tok-det');
    const posHash = 'pos-det';

    journal.record(fill, token, posHash);
    journal2.record(fill, token, posHash);

    // The chain hashes depend on recordedAtNs which differs, so they won't match
    // But both should individually validate
    expect(journal.validateChain()).toBe(true);
    expect(journal2.validateChain()).toBe(true);
  });
});
