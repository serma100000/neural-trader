import type { Neighborhood } from '../graph/types.js';
import type { CoherenceDecision } from '../shared/types.js';
import type { GnnConfig, ModelOutput, Embedding, SymbolId } from './types.js';
import { DEFAULT_GNN_CONFIG, EMBEDDING_FAMILIES } from './types.js';
import { GnnEngine } from './gnn-engine.js';
import { EmbeddingComposer } from '../embeddings/composer.js';
import { EmbeddingCache } from '../embeddings/cache.js';
import { HeadRegistry } from '../heads/head-registry.js';
import { PredictionEnsemble } from '../heads/ensemble.js';
import { createAllFamilies, type EmbeddingFamilyImpl } from '../embeddings/families.js';
import { createAllPredictionHeads } from '../heads/prediction-heads.js';
import { createAllControlHeads } from '../heads/control-heads.js';

export interface PipelineConfig {
  gnn: GnnConfig;
  cacheSize: number;
  enableCache: boolean;
}

const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  gnn: DEFAULT_GNN_CONFIG,
  cacheSize: 1024,
  enableCache: true,
};

/**
 * End-to-end GNN inference pipeline.
 *
 * Orchestrates:
 *   1. GNN forward pass (message passing + attention)
 *   2. Embedding family extraction
 *   3. Embedding composition
 *   4. Prediction and control head evaluation
 *   5. Coherence-gated ensemble
 */
export class GnnPipeline {
  private readonly gnnEngine: GnnEngine;
  private readonly families: EmbeddingFamilyImpl[];
  private readonly composer: EmbeddingComposer;
  private readonly cache: EmbeddingCache;
  private readonly headRegistry: HeadRegistry;
  private readonly ensemble: PredictionEnsemble;
  private readonly config: PipelineConfig;

  constructor(config?: Partial<PipelineConfig>) {
    this.config = { ...DEFAULT_PIPELINE_CONFIG, ...config };

    this.gnnEngine = new GnnEngine(this.config.gnn);
    this.families = createAllFamilies(this.config.gnn.hiddenDim);
    this.composer = new EmbeddingComposer();
    this.cache = new EmbeddingCache(this.config.cacheSize);
    this.headRegistry = new HeadRegistry();
    this.ensemble = new PredictionEnsemble();

    // Register all prediction heads
    for (const head of createAllPredictionHeads()) {
      this.headRegistry.registerPrediction(head);
    }

    // Register all control heads
    for (const head of createAllControlHeads()) {
      this.headRegistry.registerControl(head);
    }
  }

  /**
   * Full inference pipeline: neighborhood -> model output.
   *
   * @param neighborhood The k-hop ego subgraph.
   * @param coherence Current coherence decision for gating.
   * @param symbolId Optional symbol ID for embedding metadata.
   * @param cacheKey Optional cache key; if provided, will attempt cache lookup.
   * @returns Complete model output with predictions, controls, and embeddings.
   */
  process(
    neighborhood: Neighborhood,
    coherence: CoherenceDecision,
    symbolId?: SymbolId,
    cacheKey?: string,
  ): ModelOutput {
    // Check cache
    let composedEmbedding: Float32Array | undefined;
    if (this.config.enableCache && cacheKey) {
      composedEmbedding = this.cache.get(cacheKey);
    }

    if (!composedEmbedding) {
      // Step 1: GNN forward pass (node-level features)
      const nodeFeatures = this.gnnEngine.forwardNodeLevel(neighborhood);

      // Step 2: Family-specific embedding extraction
      const familyEmbeddings = new Map<string, Float32Array>();
      for (const family of this.families) {
        const embedding = family.embed(neighborhood, nodeFeatures);
        familyEmbeddings.set(family.name, embedding);
      }

      // Step 3: Compose into single 512d vector
      composedEmbedding = this.composer.compose(familyEmbeddings);

      // Cache the result
      if (this.config.enableCache && cacheKey) {
        this.cache.set(cacheKey, composedEmbedding);
      }
    }

    // Step 4: Run prediction and control heads
    const predictions = this.headRegistry.getPredictions(composedEmbedding);
    const controls = this.headRegistry.getControls(composedEmbedding);

    // Step 5: Build embedding records
    const tsNs = BigInt(Date.now()) * 1_000_000n;
    const embeddings: Embedding[] = [];
    if (symbolId !== undefined) {
      const decomposed = this.composer.decompose(composedEmbedding);
      for (const [familyName, vector] of decomposed) {
        embeddings.push({
          symbolId,
          familyName,
          vector,
          tsNs,
          metadata: {},
        });
      }
    }

    // Step 6: Coherence-gated ensemble
    return this.ensemble.combine(predictions, controls, coherence, embeddings);
  }

  /** Get cache statistics. */
  getCacheStats(): ReturnType<EmbeddingCache['stats']> {
    return this.cache.stats();
  }

  /** Clear the embedding cache. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Get the underlying GNN engine. */
  getEngine(): GnnEngine {
    return this.gnnEngine;
  }

  /** Get the head registry. */
  getHeadRegistry(): HeadRegistry {
    return this.headRegistry;
  }

  /** Get the embedding composer. */
  getComposer(): EmbeddingComposer {
    return this.composer;
  }
}
