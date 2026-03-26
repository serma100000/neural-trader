import { describe, it, expect } from 'vitest';
import {
  MidPriceHead,
  FillProbHead,
  CancelProbHead,
  SlippageHead,
  VolJumpHead,
  RegimeTransitionHead,
  createAllPredictionHeads,
} from '../../src/heads/prediction-heads.js';
import { TOTAL_EMBEDDING_DIM } from '../../src/gnn/types.js';

function randomEmbedding(dim: number = TOTAL_EMBEDDING_DIM): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    v[i] = Math.random() * 2 - 1;
  }
  return v;
}

describe('MidPriceHead', () => {
  it('should produce a prediction with correct head name', () => {
    const head = new MidPriceHead();
    const pred = head.predict(randomEmbedding());
    expect(pred.headName).toBe('mid_price');
    expect(typeof pred.value).toBe('number');
    expect(pred.confidence).toBeGreaterThanOrEqual(0);
    expect(pred.confidence).toBeLessThanOrEqual(1);
    expect(typeof pred.tsNs).toBe('bigint');
  });

  it('should accept custom input dimension', () => {
    const head = new MidPriceHead(64);
    const pred = head.predict(randomEmbedding(64));
    expect(pred.headName).toBe('mid_price');
  });
});

describe('FillProbHead', () => {
  it('should produce probability in [0, 1]', () => {
    const head = new FillProbHead();
    const pred = head.predict(randomEmbedding());
    expect(pred.headName).toBe('fill_prob');
    expect(pred.value).toBeGreaterThanOrEqual(0);
    expect(pred.value).toBeLessThanOrEqual(1);
    expect(pred.confidence).toBeGreaterThanOrEqual(0);
    expect(pred.confidence).toBeLessThanOrEqual(1);
  });
});

describe('CancelProbHead', () => {
  it('should produce probability in [0, 1]', () => {
    const head = new CancelProbHead();
    const pred = head.predict(randomEmbedding());
    expect(pred.headName).toBe('cancel_prob');
    expect(pred.value).toBeGreaterThanOrEqual(0);
    expect(pred.value).toBeLessThanOrEqual(1);
  });
});

describe('SlippageHead', () => {
  it('should produce non-negative slippage (softplus)', () => {
    const head = new SlippageHead();
    const pred = head.predict(randomEmbedding());
    expect(pred.headName).toBe('slippage');
    expect(pred.value).toBeGreaterThanOrEqual(0);
    expect(pred.confidence).toBeGreaterThanOrEqual(0);
    expect(pred.confidence).toBeLessThanOrEqual(1);
  });
});

describe('VolJumpHead', () => {
  it('should produce probability in [0, 1]', () => {
    const head = new VolJumpHead();
    const pred = head.predict(randomEmbedding());
    expect(pred.headName).toBe('vol_jump');
    expect(pred.value).toBeGreaterThanOrEqual(0);
    expect(pred.value).toBeLessThanOrEqual(1);
  });
});

describe('RegimeTransitionHead', () => {
  it('should produce regime index in {0, 1, 2}', () => {
    const head = new RegimeTransitionHead();
    const pred = head.predict(randomEmbedding());
    expect(pred.headName).toBe('regime_transition');
    expect([0, 1, 2]).toContain(pred.value);
    expect(pred.confidence).toBeGreaterThanOrEqual(0);
    expect(pred.confidence).toBeLessThanOrEqual(1);
  });
});

describe('createAllPredictionHeads', () => {
  it('should create all 6 prediction heads', () => {
    const heads = createAllPredictionHeads();
    expect(heads.length).toBe(6);

    const names = heads.map((h) => h.name);
    expect(names).toContain('mid_price');
    expect(names).toContain('fill_prob');
    expect(names).toContain('cancel_prob');
    expect(names).toContain('slippage');
    expect(names).toContain('vol_jump');
    expect(names).toContain('regime_transition');
  });

  it('should all produce predictions from the same embedding', () => {
    const heads = createAllPredictionHeads();
    const embedding = randomEmbedding();

    for (const head of heads) {
      const pred = head.predict(embedding);
      expect(pred.headName).toBe(head.name);
      expect(typeof pred.value).toBe('number');
      expect(Number.isFinite(pred.value)).toBe(true);
      expect(pred.confidence).toBeGreaterThanOrEqual(0);
      expect(pred.confidence).toBeLessThanOrEqual(1);
    }
  });
});
