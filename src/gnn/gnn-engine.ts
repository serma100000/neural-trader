import type { Neighborhood } from '../graph/types.js';
import type { GnnConfig } from './types.js';
import { DEFAULT_GNN_CONFIG, EMBEDDING_FAMILIES } from './types.js';
import { StackedMessagePassing } from './message-passing.js';
import { AttentionPool } from './attention-pool.js';
import { FeatureBuilder, NODE_FEAT_DIM } from './feature-builder.js';
import { heInit, zeroBias, matVecMul, relu } from './math-utils.js';
import { NodeKind } from '../shared/types.js';

/**
 * Full GNN engine that composes message passing and attention pooling
 * to produce a 512-dimensional embedding from a graph neighborhood.
 *
 * Architecture:
 *   1. Feature extraction from raw graph node/edge properties
 *   2. K rounds of typed message passing
 *   3. Attention pooling over transformed node features
 *   4. Projection to final embedding dimension
 */
export class GnnEngine {
  private readonly config: GnnConfig;
  private readonly featureBuilder: FeatureBuilder;
  private readonly messagePassing: StackedMessagePassing;
  private readonly attentionPool: AttentionPool;
  private readonly projectionWeight: Float32Array;
  private readonly projectionBias: Float32Array;

  constructor(config?: Partial<GnnConfig>) {
    this.config = { ...DEFAULT_GNN_CONFIG, ...config };
    this.featureBuilder = new FeatureBuilder();

    // Stacked message passing: nodeFeats -> hiddenDim -> hiddenDim
    this.messagePassing = new StackedMessagePassing(
      NODE_FEAT_DIM,
      this.config.hiddenDim,
      this.config.hiddenDim,
      this.config.numEdgeTypes,
      this.config.messagePassingRounds,
    );

    // Attention pooling over node sequence
    this.attentionPool = new AttentionPool(
      this.config.hiddenDim,
      this.config.attentionHeads,
      this.config.hiddenDim,
    );

    // Final projection: hiddenDim -> embeddingDim (512)
    this.projectionWeight = heInit(this.config.hiddenDim, this.config.embeddingDim);
    this.projectionBias = zeroBias(this.config.embeddingDim);
  }

  /**
   * Forward pass: neighborhood -> 512d embedding.
   *
   * @param neighborhood The k-hop ego subgraph from MarketGraph.
   * @returns A 512-dimensional embedding vector.
   */
  forward(neighborhood: Neighborhood): Float32Array {
    const numNodes = neighborhood.nodeIds.length;

    if (numNodes === 0) {
      return new Float32Array(this.config.embeddingDim);
    }

    // Step 1: Build node features from raw Float64Array features
    const nodeFeatures: Float32Array[] = [];
    for (let i = 0; i < numNodes; i++) {
      const feat = this.convertFeatures(neighborhood.features[i]);
      nodeFeatures.push(feat);
    }

    // Step 2: Extract edge types as numeric indices
    const edgeTypes = neighborhood.edgeKinds.map((k) => k as number);

    // Step 3: Message passing
    const mpOutput = this.messagePassing.forward(
      nodeFeatures,
      neighborhood.edgeIndex,
      edgeTypes,
    );

    // Step 4: Attention pooling
    const { output: pooled } = this.attentionPool.forward(mpOutput);

    // Step 5: Final projection to embedding dim
    const projected = matVecMul(
      this.projectionWeight,
      pooled,
      this.projectionBias,
      this.config.hiddenDim,
      this.config.embeddingDim,
    );

    return relu(projected);
  }

  /**
   * Forward pass returning per-node transformed features (before pooling).
   * Used by embedding families that need node-level features.
   */
  forwardNodeLevel(neighborhood: Neighborhood): Float32Array[] {
    const numNodes = neighborhood.nodeIds.length;

    if (numNodes === 0) {
      return [];
    }

    const nodeFeatures: Float32Array[] = [];
    for (let i = 0; i < numNodes; i++) {
      const feat = this.convertFeatures(neighborhood.features[i]);
      nodeFeatures.push(feat);
    }

    const edgeTypes = neighborhood.edgeKinds.map((k) => k as number);

    return this.messagePassing.forward(
      nodeFeatures,
      neighborhood.edgeIndex,
      edgeTypes,
    );
  }

  /**
   * Split a full 512d embedding into the 6 embedding families.
   * Each family gets its designated slice of the vector.
   */
  splitEmbedding(embedding: Float32Array): Map<string, Float32Array> {
    const result = new Map<string, Float32Array>();
    let offset = 0;
    for (const family of EMBEDDING_FAMILIES) {
      const slice = new Float32Array(family.dimension);
      for (let i = 0; i < family.dimension; i++) {
        slice[i] = offset + i < embedding.length ? embedding[offset + i] : 0;
      }
      result.set(family.name, slice);
      offset += family.dimension;
    }
    return result;
  }

  /**
   * Convert a Float64Array feature vector to Float32Array with padding/truncation
   * to match NODE_FEAT_DIM.
   */
  private convertFeatures(f64: Float64Array): Float32Array {
    const out = new Float32Array(NODE_FEAT_DIM);
    const len = Math.min(f64.length, NODE_FEAT_DIM);
    for (let i = 0; i < len; i++) {
      out[i] = f64[i];
    }
    return out;
  }

  /** Get the current config. */
  getConfig(): GnnConfig {
    return { ...this.config };
  }

  /** Get the feature builder for external use. */
  getFeatureBuilder(): FeatureBuilder {
    return this.featureBuilder;
  }
}
