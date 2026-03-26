import { createHash } from 'node:crypto';
import type {
  VerifiedToken,
  WitnessReceipt,
  CoherenceDecision,
  Timestamp,
} from '../shared/types.js';
import type { PolicyInput, ActionDecision } from './types.js';

/**
 * Compute a SHA-256 hash of the given data string.
 */
function sha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Deterministically serialize a CoherenceDecision for hashing.
 */
function serializeCoherence(c: CoherenceDecision): string {
  return [
    `allow_retrieve:${c.allowRetrieve}`,
    `allow_write:${c.allowWrite}`,
    `allow_learn:${c.allowLearn}`,
    `allow_act:${c.allowAct}`,
    `mincut:${c.mincutValue.toString()}`,
    `partition:${c.partitionHash}`,
    `drift:${c.driftScore}`,
    `cusum:${c.cusumScore}`,
    `reasons:${c.reasons.join(',')}`,
  ].join('|');
}

/**
 * Deterministically serialize a PolicyInput for hashing.
 */
function serializePolicyInput(input: PolicyInput): string {
  return [
    `ts:${input.tsNs.toString()}`,
    `coherence:${serializeCoherence(input.coherence)}`,
    `model_ts:${input.modelOutput.tsNs.toString()}`,
    `predictions:${input.modelOutput.predictions.length}`,
    `controls:${input.modelOutput.controls.map((c) => `${c.headName}:${c.value}:${c.confidence}`).join(',')}`,
    `position:${input.position.symbolId}:${input.position.netQtyFp.toString()}`,
    `venue:${input.venueState.venueId}:${input.venueState.isHalted}:${input.venueState.isHealthy}`,
  ].join('||');
}

/**
 * Deterministically serialize an ActionDecision for hashing.
 */
function serializeAction(action: ActionDecision): string {
  switch (action.type) {
    case 'place':
      return `place:${action.intent.symbolId}:${action.intent.side}:${action.intent.qtyFp.toString()}:${action.intent.orderType}`;
    case 'modify':
      return `modify:${action.intent.orderIdHash}:${action.intent.newPriceFp?.toString() ?? 'none'}:${action.intent.newQtyFp?.toString() ?? 'none'}`;
    case 'cancel':
      return `cancel:${action.intent.orderIdHash}:${action.intent.reason}`;
    case 'hold':
      return `hold:${action.reason.ruleName}:${action.reason.detail}`;
    case 'throttle':
      return `throttle:${action.resumeAfterNs.toString()}:${action.reason}`;
    case 'emergency_flatten':
      return `emergency_flatten:${action.reason}`;
  }
}

/**
 * Maximum age of a token before it is considered stale (100ms in nanoseconds).
 */
const TOKEN_MAX_AGE_NS = BigInt(100_000_000);

let tokenCounter = 0;

/**
 * Proof-gated mutation flow per ADR-004 section 4.
 *
 * Every state mutation in the trading pipeline must be accompanied by
 * a VerifiedToken proving that coherence was checked and policy rules
 * were evaluated. A WitnessReceipt provides an auditable hash chain.
 */
export class ProofGate {
  /**
   * Mint a verified token that binds a coherence decision + policy input
   * to an action decision.
   */
  mintToken(
    coherence: CoherenceDecision,
    policyInput: PolicyInput,
    actionDecision: ActionDecision,
  ): VerifiedToken {
    const coherenceHash = sha256(serializeCoherence(coherence));
    const policyHash = sha256(serializePolicyInput(policyInput));
    const actionIntent = serializeAction(actionDecision);

    tokenCounter += 1;
    const tokenId = sha256(
      `${coherenceHash}:${policyHash}:${actionIntent}:${tokenCounter}:${policyInput.tsNs.toString()}`,
    );

    return {
      tokenId,
      tsNs: policyInput.tsNs as Timestamp,
      coherenceHash,
      policyHash,
      actionIntent,
    };
  }

  /**
   * Create a witness receipt that records the full hash chain for audit.
   */
  createReceipt(
    token: VerifiedToken,
    modelId: string,
    inputHash: string,
    resultHash: string,
  ): WitnessReceipt {
    return {
      tsNs: token.tsNs,
      modelId,
      inputSegmentHash: inputHash,
      coherenceWitnessHash: token.coherenceHash,
      policyHash: token.policyHash,
      actionIntent: token.actionIntent,
      verifiedTokenId: token.tokenId,
      resultingStateHash: resultHash,
    };
  }

  /**
   * Validate that a token is not stale and that coherence matches.
   */
  validateToken(
    token: VerifiedToken,
    currentTsNs: bigint,
    expectedCoherence: CoherenceDecision,
  ): { valid: boolean; reason?: string } {
    // Check staleness
    const age = currentTsNs - token.tsNs;
    if (age > TOKEN_MAX_AGE_NS) {
      return {
        valid: false,
        reason: `Token is stale: age ${age.toString()}ns > max ${TOKEN_MAX_AGE_NS.toString()}ns`,
      };
    }

    // Check coherence hash matches
    const expectedHash = sha256(serializeCoherence(expectedCoherence));
    if (token.coherenceHash !== expectedHash) {
      return {
        valid: false,
        reason: 'Coherence hash mismatch -- decision may have changed',
      };
    }

    return { valid: true };
  }

  /**
   * Compute a SHA-256 hash of arbitrary data (exposed for external use).
   */
  computeHash(data: string): string {
    return sha256(data);
  }
}
