import { describe, it, expect } from 'vitest';
import { MessagePassingLayer, StackedMessagePassing } from '../../src/gnn/message-passing.js';

function randomFeatures(numNodes: number, dim: number): Float32Array[] {
  const features: Float32Array[] = [];
  for (let i = 0; i < numNodes; i++) {
    const f = new Float32Array(dim);
    for (let j = 0; j < dim; j++) {
      f[j] = Math.random() * 2 - 1;
    }
    features.push(f);
  }
  return features;
}

describe('MessagePassingLayer', () => {
  it('should produce output with correct dimensions', () => {
    const inputDim = 17;
    const outputDim = 64;
    const numEdgeTypes = 12;
    const layer = new MessagePassingLayer(inputDim, outputDim, numEdgeTypes);

    const nodeFeatures = randomFeatures(5, inputDim);
    const edgeIndex: [number, number][] = [
      [0, 1], [1, 2], [2, 3], [3, 4], [4, 0],
    ];
    const edgeTypes = [0, 1, 2, 3, 4];

    const output = layer.forward(nodeFeatures, edgeIndex, edgeTypes);

    expect(output.length).toBe(5);
    for (const feat of output) {
      expect(feat.length).toBe(outputDim);
    }
  });

  it('should produce non-negative outputs due to ReLU', () => {
    const layer = new MessagePassingLayer(8, 16, 4);
    const features = randomFeatures(3, 8);
    const edges: [number, number][] = [[0, 1], [1, 2], [2, 0]];
    const types = [0, 1, 2];

    const output = layer.forward(features, edges, types);
    for (const feat of output) {
      for (let i = 0; i < feat.length; i++) {
        expect(feat[i]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('should handle nodes with no incoming edges', () => {
    const layer = new MessagePassingLayer(4, 8, 2);
    const features = randomFeatures(3, 4);
    // Only edges to node 1, nodes 0 and 2 have no incoming
    const edges: [number, number][] = [[0, 1], [2, 1]];
    const types = [0, 1];

    const output = layer.forward(features, edges, types);
    expect(output.length).toBe(3);
    // All nodes should still get self-loop transform
    for (const feat of output) {
      expect(feat.length).toBe(8);
    }
  });

  it('should handle empty graph', () => {
    const layer = new MessagePassingLayer(4, 8, 2);
    const output = layer.forward([], [], []);
    expect(output.length).toBe(0);
  });

  it('should report correct dimensions', () => {
    const layer = new MessagePassingLayer(17, 64, 12);
    expect(layer.getInputDim()).toBe(17);
    expect(layer.getOutputDim()).toBe(64);
  });
});

describe('StackedMessagePassing', () => {
  it('should produce correct output dimensions with multiple rounds', () => {
    const stacked = new StackedMessagePassing(17, 64, 128, 12, 2);
    const features = randomFeatures(4, 17);
    const edges: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 0]];
    const types = [0, 1, 2, 3];

    const output = stacked.forward(features, edges, types);

    expect(output.length).toBe(4);
    for (const feat of output) {
      expect(feat.length).toBe(128);
    }
  });

  it('should report correct number of rounds', () => {
    const stacked = new StackedMessagePassing(8, 16, 32, 4, 3);
    expect(stacked.getRounds()).toBe(3);
  });

  it('should work with a single round', () => {
    const stacked = new StackedMessagePassing(8, 16, 16, 4, 1);
    const features = randomFeatures(2, 8);
    const edges: [number, number][] = [[0, 1]];
    const types = [0];

    const output = stacked.forward(features, edges, types);
    expect(output.length).toBe(2);
    expect(output[0].length).toBe(16);
  });
});
