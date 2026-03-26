import { describe, it, expect } from 'vitest';
import { ProofGate } from '../../src/policy/proof-gate.js';
import type { CoherenceDecision, SymbolId, VenueId, Timestamp } from '../../src/shared/types.js';
import type { PolicyInput, ActionDecision, VenueState, PositionSnapshot, RiskBudgetSnapshot } from '../../src/policy/types.js';
import type { ModelOutput } from '../../src/gnn/types.js';
import { Side } from '../../src/shared/types.js';

// --- Test Helpers ---

function makeCoherence(): CoherenceDecision {
  return {
    allowRetrieve: true,
    allowWrite: true,
    allowLearn: true,
    allowAct: true,
    mincutValue: 100n,
    partitionHash: 'abc123',
    driftScore: 0.1,
    cusumScore: 0.05,
    reasons: [],
  };
}

function makeModelOutput(): ModelOutput {
  return {
    embeddings: [],
    predictions: [],
    controls: [
      { headName: 'place_signal', value: 0.8, confidence: 0.9 },
    ],
    tsNs: 1000n,
  };
}

function makePolicyInput(): PolicyInput {
  return {
    coherence: makeCoherence(),
    modelOutput: makeModelOutput(),
    position: {
      symbolId: 1 as SymbolId,
      netQtyFp: 0n,
      avgEntryPriceFp: 0n,
      realizedPnlFp: 0n,
      unrealizedPnlFp: 0n,
      openOrderCount: 0,
      lastFillTsNs: 0n,
    },
    riskBudget: {
      totalNotionalUsed: 0,
      perSymbolNotional: new Map(),
      rollingOrderRate: 0,
      rollingCancelRate: 0,
      cumulativeSlippageBp: 0,
      sessionDrawdownPct: 0,
    },
    venueState: {
      venueId: 1 as VenueId,
      isHalted: false,
      isHealthy: true,
      lastHeartbeatNs: 999n,
    },
    tsNs: 1000n,
  };
}

function makePlaceAction(): ActionDecision {
  return {
    type: 'place',
    intent: {
      symbolId: 1 as SymbolId,
      venueId: 1 as VenueId,
      side: Side.Bid,
      priceFp: 100_000_000n,
      qtyFp: 1_000_000n,
      orderType: 'limit',
      timeInForce: 'day',
    },
  };
}

// --- Tests ---

describe('ProofGate', () => {
  describe('mintToken', () => {
    it('should produce a valid VerifiedToken with all required fields', () => {
      const gate = new ProofGate();
      const coherence = makeCoherence();
      const input = makePolicyInput();
      const action = makePlaceAction();

      const token = gate.mintToken(coherence, input, action);

      expect(token.tokenId).toBeDefined();
      expect(typeof token.tokenId).toBe('string');
      expect(token.tokenId.length).toBe(64); // SHA-256 hex length
      expect(token.tsNs).toBe(1000n);
      expect(token.coherenceHash).toBeDefined();
      expect(token.coherenceHash.length).toBe(64);
      expect(token.policyHash).toBeDefined();
      expect(token.policyHash.length).toBe(64);
      expect(token.actionIntent).toContain('place');
    });

    it('should produce different tokens for different actions', () => {
      const gate = new ProofGate();
      const coherence = makeCoherence();
      const input = makePolicyInput();

      const token1 = gate.mintToken(coherence, input, makePlaceAction());
      const token2 = gate.mintToken(coherence, input, {
        type: 'hold',
        reason: { ruleName: 'test', detail: 'testing' },
      });

      expect(token1.tokenId).not.toBe(token2.tokenId);
      expect(token1.actionIntent).not.toBe(token2.actionIntent);
    });

    it('should produce the same coherence hash for the same coherence decision', () => {
      const gate = new ProofGate();
      const coherence = makeCoherence();
      const input = makePolicyInput();
      const action = makePlaceAction();

      const token1 = gate.mintToken(coherence, input, action);
      const token2 = gate.mintToken(coherence, input, action);

      expect(token1.coherenceHash).toBe(token2.coherenceHash);
      expect(token1.policyHash).toBe(token2.policyHash);
    });

    it('should produce different coherence hashes for different coherence decisions', () => {
      const gate = new ProofGate();
      const input = makePolicyInput();
      const action = makePlaceAction();

      const coherence1 = makeCoherence();
      const coherence2 = { ...makeCoherence(), driftScore: 0.99 };

      const token1 = gate.mintToken(coherence1, input, action);
      const token2 = gate.mintToken(coherence2, input, action);

      expect(token1.coherenceHash).not.toBe(token2.coherenceHash);
    });
  });

  describe('createReceipt', () => {
    it('should include all required fields in the receipt', () => {
      const gate = new ProofGate();
      const coherence = makeCoherence();
      const input = makePolicyInput();
      const action = makePlaceAction();

      const token = gate.mintToken(coherence, input, action);
      const receipt = gate.createReceipt(
        token,
        'gnn-v2',
        'input-hash-abc',
        'result-hash-def',
      );

      expect(receipt.tsNs).toBe(token.tsNs);
      expect(receipt.modelId).toBe('gnn-v2');
      expect(receipt.inputSegmentHash).toBe('input-hash-abc');
      expect(receipt.coherenceWitnessHash).toBe(token.coherenceHash);
      expect(receipt.policyHash).toBe(token.policyHash);
      expect(receipt.actionIntent).toBe(token.actionIntent);
      expect(receipt.verifiedTokenId).toBe(token.tokenId);
      expect(receipt.resultingStateHash).toBe('result-hash-def');
    });
  });

  describe('validateToken', () => {
    it('should accept a fresh token with matching coherence', () => {
      const gate = new ProofGate();
      const coherence = makeCoherence();
      const input = makePolicyInput();
      const action = makePlaceAction();

      const token = gate.mintToken(coherence, input, action);

      // Validate with current time very close to token time
      const result = gate.validateToken(token, 1001n, coherence);

      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should reject a stale token', () => {
      const gate = new ProofGate();
      const coherence = makeCoherence();
      const input = makePolicyInput();
      const action = makePlaceAction();

      const token = gate.mintToken(coherence, input, action);

      // Validate with current time far in the future (>100ms)
      const staleTsNs = token.tsNs + BigInt(200_000_000); // 200ms later
      const result = gate.validateToken(token, staleTsNs, coherence);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('stale');
    });

    it('should reject a token with mismatched coherence', () => {
      const gate = new ProofGate();
      const coherence = makeCoherence();
      const input = makePolicyInput();
      const action = makePlaceAction();

      const token = gate.mintToken(coherence, input, action);

      // Validate with different coherence
      const differentCoherence = { ...makeCoherence(), driftScore: 0.99 };
      const result = gate.validateToken(token, 1001n, differentCoherence);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Coherence hash mismatch');
    });
  });

  describe('computeHash', () => {
    it('should produce deterministic hashes', () => {
      const gate = new ProofGate();

      const hash1 = gate.computeHash('hello world');
      const hash2 = gate.computeHash('hello world');

      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64);
    });

    it('should produce different hashes for different inputs', () => {
      const gate = new ProofGate();

      const hash1 = gate.computeHash('hello');
      const hash2 = gate.computeHash('world');

      expect(hash1).not.toBe(hash2);
    });
  });
});
