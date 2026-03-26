import { describe, it, expect } from 'vitest';
import { RulePolicyKernel } from '../../src/policy/policy-kernel.js';
import type { PolicyInput, VenueState, PositionSnapshot, RiskBudgetSnapshot } from '../../src/policy/types.js';
import { CONTROL_HEADS } from '../../src/policy/types.js';
import type { CoherenceDecision, SymbolId, VenueId } from '../../src/shared/types.js';
import type { ModelOutput, ControlSignal, Prediction } from '../../src/gnn/types.js';
import { Side } from '../../src/shared/types.js';

// --- Test Helpers ---

function makeCoherence(overrides: Partial<CoherenceDecision> = {}): CoherenceDecision {
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
    ...overrides,
  };
}

function makeControls(overrides: Record<string, number> = {}): ControlSignal[] {
  const defaults: Record<string, number> = {
    [CONTROL_HEADS.PLACE_SIGNAL]: 0.8,
    [CONTROL_HEADS.MODIFY_SIGNAL]: 0.1,
    [CONTROL_HEADS.CANCEL_SIGNAL]: 0.05,
    [CONTROL_HEADS.SIDE_SIGNAL]: 0.7, // Bid
    [CONTROL_HEADS.SIZE_SIGNAL]: 0.3,
    [CONTROL_HEADS.URGENCY_SIGNAL]: 0.2,
    [CONTROL_HEADS.REGIME_UNCERTAINTY]: 0.1,
    [CONTROL_HEADS.ADVERSARIAL_DRIFT]: 0.05,
  };
  const merged = { ...defaults, ...overrides };
  return Object.entries(merged).map(([headName, value]) => ({
    headName,
    value,
    confidence: 0.9,
  }));
}

function makeModelOutput(controls?: ControlSignal[]): ModelOutput {
  return {
    embeddings: [],
    predictions: [
      { headName: 'mid_return', value: 0.001, confidence: 0.85, tsNs: 1000n },
    ] as Prediction[],
    controls: controls ?? makeControls(),
    tsNs: 1000n,
  };
}

function makeVenueState(overrides: Partial<VenueState> = {}): VenueState {
  return {
    venueId: 1 as VenueId,
    isHalted: false,
    isHealthy: true,
    lastHeartbeatNs: 999n,
    ...overrides,
  };
}

function makePosition(overrides: Partial<PositionSnapshot> = {}): PositionSnapshot {
  return {
    symbolId: 1 as SymbolId,
    netQtyFp: 0n,
    avgEntryPriceFp: 0n,
    realizedPnlFp: 0n,
    unrealizedPnlFp: 0n,
    openOrderCount: 0,
    lastFillTsNs: 0n,
    ...overrides,
  };
}

function makeRiskBudget(overrides: Partial<RiskBudgetSnapshot> = {}): RiskBudgetSnapshot {
  return {
    totalNotionalUsed: 0,
    perSymbolNotional: new Map(),
    rollingOrderRate: 0,
    rollingCancelRate: 0,
    cumulativeSlippageBp: 0,
    sessionDrawdownPct: 0,
    ...overrides,
  };
}

function makeInput(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    coherence: makeCoherence(),
    modelOutput: makeModelOutput(),
    position: makePosition(),
    riskBudget: makeRiskBudget(),
    venueState: makeVenueState(),
    tsNs: 1000n,
    ...overrides,
  };
}

// --- Tests ---

