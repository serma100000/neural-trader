import { describe, it, expect, beforeEach } from 'vitest';
import type { Timestamp, WitnessReceipt } from '../../src/shared/types.js';
import type { IReceiptRepository } from '../../src/storage/types.js';
import { validateReceiptChain, computeChainHash } from '../../src/storage/receipt-repo.js';

// ---------------------------------------------------------------------------
// In-memory implementation for unit tests
// ---------------------------------------------------------------------------

class InMemoryReceiptRepository implements IReceiptRepository {
  private receipts: WitnessReceipt[] = [];

  async append(receipt: WitnessReceipt): Promise<void> {
    this.receipts.push({ ...receipt });
  }

  async queryByTimeRange(startNs: Timestamp, endNs: Timestamp): Promise<WitnessReceipt[]> {
    return this.receipts
      .filter(
        (r) =>
          BigInt(r.tsNs) >= BigInt(startNs) &&
          BigInt(r.tsNs) < BigInt(endNs),
      )
      .sort((a, b) => {
        const diff = BigInt(a.tsNs) - BigInt(b.tsNs);
        return diff < 0n ? -1 : diff > 0n ? 1 : 0;
      });
  }

  async queryByModelId(modelId: string): Promise<WitnessReceipt[]> {
    return this.receipts
      .filter((r) => r.modelId === modelId)
      .sort((a, b) => {
        const diff = BigInt(a.tsNs) - BigInt(b.tsNs);
        return diff < 0n ? -1 : diff > 0n ? 1 : 0;
      });
  }

  async validateChain(startNs: Timestamp, endNs: Timestamp): Promise<boolean> {
    const receipts = await this.queryByTimeRange(startNs, endNs);
    return validateReceiptChain(receipts);
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeReceipt(
  tsNs: bigint,
  overrides: Partial<WitnessReceipt> = {},
): WitnessReceipt {
  return {
    tsNs: tsNs as Timestamp,
    modelId: 'model-v1',
    inputSegmentHash: 'input-hash-default',
    coherenceWitnessHash: 'coherence-hash-default',
    policyHash: 'policy-hash-default',
    actionIntent: 'trade',
    verifiedTokenId: 'token-001',
    resultingStateHash: 'result-hash-default',
    ...overrides,
  };
}

/**
 * Build a valid chain of receipts where each receipt's inputSegmentHash
 * is derived from the previous receipt's resultingStateHash and coherenceWitnessHash.
 */
function makeValidChain(count: number): WitnessReceipt[] {
  const chain: WitnessReceipt[] = [];

  for (let i = 0; i < count; i++) {
    const inputHash =
      i === 0
        ? 'genesis-input'
        : computeChainHash(
            chain[i - 1].resultingStateHash,
            chain[i - 1].coherenceWitnessHash,
          );

    chain.push(
      makeReceipt(BigInt(1000 + i * 100), {
        inputSegmentHash: inputHash,
        coherenceWitnessHash: `coherence-${i}`,
        resultingStateHash: `result-${i}`,
      }),
    );
  }

  return chain;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InMemoryReceiptRepository', () => {
  let repo: InMemoryReceiptRepository;

  beforeEach(() => {
    repo = new InMemoryReceiptRepository();
  });

  describe('append and queryByTimeRange', () => {
    it('should store and retrieve receipts in time order', async () => {
      await repo.append(makeReceipt(3000n, { modelId: 'third' }));
      await repo.append(makeReceipt(1000n, { modelId: 'first' }));
      await repo.append(makeReceipt(2000n, { modelId: 'second' }));

      const results = await repo.queryByTimeRange(
        1000n as Timestamp,
        4000n as Timestamp,
      );

      expect(results).toHaveLength(3);
      expect(results[0].modelId).toBe('first');
      expect(results[1].modelId).toBe('second');
      expect(results[2].modelId).toBe('third');
    });

    it('should use exclusive end bound', async () => {
      await repo.append(makeReceipt(1000n));
      await repo.append(makeReceipt(2000n));

      const results = await repo.queryByTimeRange(
        1000n as Timestamp,
        2000n as Timestamp,
      );
      expect(results).toHaveLength(1);
    });

    it('should return empty for non-matching range', async () => {
      await repo.append(makeReceipt(5000n));
      const results = await repo.queryByTimeRange(
        1000n as Timestamp,
        2000n as Timestamp,
      );
      expect(results).toHaveLength(0);
    });
  });

  describe('queryByModelId', () => {
    it('should filter by model ID', async () => {
      await repo.append(makeReceipt(1000n, { modelId: 'alpha' }));
      await repo.append(makeReceipt(2000n, { modelId: 'beta' }));
      await repo.append(makeReceipt(3000n, { modelId: 'alpha' }));

      const results = await repo.queryByModelId('alpha');
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.modelId === 'alpha')).toBe(true);
    });

    it('should return empty for unknown model', async () => {
      await repo.append(makeReceipt(1000n));
      const results = await repo.queryByModelId('nonexistent');
      expect(results).toHaveLength(0);
    });
  });

  describe('validateChain', () => {
    it('should validate a correct chain', async () => {
      const chain = makeValidChain(5);
      for (const r of chain) {
        await repo.append(r);
      }

      const valid = await repo.validateChain(
        0n as Timestamp,
        BigInt(Number.MAX_SAFE_INTEGER) as Timestamp,
      );
      expect(valid).toBe(true);
    });

    it('should detect a tampered receipt in the chain', async () => {
      const chain = makeValidChain(5);

      // Tamper with the third receipt's inputSegmentHash
      chain[2] = {
        ...chain[2],
        inputSegmentHash: 'tampered-hash',
      };

      for (const r of chain) {
        await repo.append(r);
      }

      const valid = await repo.validateChain(
        0n as Timestamp,
        BigInt(Number.MAX_SAFE_INTEGER) as Timestamp,
      );
      expect(valid).toBe(false);
    });

    it('should return true for empty chain', async () => {
      const valid = await repo.validateChain(
        0n as Timestamp,
        1000n as Timestamp,
      );
      expect(valid).toBe(true);
    });

    it('should return true for single receipt', async () => {
      await repo.append(makeReceipt(500n));
      const valid = await repo.validateChain(
        0n as Timestamp,
        1000n as Timestamp,
      );
      expect(valid).toBe(true);
    });
  });
});

describe('computeChainHash', () => {
  it('should produce deterministic hashes', () => {
    const hash1 = computeChainHash('result-a', 'coherence-b');
    const hash2 = computeChainHash('result-a', 'coherence-b');
    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different inputs', () => {
    const hash1 = computeChainHash('result-a', 'coherence-b');
    const hash2 = computeChainHash('result-a', 'coherence-c');
    expect(hash1).not.toBe(hash2);
  });

  it('should return a 64-char hex string (sha256)', () => {
    const hash = computeChainHash('x', 'y');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('validateReceiptChain', () => {
  it('should validate a properly chained sequence', () => {
    const chain = makeValidChain(3);
    expect(validateReceiptChain(chain)).toBe(true);
  });

  it('should reject a broken chain', () => {
    const chain = makeValidChain(3);
    chain[1] = { ...chain[1], inputSegmentHash: 'wrong' };
    expect(validateReceiptChain(chain)).toBe(false);
  });
});
