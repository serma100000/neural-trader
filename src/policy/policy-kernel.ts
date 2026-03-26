import type { Side, SymbolId, VenueId } from '../shared/types.js';
import type { ControlSignal } from '../gnn/types.js';
import type {
  PolicyInput,
  ActionDecision,
  OrderIntent,
  HoldReason,
} from './types.js';
import { CONTROL_HEADS } from './types.js';

/**
 * Policy rule evaluated in priority order.
 * First blocking rule wins and produces a Hold or Throttle decision.
 */
interface PolicyRule {
  name: string;
  evaluate(input: PolicyInput): ActionDecision | null;
}

/**
 * Extracts a control signal value by head name.
 * Returns 0 if the head is not present.
 */
function getControl(controls: ControlSignal[], headName: string): number {
  const signal = controls.find((c) => c.headName === headName);
  return signal?.value ?? 0;
}

function getControlConfidence(
  controls: ControlSignal[],
  headName: string,
): number {
  const signal = controls.find((c) => c.headName === headName);
  return signal?.confidence ?? 0;
}

// --- Rule 1: Coherence Gate ---

const coherenceGateRule: PolicyRule = {
  name: 'coherence_gate',
  evaluate(input: PolicyInput): ActionDecision | null {
    if (!input.coherence.allowAct) {
      return {
        type: 'hold',
        reason: {
          ruleName: 'coherence_gate',
          detail: `Coherence blocked action: ${input.coherence.reasons.join('; ')}`,
        },
      };
    }
    return null;
  },
};

// --- Rule 2: Regime Uncertainty ---

const REGIME_UNCERTAINTY_THRESHOLD = 0.7;

const regimeUncertaintyRule: PolicyRule = {
  name: 'regime_uncertainty',
  evaluate(input: PolicyInput): ActionDecision | null {
    const uncertainty = getControl(
      input.modelOutput.controls,
      CONTROL_HEADS.REGIME_UNCERTAINTY,
    );
    const sizeSignal = getControl(
      input.modelOutput.controls,
      CONTROL_HEADS.SIZE_SIGNAL,
    );

    // Block if regime is uncertain AND the model wants to upsize
    if (uncertainty > REGIME_UNCERTAINTY_THRESHOLD && sizeSignal > 0.5) {
      return {
        type: 'hold',
        reason: {
          ruleName: 'regime_uncertainty',
          detail: `Regime uncertainty ${uncertainty.toFixed(3)} > ${REGIME_UNCERTAINTY_THRESHOLD} with upsize signal ${sizeSignal.toFixed(3)}`,
        },
      };
    }
    return null;
  },
};

// --- Rule 3: Adversarial Drift ---

const ADVERSARIAL_DRIFT_THRESHOLD = 0.6;

const adversarialDriftRule: PolicyRule = {
  name: 'adversarial_drift',
  evaluate(input: PolicyInput): ActionDecision | null {
    const drift = getControl(
      input.modelOutput.controls,
      CONTROL_HEADS.ADVERSARIAL_DRIFT,
    );

    if (drift > ADVERSARIAL_DRIFT_THRESHOLD) {
      return {
        type: 'hold',
        reason: {
          ruleName: 'adversarial_drift',
          detail: `Adversarial drift ${drift.toFixed(3)} > ${ADVERSARIAL_DRIFT_THRESHOLD}`,
        },
      };
    }
    return null;
  },
};

// --- Rule 4: Slippage Drift ---

const SLIPPAGE_DRIFT_THRESHOLD_BP = 5.0;

const slippageDriftRule: PolicyRule = {
  name: 'slippage_drift',
  evaluate(input: PolicyInput): ActionDecision | null {
    if (
      input.riskBudget.cumulativeSlippageBp > SLIPPAGE_DRIFT_THRESHOLD_BP
    ) {
      return {
        type: 'hold',
        reason: {
          ruleName: 'slippage_drift',
          detail: `Cumulative slippage ${input.riskBudget.cumulativeSlippageBp.toFixed(2)}bp > ${SLIPPAGE_DRIFT_THRESHOLD_BP}bp`,
        },
      };
    }
    return null;
  },
};

// --- Rule 5: Rate Throttle ---

const rateThrottleRule: PolicyRule = {
  name: 'rate_throttle',
  evaluate(input: PolicyInput): ActionDecision | null {
    // Check order rate approaching limit (within 90% of capacity)
    const orderRateRatio = input.riskBudget.rollingOrderRate;
    const cancelRateRatio = input.riskBudget.rollingCancelRate;

    if (orderRateRatio > 0.9 || cancelRateRatio > 0.9) {
      const throttleDurationNs = BigInt(1_000_000_000); // 1 second
      return {
        type: 'throttle',
        resumeAfterNs: input.tsNs + throttleDurationNs,
        reason: `Rate limit approaching: orders=${orderRateRatio.toFixed(2)}, cancels=${cancelRateRatio.toFixed(2)}`,
      };
    }
    return null;
  },
};

