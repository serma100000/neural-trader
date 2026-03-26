import { describe, it, expect } from 'vitest';
import { MLP } from '../../src/heads/mlp.js';

function randomInput(dim: number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    v[i] = Math.random() * 2 - 1;
  }
  return v;
}

describe('MLP', () => {
  it('should produce correct output dimension', () => {
    const mlp = new MLP([64, 32, 1]);
    const output = mlp.forward(randomInput(64));
    expect(output.length).toBe(1);
  });

  it('should support multi-layer architectures', () => {
    const mlp = new MLP([128, 64, 32, 16, 8]);
    const output = mlp.forward(randomInput(128));
    expect(output.length).toBe(8);
    expect(mlp.getNumLayers()).toBe(5);
    expect(mlp.getInputDim()).toBe(128);
    expect(mlp.getOutputDim()).toBe(8);
  });

  it('should throw for less than 2 layers', () => {
    expect(() => new MLP([64])).toThrow();
  });

  it('should produce finite outputs', () => {
    const mlp = new MLP([32, 16, 4]);
    const output = mlp.forward(randomInput(32));
    for (let i = 0; i < output.length; i++) {
      expect(Number.isFinite(output[i])).toBe(true);
    }
  });

  describe('activation functions', () => {
    it('should apply relu (hidden)', () => {
      const mlp = new MLP([8, 4, 1], 'relu', 'linear');
      const output = mlp.forward(randomInput(8));
      expect(output.length).toBe(1);
      expect(Number.isFinite(output[0])).toBe(true);
    });

    it('should apply sigmoid (output)', () => {
      const mlp = new MLP([8, 4, 1], 'relu', 'sigmoid');
      // Run many times to check output is always in [0, 1]
      for (let trial = 0; trial < 20; trial++) {
        const output = mlp.forward(randomInput(8));
        expect(output[0]).toBeGreaterThanOrEqual(0);
        expect(output[0]).toBeLessThanOrEqual(1);
      }
    });

    it('should apply softplus (non-negative output)', () => {
      const mlp = new MLP([8, 4, 1], 'relu', 'softplus');
      for (let trial = 0; trial < 20; trial++) {
        const output = mlp.forward(randomInput(8));
        expect(output[0]).toBeGreaterThanOrEqual(0);
      }
    });

    it('should apply softmax (sums to 1)', () => {
      const mlp = new MLP([8, 4, 3], 'relu', 'softmax');
      const output = mlp.forward(randomInput(8));
      expect(output.length).toBe(3);
      let sum = 0;
      for (let i = 0; i < output.length; i++) {
        expect(output[i]).toBeGreaterThanOrEqual(0);
        expect(output[i]).toBeLessThanOrEqual(1);
        sum += output[i];
      }
      expect(sum).toBeCloseTo(1, 5);
    });

    it('should apply gelu', () => {
      const mlp = new MLP([8, 4, 2], 'gelu', 'linear');
      const output = mlp.forward(randomInput(8));
      expect(output.length).toBe(2);
      for (let i = 0; i < output.length; i++) {
        expect(Number.isFinite(output[i])).toBe(true);
      }
    });

    it('should apply linear (identity) output', () => {
      const mlp = new MLP([4, 2], 'relu', 'linear');
      const output = mlp.forward(randomInput(4));
      expect(output.length).toBe(2);
      // Linear can produce any value
      for (let i = 0; i < output.length; i++) {
        expect(Number.isFinite(output[i])).toBe(true);
      }
    });
  });

  it('should handle large input dimensions', () => {
    const mlp = new MLP([512, 256, 1], 'relu', 'sigmoid');
    const output = mlp.forward(randomInput(512));
    expect(output.length).toBe(1);
    expect(output[0]).toBeGreaterThanOrEqual(0);
    expect(output[0]).toBeLessThanOrEqual(1);
  });
});
