import type { Neighborhood } from '../graph/types.js';
import { NodeKind } from '../shared/types.js';
import {
  meanPool,
  sumPool,
  maxPool,
  heInit,
  zeroBias,
  matVecMul,
  relu,
  concat,
} from '../gnn/math-utils.js';

/**
 * Base interface for all embedding family implementations.
 */
export interface EmbeddingFamilyImpl {
  readonly name: string;
  readonly dimension: number;
  embed(neighborhood: Neighborhood, gnnOutput: Float32Array[]): Float32Array;
}

/**
 * BookStateEmbedder: Attention-weighted pooling over instrument + price-level nodes.
 * Captures the current order book state (depth, spread, imbalance).
 */
export class BookStateEmbedder implements EmbeddingFamilyImpl {
  readonly name = 'book_state';
  readonly dimension = 128;
  private readonly projWeight: Float32Array;
  private readonly projBias: Float32Array;

  constructor(inputDim: number) {
    this.projWeight = heInit(inputDim, this.dimension);
    this.projBias = zeroBias(this.dimension);
  }

  embed(neighborhood: Neighborhood, gnnOutput: Float32Array[]): Float32Array {
    // Filter for Symbol and PriceLevel nodes
    const bookNodeFeats: Float32Array[] = [];
    for (let i = 0; i < neighborhood.nodeKinds.length; i++) {
      const kind = neighborhood.nodeKinds[i];
      if (kind === NodeKind.Symbol || kind === NodeKind.PriceLevel) {
        if (i < gnnOutput.length) {
          bookNodeFeats.push(gnnOutput[i]);
        }
      }
    }

    if (bookNodeFeats.length === 0) {
      return new Float32Array(this.dimension);
    }

    // Attention-weighted pooling: compute attention scores from L2 norms
    const scores = new Float32Array(bookNodeFeats.length);
    let maxScore = -Infinity;
    for (let i = 0; i < bookNodeFeats.length; i++) {
      let norm = 0;
      for (let j = 0; j < bookNodeFeats[i].length; j++) {
        norm += bookNodeFeats[i][j] * bookNodeFeats[i][j];
      }
      scores[i] = Math.sqrt(norm);
      if (scores[i] > maxScore) maxScore = scores[i];
    }

    // Softmax over scores
    let sumExp = 0;
    for (let i = 0; i < scores.length; i++) {
      scores[i] = Math.exp(scores[i] - maxScore);
      sumExp += scores[i];
    }
    for (let i = 0; i < scores.length; i++) {
      scores[i] /= sumExp;
    }

    // Weighted sum
    const dim = bookNodeFeats[0].length;
    const pooled = new Float32Array(dim);
    for (let i = 0; i < bookNodeFeats.length; i++) {
      for (let j = 0; j < dim; j++) {
        pooled[j] += scores[i] * bookNodeFeats[i][j];
      }
    }

    // Project to output dimension
    return relu(matVecMul(this.projWeight, pooled, this.projBias, dim, this.dimension));
  }
}

/**
 * QueueStateEmbedder: Sum pool over order-level nodes per price level.
 * Captures queue position and order flow dynamics.
 */
export class QueueStateEmbedder implements EmbeddingFamilyImpl {
  readonly name = 'queue_state';
  readonly dimension = 64;
  private readonly projWeight: Float32Array;
  private readonly projBias: Float32Array;

  constructor(inputDim: number) {
    this.projWeight = heInit(inputDim, this.dimension);
    this.projBias = zeroBias(this.dimension);
  }

  embed(neighborhood: Neighborhood, gnnOutput: Float32Array[]): Float32Array {
    const orderFeats: Float32Array[] = [];
    for (let i = 0; i < neighborhood.nodeKinds.length; i++) {
      if (neighborhood.nodeKinds[i] === NodeKind.Order && i < gnnOutput.length) {
        orderFeats.push(gnnOutput[i]);
      }
    }

    if (orderFeats.length === 0) {
      return new Float32Array(this.dimension);
    }

    const pooled = sumPool(orderFeats);
    return relu(matVecMul(this.projWeight, pooled, this.projBias, pooled.length, this.dimension));
  }
}

/**
 * EventStreamEmbedder: Causal attention over temporal event sequence.
 * Captures recent market microstructure dynamics.
 */
export class EventStreamEmbedder implements EmbeddingFamilyImpl {
  readonly name = 'event_stream';
  readonly dimension = 128;
  private readonly projWeight: Float32Array;
  private readonly projBias: Float32Array;

  constructor(inputDim: number) {
    this.projWeight = heInit(inputDim, this.dimension);
    this.projBias = zeroBias(this.dimension);
  }

  embed(neighborhood: Neighborhood, gnnOutput: Float32Array[]): Float32Array {
    // Filter Event and Trade nodes (temporal events)
    const eventFeats: Float32Array[] = [];
    for (let i = 0; i < neighborhood.nodeKinds.length; i++) {
      const kind = neighborhood.nodeKinds[i];
      if (
        (kind === NodeKind.Event || kind === NodeKind.Trade) &&
        i < gnnOutput.length
      ) {
        eventFeats.push(gnnOutput[i]);
      }
    }

    if (eventFeats.length === 0) {
      return new Float32Array(this.dimension);
    }

    // Causal attention: each position can only attend to earlier positions
    const dim = eventFeats[0].length;
    const pooled = new Float32Array(dim);

    // Exponential recency weighting (causal)
    const decay = 0.9;
    let totalWeight = 0;
    for (let i = 0; i < eventFeats.length; i++) {
      const weight = Math.pow(decay, eventFeats.length - 1 - i);
      totalWeight += weight;
      for (let j = 0; j < dim; j++) {
        pooled[j] += weight * eventFeats[i][j];
      }
    }
    if (totalWeight > 0) {
      for (let j = 0; j < dim; j++) {
        pooled[j] /= totalWeight;
      }
    }

    return relu(matVecMul(this.projWeight, pooled, this.projBias, dim, this.dimension));
  }
}

