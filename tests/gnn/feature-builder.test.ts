import { describe, it, expect, beforeEach } from 'vitest';
import { FeatureBuilder, WelfordNormalizer, NODE_FEAT_DIM, EDGE_FEAT_DIM } from '../../src/gnn/feature-builder.js';
import { PropertyKey, NodeKind, EdgeKind } from '../../src/shared/types.js';
import type { GraphNode, GraphEdge } from '../../src/graph/types.js';

function makeNode(props: Partial<Record<PropertyKey, number>> = {}): GraphNode {
  const properties = new Map<PropertyKey, number>();
  for (const [key, val] of Object.entries(props)) {
    properties.set(Number(key) as PropertyKey, val);
  }
  return {
    id: 1n,
    kind: NodeKind.PriceLevel,
    properties,
    createdAtNs: 0n,
    updatedAtNs: 0n,
  };
}

function makeEdge(kind: EdgeKind = EdgeKind.AtLevel, props: Record<string, number> = {}): GraphEdge {
  return {
    id: 1n,
    kind,
    sourceId: 1n,
    targetId: 2n,
    properties: new Map(Object.entries(props)),
    createdAtNs: 0n,
  };
}

describe('WelfordNormalizer', () => {
  it('should track running mean and std', () => {
    const norm = new WelfordNormalizer(2);
    const samples = [
      new Float32Array([1, 10]),
      new Float32Array([3, 20]),
      new Float32Array([5, 30]),
    ];
    for (const s of samples) norm.update(s);

    expect(norm.getMean(0)).toBeCloseTo(3, 5);
    expect(norm.getMean(1)).toBeCloseTo(20, 5);
    expect(norm.getStd(0)).toBeCloseTo(2, 1);
    expect(norm.getStd(1)).toBeCloseTo(10, 0);
  });

  it('should normalize to ~zero mean and ~unit std after enough samples', () => {
    const norm = new WelfordNormalizer(1);
    for (let i = 0; i < 100; i++) {
      norm.update(new Float32Array([i]));
    }
    const result = norm.normalize(new Float32Array([50]));
    // 50 is close to the mean (49.5), should be near 0
    expect(Math.abs(result[0])).toBeLessThan(0.1);
  });

  it('should reset statistics', () => {
    const norm = new WelfordNormalizer(2);
    norm.update(new Float32Array([5, 10]));
    norm.reset();
    expect(norm.getMean(0)).toBe(0);
    expect(norm.getMean(1)).toBe(0);
  });
});

describe('FeatureBuilder', () => {
  let builder: FeatureBuilder;

  beforeEach(() => {
    builder = new FeatureBuilder();
  });

  it('should produce NODE_FEAT_DIM-dimensional node features', () => {
    const node = makeNode({
      [PropertyKey.VisibleDepth]: 100,
      [PropertyKey.SpreadDistance]: 0.5,
      [PropertyKey.LocalImbalance]: 0.3,
    });
    const features = builder.buildNodeFeatures(node);
    expect(features.length).toBe(NODE_FEAT_DIM);
    expect(features.length).toBe(17);
  });

  it('should use defaults for missing properties', () => {
    const node = makeNode({}); // No properties set
    const features = builder.buildNodeFeaturesRaw(node);
    expect(features.length).toBe(NODE_FEAT_DIM);
    // CancelHazard default is 0.5
    expect(features[PropertyKey.CancelHazard]).toBeCloseTo(0.5, 5);
    // FillHazard default is 0.5
    expect(features[PropertyKey.FillHazard]).toBeCloseTo(0.5, 5);
  });

  it('should extract all 17 PropertyKeys from a fully populated node', () => {
    const allProps: Partial<Record<PropertyKey, number>> = {};
    for (let i = 0; i < 17; i++) {
      allProps[i as PropertyKey] = i * 0.1;
    }
    const node = makeNode(allProps);
    const features = builder.buildNodeFeaturesRaw(node);

    for (let i = 0; i < 17; i++) {
      expect(features[i]).toBeCloseTo(i * 0.1, 5);
    }
  });

  it('should produce EDGE_FEAT_DIM-dimensional edge features', () => {
    const edge = makeEdge(EdgeKind.AtLevel, { weight: 1.5 });
    const features = builder.buildEdgeFeatures(edge);
    expect(features.length).toBe(EDGE_FEAT_DIM);
    expect(features.length).toBe(4);
  });

  it('should encode different edge kinds differently', () => {
    const edge1 = makeEdge(EdgeKind.AtLevel);
    const edge2 = makeEdge(EdgeKind.CorrelatedWith);

    // Reset between to avoid cross-contamination of normalization
    builder.reset();
    const f1 = builder.buildEdgeFeatures(edge1);
    builder.reset();
    const f2 = builder.buildEdgeFeatures(edge2);

    // Raw feature 0 (kind-normalized) should differ
    // After normalization with only 1 sample, values pass through
    expect(f1[0]).not.toEqual(f2[0]);
  });

  it('should normalize features over multiple updates', () => {
    // Feed several samples to build up statistics
    for (let i = 0; i < 50; i++) {
      const props: Partial<Record<PropertyKey, number>> = {
        [PropertyKey.VisibleDepth]: i * 10,
        [PropertyKey.SpreadDistance]: Math.random(),
      };
      builder.buildNodeFeatures(makeNode(props));
    }

    // Now features should be normalized
    const node = makeNode({ [PropertyKey.VisibleDepth]: 250 });
    const features = builder.buildNodeFeatures(node);
    // Normalized value should be near 0 (250 is near the mean of ~245)
    expect(Math.abs(features[PropertyKey.VisibleDepth])).toBeLessThan(2);
  });
});