// --- Ordered rule chain ---

const RULE_CHAIN: PolicyRule[] = [
  coherenceGateRule,
  regimeUncertaintyRule,
  adversarialDriftRule,
  slippageDriftRule,
  rateThrottleRule,
];

/**
 * Maps model control head signals to an ActionDecision when all rules pass.
 */
function mapControlsToAction(input: PolicyInput): ActionDecision {
  const controls = input.modelOutput.controls;

  const placeSignal = getControl(controls, CONTROL_HEADS.PLACE_SIGNAL);
  const modifySignal = getControl(controls, CONTROL_HEADS.MODIFY_SIGNAL);
  const cancelSignal = getControl(controls, CONTROL_HEADS.CANCEL_SIGNAL);

  // Highest signal wins
  const signals = [
    { type: 'place' as const, value: placeSignal },
    { type: 'modify' as const, value: modifySignal },
    { type: 'cancel' as const, value: cancelSignal },
  ];
  signals.sort((a, b) => b.value - a.value);
  const winner = signals[0];

  // If all signals are near zero, hold
  if (winner.value < 0.1) {
    return {
      type: 'hold',
      reason: {
        ruleName: 'no_signal',
        detail: 'All control signals below threshold',
      },
    };
  }

  if (winner.type === 'place') {
    return buildPlaceDecision(input);
  }

  if (winner.type === 'modify') {
    return buildModifyDecision(input);
  }

  return buildCancelDecision(input);
}

function buildPlaceDecision(input: PolicyInput): ActionDecision {
  const controls = input.modelOutput.controls;
  const sideValue = getControl(controls, CONTROL_HEADS.SIDE_SIGNAL);
  const sizeValue = getControl(controls, CONTROL_HEADS.SIZE_SIGNAL);
  const urgencyValue = getControl(controls, CONTROL_HEADS.URGENCY_SIGNAL);

  const side: Side = sideValue > 0.5 ? (0 as Side) : (1 as Side); // Bid=0, Ask=1

  // Size as fraction of max, converted to fixed-point
  const sizeClipped = Math.max(0.01, Math.min(1.0, sizeValue));
  const qtyFp = BigInt(Math.round(sizeClipped * 1_000_000));

  // Determine order type based on urgency
  let orderType: OrderIntent['orderType'] = 'limit';
  if (urgencyValue > 0.8) {
    orderType = 'ioc';
  } else if (urgencyValue > 0.5) {
    orderType = 'marketable_limit';
  }

  const intent: OrderIntent = {
    symbolId: input.position.symbolId,
    venueId: input.venueState.venueId,
    side,
    priceFp: 0n, // Price determined downstream by execution layer
    qtyFp,
    orderType,
    timeInForce: orderType === 'ioc' ? 'fok' : 'day',
  };

  return { type: 'place', intent };
}

function buildModifyDecision(input: PolicyInput): ActionDecision {
  return {
    type: 'modify',
    intent: {
      orderIdHash: '', // Filled by execution layer with best candidate
      newPriceFp: undefined,
      newQtyFp: undefined,
    },
  };
}

function buildCancelDecision(input: PolicyInput): ActionDecision {
  return {
    type: 'cancel',
    intent: {
      orderIdHash: '', // Filled by execution layer
      reason: 'Model cancel signal triggered',
    },
  };
}

/**
 * Stateless policy kernel that evaluates rules in priority order
 * and maps model output to action decisions.
 *
 * Per ADR-004 Section 1: Rule chain evaluation, first blocking rule wins.
 */
export class RulePolicyKernel {
  private readonly killSwitchCheck: () => boolean;

  constructor(killSwitchCheck?: () => boolean) {
    this.killSwitchCheck = killSwitchCheck ?? (() => false);
  }

  /**
   * Evaluate policy rules and produce an action decision.
   * Pure function of inputs -- no side effects.
   */
  decide(input: PolicyInput): ActionDecision {
    // Kill switch takes absolute priority
    if (this.killSwitchCheck()) {
      return {
        type: 'hold',
        reason: {
          ruleName: 'kill_switch',
          detail: 'Kill switch is active -- all trading halted',
        },
      };
    }

    // Venue health check
    if (input.venueState.isHalted || !input.venueState.isHealthy) {
      return {
        type: 'hold',
        reason: {
          ruleName: 'venue_health',
          detail: input.venueState.isHalted
            ? 'Venue is halted'
            : 'Venue is unhealthy',
        },
      };
    }

    // Evaluate rule chain in priority order
    for (const rule of RULE_CHAIN) {
      const result = rule.evaluate(input);
      if (result !== null) {
        return result;
      }
    }

    // All rules passed -- map controls to action
    return mapControlsToAction(input);
  }
}