describe('RulePolicyKernel', () => {
  it('should return Hold when coherence blocks action', () => {
    const kernel = new RulePolicyKernel();
    const input = makeInput({
      coherence: makeCoherence({
        allowAct: false,
        reasons: ['drift detected'],
      }),
    });

    const result = kernel.decide(input);

    expect(result.type).toBe('hold');
    if (result.type === 'hold') {
      expect(result.reason.ruleName).toBe('coherence_gate');
      expect(result.reason.detail).toContain('drift detected');
    }
  });

  it('should return Hold when regime uncertainty is high and upsize is requested', () => {
    const kernel = new RulePolicyKernel();
    const controls = makeControls({
      [CONTROL_HEADS.REGIME_UNCERTAINTY]: 0.85,
      [CONTROL_HEADS.SIZE_SIGNAL]: 0.7,
    });
    const input = makeInput({
      modelOutput: makeModelOutput(controls),
    });

    const result = kernel.decide(input);

    expect(result.type).toBe('hold');
    if (result.type === 'hold') {
      expect(result.reason.ruleName).toBe('regime_uncertainty');
    }
  });

  it('should allow action when regime uncertainty is high but size signal is low', () => {
    const kernel = new RulePolicyKernel();
    const controls = makeControls({
      [CONTROL_HEADS.REGIME_UNCERTAINTY]: 0.85,
      [CONTROL_HEADS.SIZE_SIGNAL]: 0.3, // Low size signal
    });
    const input = makeInput({
      modelOutput: makeModelOutput(controls),
    });

    const result = kernel.decide(input);

    expect(result.type).not.toBe('hold');
  });

  it('should return Hold when adversarial drift is detected', () => {
    const kernel = new RulePolicyKernel();
    const controls = makeControls({
      [CONTROL_HEADS.ADVERSARIAL_DRIFT]: 0.75,
    });
    const input = makeInput({
      modelOutput: makeModelOutput(controls),
    });

    const result = kernel.decide(input);

    expect(result.type).toBe('hold');
    if (result.type === 'hold') {
      expect(result.reason.ruleName).toBe('adversarial_drift');
    }
  });

  it('should return Hold when slippage drift exceeds threshold', () => {
    const kernel = new RulePolicyKernel();
    const input = makeInput({
      riskBudget: makeRiskBudget({ cumulativeSlippageBp: 6.0 }),
    });

    const result = kernel.decide(input);

    expect(result.type).toBe('hold');
    if (result.type === 'hold') {
      expect(result.reason.ruleName).toBe('slippage_drift');
    }
  });

  it('should return Throttle when rate limit is near capacity', () => {
    const kernel = new RulePolicyKernel();
    const input = makeInput({
      riskBudget: makeRiskBudget({ rollingOrderRate: 0.95 }),
    });

    const result = kernel.decide(input);

    expect(result.type).toBe('throttle');
    if (result.type === 'throttle') {
      expect(result.reason).toContain('Rate limit');
      expect(result.resumeAfterNs).toBeGreaterThan(input.tsNs);
    }
  });

  it('should return place when all rules pass and place signal is strongest', () => {
    const kernel = new RulePolicyKernel();
    const controls = makeControls({
      [CONTROL_HEADS.PLACE_SIGNAL]: 0.9,
      [CONTROL_HEADS.MODIFY_SIGNAL]: 0.1,
      [CONTROL_HEADS.CANCEL_SIGNAL]: 0.05,
    });
    const input = makeInput({
      modelOutput: makeModelOutput(controls),
    });

    const result = kernel.decide(input);

    expect(result.type).toBe('place');
    if (result.type === 'place') {
      expect(result.intent.symbolId).toBe(1);
      expect(result.intent.qtyFp).toBeGreaterThan(0n);
    }
  });

  it('should return cancel when cancel signal is strongest', () => {
    const kernel = new RulePolicyKernel();
    const controls = makeControls({
      [CONTROL_HEADS.PLACE_SIGNAL]: 0.1,
      [CONTROL_HEADS.MODIFY_SIGNAL]: 0.1,
      [CONTROL_HEADS.CANCEL_SIGNAL]: 0.9,
    });
    const input = makeInput({
      modelOutput: makeModelOutput(controls),
    });

    const result = kernel.decide(input);

    expect(result.type).toBe('cancel');
  });

  it('should return modify when modify signal is strongest', () => {
    const kernel = new RulePolicyKernel();
    const controls = makeControls({
      [CONTROL_HEADS.PLACE_SIGNAL]: 0.1,
      [CONTROL_HEADS.MODIFY_SIGNAL]: 0.9,
      [CONTROL_HEADS.CANCEL_SIGNAL]: 0.05,
    });
    const input = makeInput({
      modelOutput: makeModelOutput(controls),
    });

    const result = kernel.decide(input);

    expect(result.type).toBe('modify');
  });

  it('should return Hold when kill switch is active', () => {
    const kernel = new RulePolicyKernel(() => true);
    const input = makeInput();

    const result = kernel.decide(input);

    expect(result.type).toBe('hold');
    if (result.type === 'hold') {
      expect(result.reason.ruleName).toBe('kill_switch');
    }
  });

  it('should return Hold when venue is halted', () => {
    const kernel = new RulePolicyKernel();
    const input = makeInput({
      venueState: makeVenueState({ isHalted: true }),
    });

    const result = kernel.decide(input);

    expect(result.type).toBe('hold');
    if (result.type === 'hold') {
      expect(result.reason.ruleName).toBe('venue_health');
    }
  });

  it('should return Hold when venue is unhealthy', () => {
    const kernel = new RulePolicyKernel();
    const input = makeInput({
      venueState: makeVenueState({ isHealthy: false }),
    });

    const result = kernel.decide(input);

    expect(result.type).toBe('hold');
    if (result.type === 'hold') {
      expect(result.reason.ruleName).toBe('venue_health');
    }
  });

  it('should return Hold when all control signals are near zero', () => {
    const kernel = new RulePolicyKernel();
    const controls = makeControls({
      [CONTROL_HEADS.PLACE_SIGNAL]: 0.01,
      [CONTROL_HEADS.MODIFY_SIGNAL]: 0.02,
      [CONTROL_HEADS.CANCEL_SIGNAL]: 0.01,
    });
    const input = makeInput({
      modelOutput: makeModelOutput(controls),
    });

    const result = kernel.decide(input);

    expect(result.type).toBe('hold');
    if (result.type === 'hold') {
      expect(result.reason.ruleName).toBe('no_signal');
    }
  });

  it('should prioritize coherence gate over regime uncertainty', () => {
    const kernel = new RulePolicyKernel();
    const controls = makeControls({
      [CONTROL_HEADS.REGIME_UNCERTAINTY]: 0.9,
      [CONTROL_HEADS.SIZE_SIGNAL]: 0.8,
    });
    const input = makeInput({
      coherence: makeCoherence({ allowAct: false, reasons: ['blocked'] }),
      modelOutput: makeModelOutput(controls),
    });

    const result = kernel.decide(input);

    expect(result.type).toBe('hold');
    if (result.type === 'hold') {
      expect(result.reason.ruleName).toBe('coherence_gate');
    }
  });

  it('should set IOC order type when urgency is high', () => {
    const kernel = new RulePolicyKernel();
    const controls = makeControls({
      [CONTROL_HEADS.PLACE_SIGNAL]: 0.9,
      [CONTROL_HEADS.URGENCY_SIGNAL]: 0.9,
    });
    const input = makeInput({
      modelOutput: makeModelOutput(controls),
    });

    const result = kernel.decide(input);

    expect(result.type).toBe('place');
    if (result.type === 'place') {
      expect(result.intent.orderType).toBe('ioc');
      expect(result.intent.timeInForce).toBe('fok');
    }
  });
});
