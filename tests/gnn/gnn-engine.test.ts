import { describe, it, expect } from 'vitest';
import { GnnEngine } from '../../src/gnn/gnn-engine.js';
import { TOTAL_EMBEDDING_DIM, EMBEDDING_FAMILIES } from '../../src/gnn/types.js';
import { NodeKind, EdgeKind } from '../../src/shared/types.js';
import type { Neighborhood } from '../../src/graph/types.js';

function mockNeighborhood(numNodes: number, numEdges: number): Neighborhood {
  const nodeIds: bigint[] = [];
  const nodeKinds: NodeKind[] = [];
  const features: Float64Array[] = [];

  const kindRotation = [
    NodeKind.Symbol, NodeKind.PriceLevel, NodeKind.Order,
    NodeKind.Trade, NodeKind.Event, NodeKind.Regime,
  ];

  for (let i = 0; i < numNodes; i++) {
    nodeIds.push(BigInt(i + 1));
    nodeKinds.push(kindRotation[i % kindRotation.length]);
    const feat = new Float64Array(17);
    for (let j = 0; j < 17; j++) {
      feat[j] = Math.random() * 2 - 1;
    }
    features.push(feat);
  }

  const edgeIndex: [number, number][] = [];
  const edgeKinds: EdgeKind[] = [];
  const edgeFeatures: Float64Array[] = [];

  for (let i = 0; i < numEdges; i++) {
    const src = i % numNodes;
    const tgt = (i + 1) % numNodes;
    edgeIndex.push([src, tgt]);
    edgeKinds.push((i % 12) as EdgeKind);
    edgeFeatures.push(new Float64Array([i * 0.1, 0.5, 1.0, 0.0]));
  }

  return { nodeIds, nodeKinds, features, edgeIndex, edgeKinds, edgeFeatures };
}

describe('GnnEngine', () => {
  it('should produce 512-dimensional embedding', () => {
    const engine = new GnnEngine();
    const neighborhood = mockNeighborhood(6, 8);

    const embedding = engine.forward(neighborhood);

    expect(embedding.length).toBe(TOTAL_EMBEDDING_DIM);
    expect(embedding.length).toBe(512);
  });

  it('should handle empty neighborhood', () => {
    const engine = new GnnEngine();
    const empty: Neighborhood = {
      nodeIds: [],
      nodeKinds: [],
      features: [],
      edgeIndex: [],
      edgeKinds: [],
      edgeFeatures: [],
    };

    const embedding = engine.forward(empty);
    expect(embedding.length).toBe(512);
    // All zeros for empty input
    for (let i = 0; i < embedding.length; i++) {
      expect(embedding[i]).toBe(0);
    }
  });

  it('should handle single-node neighborhood', () => {
    const engine = new GnnEngine();
    const single = mockNeighborhood(1, 0);

    const embedding = engine.forward(single);
    expect(embedding.length).toBe(512);
  });

  it('should produce non-negative output due to final ReLU', () => {
    const engine = new GnnEngine();
    const neighborhood = mockNeighborhood(10, 15);

    const embedding = engine.forward(neighborhood);
    for (let i = 0; i < embedding.length; i++) {
      expect(embedding[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it('should split embedding into 6 families with correct dimensions', () => {
    const engine = new GnnEngine();
    const neighborhood = mockNeighborhood(6, 8);
    const embedding = engine.forward(neighborhood);

    const families = engine.splitEmbedding(embedding);

    expect(families.size).toBe(6);
    for (const family of EMBEDDING_FAMILIES) {
      const vec = families.get(family.name);
      expect(vec).toBeDefined();
      expect(vec!.length).toBe(family.dimension);
    }
  });

  it('should return node-level features with forwardNodeLevel', () => {
    const engine = new GnnEngine();
    const neighborhood = mockNeighborhood(5, 6);

    const nodeFeatures = engine.forwardNodeLevel(neighborhood);
    expect(nodeFeatures.length).toBe(5);
    // Each node feature should have hiddenDim (default 128)
    for (const feat of nodeFeatures) {
      expect(feat.length).toBe(128);
    }
  });

  it('should return empty array for empty neighborhood with forwardNodeLevel', () => {
    const engine = new GnnEngine();
    const empty: Neighborhood = {
      nodeIds: [],
      nodeKinds: [],
      features: [],
      edgeIndex: [],
      edgeKinds: [],
      edgeFeatures: [],
    };

    const nodeFeatures = engine.forwardNodeLevel(empty);
    expect(nodeFeatures.length).toBe(0);
  });

  it('should accept custom config', () => {
    const engine = new GnnEngine({
      hiddenDim: 64,
      embeddingDim: 256,
      messagePassingRounds: 3,
    });

    const config = engine.getConfig();
    expect(config.hiddenDim).toBe(64);
    expect(config.embeddingDim).toBe(256);
    expect(config.messagePassingRounds).toBe(3);

    const neighborhood = mockNeighborhood(4, 4);
    const embedding = engine.forward(neighborhood);
    expect(embedding.length).toBe(256);
  });
});
