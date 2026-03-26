import type { WindowLabels } from './types.js';

/**
 * Huber loss (smooth L1). Quadratic for small errors, linear for large.
 *
 * @param predicted - Predicted value
 * @param target - Target value
 * @param delta - Threshold between quadratic and linear regimes (default 1.0)
 */
export function huberLoss(
  predicted: number,
  target: number,
  delta: number = 1.0,
): number {
  const error = Math.abs(predicted - target);
  if (error <= delta) {
    return 0.5 * error * error;
  }
  return delta * (error - 0.5 * delta);
}

/**
 * Binary cross-entropy loss for probability predictions.
 * Clamps predicted to [eps, 1-eps] for numerical stability.
 *
 * @param predicted - Predicted probability in [0, 1]
 * @param target - Target label (0 or 1)
 */
export function binaryCrossEntropy(
  predicted: number,
  target: number,
): number {
  const eps = 1e-7;
  const p = Math.max(eps, Math.min(1 - eps, predicted));
  return -(target * Math.log(p) + (1 - target) * Math.log(1 - p));
}

/**
 * Categorical cross-entropy loss.
 * Clamps probabilities to [eps, 1] for numerical stability.
 *
 * @param predicted - Predicted probability distribution (sums to ~1)
 * @param targetClass - Index of the true class
 */
export function crossEntropyLoss(
  predicted: Float32Array,
  targetClass: number,
): number {
  const eps = 1e-7;
  const p = Math.max(eps, predicted[targetClass]);
  return -Math.log(p);
}

/**
 * Quantile loss (pinball loss) for asymmetric error penalization.
 *
 * @param predicted - Predicted value
 * @param target - Target value
 * @param tau - Quantile level (default 0.5 = median, >0.5 penalizes under-prediction more)
 */
export function quantileLoss(
  predicted: number,
  target: number,
  tau: number = 0.5,
): number {
  const error = target - predicted;
  if (error >= 0) {
    return tau * error;
  }
  return (tau - 1) * error;
}

/**
 * Composite loss that aggregates individual head losses with configurable weights.
 *
 * Head mapping:
 * - mid_price: Huber loss
 * - fill_prob: Binary cross-entropy (weighted by lambdaFill)
 * - cancel_prob: Binary cross-entropy (weighted by lambdaFill)
 * - slippage: Quantile loss (weighted by lambdaRisk)
 * - vol_jump: Binary cross-entropy (weighted by lambdaRisk)
 * - regime_transition: Cross-entropy loss
 *
 * @param predictions - Map of head name to predicted value
 * @param labels - Ground truth labels for the window
 * @param lambdas - Loss weights for fill and risk heads
 * @returns Total loss and per-head breakdown
 */
export function compositeLoss(
  predictions: Map<string, number>,
  labels: WindowLabels,
  lambdas: { fill: number; risk: number },
  regimeProbs?: Float32Array,
): { total: number; perHead: Map<string, number> } {
  const perHead = new Map<string, number>();
  let total = 0;

  // Mid-price: Huber loss
  const midPred = predictions.get('mid_price');
  if (midPred !== undefined) {
    const loss = huberLoss(midPred, labels.midPriceMoveBp);
    perHead.set('mid_price', loss);
    total += loss;
  }

  // Fill probability: BCE
  const fillPred = predictions.get('fill_prob');
  if (fillPred !== undefined) {
    const loss =
      binaryCrossEntropy(fillPred, labels.fillOccurred ? 1 : 0) *
      lambdas.fill;
    perHead.set('fill_prob', loss);
    total += loss;
  }

  // Cancel probability: BCE
  const cancelPred = predictions.get('cancel_prob');
  if (cancelPred !== undefined) {
    const loss =
      binaryCrossEntropy(cancelPred, labels.cancelOccurred ? 1 : 0) *
      lambdas.fill;
    perHead.set('cancel_prob', loss);
    total += loss;
  }

  // Slippage: Quantile loss (tau=0.75 to penalize under-prediction of slippage)
  const slippagePred = predictions.get('slippage');
  if (slippagePred !== undefined) {
    const loss =
      quantileLoss(slippagePred, labels.slippageBp, 0.75) * lambdas.risk;
    perHead.set('slippage', loss);
    total += loss;
  }

  // Vol jump: BCE
  const volPred = predictions.get('vol_jump');
  if (volPred !== undefined) {
    const loss =
      binaryCrossEntropy(volPred, labels.volJump ? 1 : 0) * lambdas.risk;
    perHead.set('vol_jump', loss);
    total += loss;
  }

  // Regime transition: cross-entropy
  if (regimeProbs) {
    const loss = crossEntropyLoss(regimeProbs, labels.regimeLabel);
    perHead.set('regime_transition', loss);
    total += loss;
  } else {
    const regimePred = predictions.get('regime_transition');
    if (regimePred !== undefined) {
      // Approximate: treat argmax prediction as 1-hot
      const loss = regimePred === labels.regimeLabel ? 0 : 1;
      perHead.set('regime_transition', loss);
      total += loss;
    }
  }

  return { total, perHead };
}
