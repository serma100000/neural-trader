import { describe, it, expect } from 'vitest';
import {
  huberLoss,
  binaryCrossEntropy,
  crossEntropyLoss,
  quantileLoss,
  compositeLoss,
} from '../../src/training/loss.js';
import type { WindowLabels } from '../../src/training/types.js';

describe('huberLoss', () => {
  it('should return 0 when predicted equals target', () => {
    expect(huberLoss(5, 5)).toBe(0);
  });

  it('should be quadratic for small errors', () => {
    const error = 0.5;
    const loss = huberLoss(0, error, 1.0);
    expect(loss).toBeCloseTo(0.5 * error * error, 6);
  });

  it('should be linear for large errors', () => {
    const delta = 1.0;
    const predicted = 0;
    const target = 5;
    const loss = huberLoss(predicted, target, delta);
    // For |error|=5, delta=1: delta*(|error|-0.5*delta) = 1*(5-0.5) = 4.5
    expect(loss).toBeCloseTo(4.5, 6);
  });

  it('should be symmetric', () => {
    expect(huberLoss(3, 5)).toBeCloseTo(huberLoss(5, 3), 6);
  });

  it('should transition smoothly at delta boundary', () => {
    const delta = 1.0;
    // Just below delta
    const lossBelow = huberLoss(0, 0.99, delta);
    // Just above delta
    const lossAbove = huberLoss(0, 1.01, delta);
    // They should be close to each other
    expect(Math.abs(lossAbove - lossBelow)).toBeLessThan(0.05);
  });
});

describe('binaryCrossEntropy', () => {
  it('should return near 0 when prediction matches target=1', () => {
    const loss = binaryCrossEntropy(0.999, 1);
    expect(loss).toBeLessThan(0.01);
  });

  it('should return near 0 when prediction matches target=0', () => {
    const loss = binaryCrossEntropy(0.001, 0);
    expect(loss).toBeLessThan(0.01);
  });

  it('should return high loss for wrong prediction', () => {
    const loss = binaryCrossEntropy(0.01, 1);
    expect(loss).toBeGreaterThan(2);
  });

  it('should be non-negative', () => {
    for (let p = 0.01; p < 1.0; p += 0.1) {
      expect(binaryCrossEntropy(p, 0)).toBeGreaterThanOrEqual(0);
      expect(binaryCrossEntropy(p, 1)).toBeGreaterThanOrEqual(0);
    }
  });

  it('should handle extreme predictions without NaN', () => {
    expect(Number.isFinite(binaryCrossEntropy(0, 1))).toBe(true);
    expect(Number.isFinite(binaryCrossEntropy(1, 0))).toBe(true);
  });
});

describe('crossEntropyLoss', () => {
  it('should return near 0 for perfect prediction', () => {
    const probs = new Float32Array([0.001, 0.998, 0.001]);
    const loss = crossEntropyLoss(probs, 1);
    expect(loss).toBeLessThan(0.01);
  });

  it('should return high loss for wrong class', () => {
    const probs = new Float32Array([0.01, 0.01, 0.98]);
    const loss = crossEntropyLoss(probs, 0);
    expect(loss).toBeGreaterThan(2);
  });

  it('should return -log(1/3) for uniform distribution', () => {
    const probs = new Float32Array([1 / 3, 1 / 3, 1 / 3]);
    const loss = crossEntropyLoss(probs, 0);
    expect(loss).toBeCloseTo(Math.log(3), 4);
  });

  it('should be non-negative', () => {
    const probs = new Float32Array([0.2, 0.5, 0.3]);
    for (let i = 0; i < 3; i++) {
      expect(crossEntropyLoss(probs, i)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('quantileLoss', () => {
  it('should return 0 when predicted equals target', () => {
    expect(quantileLoss(5, 5, 0.5)).toBe(0);
  });

  it('should penalize under-prediction more at high tau', () => {
    const tau = 0.9;
    const underPredLoss = quantileLoss(3, 5, tau); // under-predicted
    const overPredLoss = quantileLoss(7, 5, tau);   // over-predicted
    expect(underPredLoss).toBeGreaterThan(overPredLoss);
  });

  it('should be symmetric at tau=0.5', () => {
    const underLoss = quantileLoss(3, 5, 0.5);
    const overLoss = quantileLoss(7, 5, 0.5);
    expect(underLoss).toBeCloseTo(overLoss, 6);
  });

  it('should be non-negative', () => {
    for (let tau = 0.1; tau <= 0.9; tau += 0.1) {
      expect(quantileLoss(3, 5, tau)).toBeGreaterThanOrEqual(0);
      expect(quantileLoss(7, 5, tau)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('compositeLoss', () => {
  it('should aggregate per-head losses correctly', () => {
    const predictions = new Map<string, number>([
      ['mid_price', 0.5],
      ['fill_prob', 0.5],
      ['cancel_prob', 0.5],
      ['slippage', 0.5],
      ['vol_jump', 0.5],
    ]);

    const labels: WindowLabels = {
      midPriceMoveBp: 1.0,
      fillOccurred: true,
      cancelOccurred: false,
      slippageBp: 1.0,
      volJump: false,
      regimeLabel: 1,
    };

    const regimeProbs = new Float32Array([0.2, 0.6, 0.2]);

    const result = compositeLoss(
      predictions,
      labels,
      { fill: 1.0, risk: 2.0 },
      regimeProbs,
    );

    expect(result.total).toBeGreaterThan(0);
    expect(result.perHead.size).toBeGreaterThan(0);

    // Total should be sum of per-head losses
    let sum = 0;
    for (const loss of result.perHead.values()) {
      sum += loss;
    }
    expect(result.total).toBeCloseTo(sum, 6);
  });

  it('should weight fill heads by lambdaFill', () => {
    const predictions = new Map<string, number>([
      ['fill_prob', 0.5],
    ]);
    const labels: WindowLabels = {
      midPriceMoveBp: 0,
      fillOccurred: true,
      cancelOccurred: false,
      slippageBp: 0,
      volJump: false,
      regimeLabel: 0,
    };

    const result1 = compositeLoss(predictions, labels, { fill: 1.0, risk: 1.0 });
    const result2 = compositeLoss(predictions, labels, { fill: 2.0, risk: 1.0 });

    expect(result2.total).toBeCloseTo(result1.total * 2, 4);
  });

  it('should weight risk heads by lambdaRisk', () => {
    const predictions = new Map<string, number>([
      ['vol_jump', 0.5],
    ]);
    const labels: WindowLabels = {
      midPriceMoveBp: 0,
      fillOccurred: false,
      cancelOccurred: false,
      slippageBp: 0,
      volJump: true,
      regimeLabel: 0,
    };

    const result1 = compositeLoss(predictions, labels, { fill: 1.0, risk: 1.0 });
    const result2 = compositeLoss(predictions, labels, { fill: 1.0, risk: 3.0 });

    expect(result2.total).toBeCloseTo(result1.total * 3, 4);
  });

  it('should handle missing heads gracefully', () => {
    const predictions = new Map<string, number>([
      ['mid_price', 1.0],
    ]);
    const labels: WindowLabels = {
      midPriceMoveBp: 0,
      fillOccurred: false,
      cancelOccurred: false,
      slippageBp: 0,
      volJump: false,
      regimeLabel: 0,
    };

    const result = compositeLoss(predictions, labels, { fill: 1.0, risk: 1.0 });
    expect(result.perHead.size).toBe(1);
    expect(result.perHead.has('mid_price')).toBe(true);
  });
});