/**
 * CrossSymbolRegimeEmbedder: Mean pool over all instrument root nodes.
 * Captures cross-asset regime information.
 */
export class CrossSymbolRegimeEmbedder implements EmbeddingFamilyImpl {
  readonly name = 'cross_symbol_regime';
  readonly dimension = 64;
  private readonly projWeight: Float32Array;
  private readonly projBias: Float32Array;

  constructor(inputDim: number) {
    this.projWeight = heInit(inputDim, this.dimension);
    this.projBias = zeroBias(this.dimension);
  }

  embed(neighborhood: Neighborhood, gnnOutput: Float32Array[]): Float32Array {
    const symbolFeats: Float32Array[] = [];
    for (let i = 0; i < neighborhood.nodeKinds.length; i++) {
      const kind = neighborhood.nodeKinds[i];
      if (
        (kind === NodeKind.Symbol || kind === NodeKind.Regime) &&
        i < gnnOutput.length
      ) {
        symbolFeats.push(gnnOutput[i]);
      }
    }

    if (symbolFeats.length === 0) {
      return new Float32Array(this.dimension);
    }

    const pooled = meanPool(symbolFeats);
    return relu(matVecMul(this.projWeight, pooled, this.projBias, pooled.length, this.dimension));
  }
}

/**
 * StrategyContextEmbedder: Concat strategy + position node features, project.
 * Captures current strategy state and position context.
 */
export class StrategyContextEmbedder implements EmbeddingFamilyImpl {
  readonly name = 'strategy_context';
  readonly dimension = 64;
  private readonly projWeight: Float32Array;
  private readonly projBias: Float32Array;

  constructor(inputDim: number) {
    // Input is 2x inputDim (concat of strategy and position)
    this.projWeight = heInit(inputDim * 2, this.dimension);
    this.projBias = zeroBias(this.dimension);
  }

  embed(neighborhood: Neighborhood, gnnOutput: Float32Array[]): Float32Array {
    let strategyFeat: Float32Array | null = null;
    let positionFeat: Float32Array | null = null;

    for (let i = 0; i < neighborhood.nodeKinds.length; i++) {
      if (neighborhood.nodeKinds[i] === NodeKind.StrategyState && i < gnnOutput.length) {
        strategyFeat = gnnOutput[i];
        break;
      }
    }

    // Use Participant node as position proxy
    for (let i = 0; i < neighborhood.nodeKinds.length; i++) {
      if (neighborhood.nodeKinds[i] === NodeKind.Participant && i < gnnOutput.length) {
        positionFeat = gnnOutput[i];
        break;
      }
    }

    const dim = gnnOutput.length > 0 ? gnnOutput[0].length : 128;

    if (!strategyFeat) strategyFeat = new Float32Array(dim);
    if (!positionFeat) positionFeat = new Float32Array(dim);

    const concatenated = concat(strategyFeat, positionFeat);
    return relu(
      matVecMul(this.projWeight, concatenated, this.projBias, concatenated.length, this.dimension),
    );
  }
}

/**
 * RiskContextEmbedder: Max pool over risk/exposure nodes.
 * Captures worst-case risk signals across the portfolio.
 */
export class RiskContextEmbedder implements EmbeddingFamilyImpl {
  readonly name = 'risk_context';
  readonly dimension = 64;
  private readonly projWeight: Float32Array;
  private readonly projBias: Float32Array;

  constructor(inputDim: number) {
    this.projWeight = heInit(inputDim, this.dimension);
    this.projBias = zeroBias(this.dimension);
  }

  embed(neighborhood: Neighborhood, gnnOutput: Float32Array[]): Float32Array {
    // Use Regime, StrategyState, and TimeBucket nodes as risk signals
    const riskFeats: Float32Array[] = [];
    for (let i = 0; i < neighborhood.nodeKinds.length; i++) {
      const kind = neighborhood.nodeKinds[i];
      if (
        (kind === NodeKind.Regime ||
          kind === NodeKind.StrategyState ||
          kind === NodeKind.TimeBucket) &&
        i < gnnOutput.length
      ) {
        riskFeats.push(gnnOutput[i]);
      }
    }

    if (riskFeats.length === 0) {
      return new Float32Array(this.dimension);
    }

    const pooled = maxPool(riskFeats);
    return relu(matVecMul(this.projWeight, pooled, this.projBias, pooled.length, this.dimension));
  }
}

/** Create all six embedding family implementations. */
export function createAllFamilies(hiddenDim: number): EmbeddingFamilyImpl[] {
  return [
    new BookStateEmbedder(hiddenDim),
    new QueueStateEmbedder(hiddenDim),
    new EventStreamEmbedder(hiddenDim),
    new CrossSymbolRegimeEmbedder(hiddenDim),
    new StrategyContextEmbedder(hiddenDim),
    new RiskContextEmbedder(hiddenDim),
  ];
}
