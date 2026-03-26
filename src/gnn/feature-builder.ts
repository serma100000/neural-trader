import { PropertyKey, EdgeKind } from '../shared/types.js';
import type { GraphNode, GraphEdge } from '../graph/types.js';

/**
 * Online Welford statistics tracker for feature normalization.
 * Tracks running mean and variance for each feature dimension.
 */
export class WelfordNormalizer {
  private count: number[] = [];
  private mean: number[] = [];
  private m2: number[] = [];

  constructor(private readonly dim: number) {
    for (let i = 0; i < dim; i++) {
      this.count.push(0);
      this.mean.push(0);
      this.m2.push(0);
    }
  }

  /** Update running statistics with a new sample. */
  update(features: Float32Array): void {
    for (let i = 0; i < this.dim; i++) {
      const x = features[i];
      this.count[i]++;
      const delta = x - this.mean[i];
      this.mean[i] += delta / this.count[i];
      const delta2 = x - this.mean[i];
      this.m2[i] += delta * delta2;
    }
  }

  /** Normalize a feature vector using running mean/std. */
  normalize(features: Float32Array): Float32Array {
    const out = new Float32Array(this.dim);
    for (let i = 0; i < this.dim; i++) {
      if (this.count[i] < 2) {
        out[i] = features[i];
        continue;
      }
      const variance = this.m2[i] / (this.count[i] - 1);
      const std = Math.sqrt(variance + 1e-8);
      out[i] = (features[i] - this.mean[i]) / std;
    }
    return out;
  }

  /** Get the current mean for a dimension. */
  getMean(dim: number): number {
    return this.mean[dim];
  }

  /** Get the current standard deviation for a dimension. */
  getStd(dim: number): number {
    if (this.count[dim] < 2) return 1.0;
    return Math.sqrt(this.m2[dim] / (this.count[dim] - 1) + 1e-8);
  }

  /** Reset all statistics. */
  reset(): void {
    for (let i = 0; i < this.dim; i++) {
      this.count[i] = 0;
      this.mean[i] = 0;
      this.m2[i] = 0;
    }
  }
}

/** All 17 PropertyKeys in enum order for consistent feature indexing. */
const PROPERTY_KEYS: PropertyKey[] = [
  PropertyKey.VisibleDepth,
  PropertyKey.EstimatedHiddenDepth,
  PropertyKey.QueueLength,
  PropertyKey.LocalImbalance,
  PropertyKey.RefillRate,
  PropertyKey.DepletionRate,
  PropertyKey.SpreadDistance,
  PropertyKey.LocalRealizedVol,
  PropertyKey.CancelHazard,
  PropertyKey.FillHazard,
  PropertyKey.SlippageToMid,
  PropertyKey.PostTradeImpact,
  PropertyKey.InfluenceScore,
  PropertyKey.CoherenceContribution,
  PropertyKey.QueueEstimate,
  PropertyKey.Age,
  PropertyKey.ModifyCount,
];

/** Default values for missing properties. */
const PROPERTY_DEFAULTS: Record<number, number> = {
  [PropertyKey.VisibleDepth]: 0,
  [PropertyKey.EstimatedHiddenDepth]: 0,
  [PropertyKey.QueueLength]: 0,
  [PropertyKey.LocalImbalance]: 0,
  [PropertyKey.RefillRate]: 0,
  [PropertyKey.DepletionRate]: 0,
  [PropertyKey.SpreadDistance]: 0,
  [PropertyKey.LocalRealizedVol]: 0.01,
  [PropertyKey.CancelHazard]: 0.5,
  [PropertyKey.FillHazard]: 0.5,
  [PropertyKey.SlippageToMid]: 0,
  [PropertyKey.PostTradeImpact]: 0,
  [PropertyKey.InfluenceScore]: 0,
  [PropertyKey.CoherenceContribution]: 0,
  [PropertyKey.QueueEstimate]: 0,
  [PropertyKey.Age]: 0,
  [PropertyKey.ModifyCount]: 0,
};

export const NODE_FEAT_DIM = 17;
export const EDGE_FEAT_DIM = 4;

/**
 * Feature builder converts graph nodes/edges into fixed-size
 * feature tensors suitable for GNN consumption.
 */
export class FeatureBuilder {
  private nodeNormalizer: WelfordNormalizer;
  private edgeNormalizer: WelfordNormalizer;

  constructor() {
    this.nodeNormalizer = new WelfordNormalizer(NODE_FEAT_DIM);
    this.edgeNormalizer = new WelfordNormalizer(EDGE_FEAT_DIM);
  }

  /**
   * Extract a 17-dim feature vector from a graph node.
   * Maps each PropertyKey to a float, using defaults for missing values.
   */
  buildNodeFeatures(node: GraphNode): Float32Array {
    const raw = new Float32Array(NODE_FEAT_DIM);
    for (let i = 0; i < PROPERTY_KEYS.length; i++) {
      const key = PROPERTY_KEYS[i];
      const val = node.properties.get(key);
      raw[i] = val !== undefined ? val : PROPERTY_DEFAULTS[key];
    }
    this.nodeNormalizer.update(raw);
    return this.nodeNormalizer.normalize(raw);
  }

  /**
   * Extract raw (un-normalized) features from a node.
   * Used for bulk processing before normalization.
   */
  buildNodeFeaturesRaw(node: GraphNode): Float32Array {
    const raw = new Float32Array(NODE_FEAT_DIM);
    for (let i = 0; i < PROPERTY_KEYS.length; i++) {
      const key = PROPERTY_KEYS[i];
      const val = node.properties.get(key);
      raw[i] = val !== undefined ? val : PROPERTY_DEFAULTS[key];
    }
    return raw;
  }

  /**
   * Extract a 4-dim feature vector from a graph edge.
   * Features: [edgeKindOneHotBucket, weight, timeDelta, propertySum]
   */
  buildEdgeFeatures(edge: GraphEdge): Float32Array {
    const raw = new Float32Array(EDGE_FEAT_DIM);
    // Feature 0: edge kind normalized to [0, 1]
    raw[0] = edge.kind / 11.0; // 12 edge kinds, max index 11
    // Feature 1: sum of edge properties as a weight signal
    let propSum = 0;
    for (const val of edge.properties.values()) {
      propSum += val;
    }
    raw[1] = propSum;
    // Feature 2: number of properties as a complexity signal
    raw[2] = edge.properties.size;
    // Feature 3: edge kind bucket (structural vs temporal vs causal)
    if (edge.kind <= EdgeKind.NextTick) {
      raw[3] = 0; // structural
    } else if (edge.kind <= EdgeKind.CanceledBy) {
      raw[3] = 0.5; // causal
    } else {
      raw[3] = 1.0; // relational
    }
    this.edgeNormalizer.update(raw);
    return this.edgeNormalizer.normalize(raw);
  }

  /** Reset normalization statistics. */
  reset(): void {
    this.nodeNormalizer.reset();
    this.edgeNormalizer.reset();
  }

  /** Get the node normalizer (for testing/inspection). */
  getNodeNormalizer(): WelfordNormalizer {
    return this.nodeNormalizer;
  }

  /** Get the edge normalizer (for testing/inspection). */
  getEdgeNormalizer(): WelfordNormalizer {
    return this.edgeNormalizer;
  }
}
