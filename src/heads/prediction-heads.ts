import type { Prediction } from '../gnn/types.js';
import type { PredictionHead, TrainablePredictionHead } from './types.js';
import { MLP } from './mlp.js';
import { TOTAL_EMBEDDING_DIM } from '../gnn/types.js';

/**
 * MidPriceHead: Predicts mid-price change direction/magnitude.
 * Architecture: 512 -> 256 -> 1, linear output.
 * Loss: Huber loss.
 */
export class MidPriceHead implements TrainablePredictionHead {
  readonly name = 'mid_price';
  private readonly mlp: MLP;

  constructor(inputDim: number = TOTAL_EMBEDDING_DIM) {
    this.mlp = new MLP([inputDim, 256, 1], 'relu', 'linear');
  }

  predict(embedding: Float32Array): Prediction {
    const output = this.mlp.forward(embedding);
    const magnitude = Math.abs(output[0]);
    const confidence = Math.min(1.0, magnitude / (magnitude + 1.0));
    return {
      headName: this.name,
      value: output[0],
      confidence,
      tsNs: BigInt(Date.now()) * 1_000_000n,
    };
  }

  getMlp(): MLP { return this.mlp; }
}

/**
 * FillProbHead: Predicts probability of order fill within horizon.
 * Architecture: 512 -> 256 -> 1, sigmoid output.
 * Loss: Binary cross-entropy.
 */
export class FillProbHead implements TrainablePredictionHead {
  readonly name = 'fill_prob';
  private readonly mlp: MLP;

  constructor(inputDim: number = TOTAL_EMBEDDING_DIM) {
    this.mlp = new MLP([inputDim, 256, 1], 'relu', 'sigmoid');
  }

  predict(embedding: Float32Array): Prediction {
    const output = this.mlp.forward(embedding);
    const prob = output[0];
    const confidence = Math.abs(2 * prob - 1);
    return {
      headName: this.name,
      value: prob,
      confidence,
      tsNs: BigInt(Date.now()) * 1_000_000n,
    };
  }

  getMlp(): MLP { return this.mlp; }
}

/**
 * CancelProbHead: Predicts probability of order cancellation.
 * Architecture: 512 -> 256 -> 1, sigmoid output.
 * Loss: Binary cross-entropy.
 */
export class CancelProbHead implements TrainablePredictionHead {
  readonly name = 'cancel_prob';
  private readonly mlp: MLP;

  constructor(inputDim: number = TOTAL_EMBEDDING_DIM) {
    this.mlp = new MLP([inputDim, 256, 1], 'relu', 'sigmoid');
  }

  predict(embedding: Float32Array): Prediction {
    const output = this.mlp.forward(embedding);
    const prob = output[0];
    const confidence = Math.abs(2 * prob - 1);
    return {
      headName: this.name,
      value: prob,
      confidence,
      tsNs: BigInt(Date.now()) * 1_000_000n,
    };
  }

  getMlp(): MLP { return this.mlp; }
}

/**
 * SlippageHead: Predicts expected slippage in basis points.
 * Architecture: 512 -> 256 -> 1, softplus output (non-negative).
 * Loss: Quantile loss.
 */
export class SlippageHead implements TrainablePredictionHead {
  readonly name = 'slippage';
  private readonly mlp: MLP;

  constructor(inputDim: number = TOTAL_EMBEDDING_DIM) {
    this.mlp = new MLP([inputDim, 256, 1], 'relu', 'softplus');
  }

  predict(embedding: Float32Array): Prediction {
    const output = this.mlp.forward(embedding);
    const slippage = output[0];
    const confidence = 1.0 / (1.0 + slippage);
    return {
      headName: this.name,
      value: slippage,
      confidence,
      tsNs: BigInt(Date.now()) * 1_000_000n,
    };
  }

  getMlp(): MLP { return this.mlp; }
}

/**
 * VolJumpHead: Predicts probability of a volatility regime jump.
 * Architecture: 512 -> 256 -> 1, sigmoid output.
 * Loss: Binary cross-entropy with class weights.
 */
export class VolJumpHead implements TrainablePredictionHead {
  readonly name = 'vol_jump';
  private readonly mlp: MLP;

  constructor(inputDim: number = TOTAL_EMBEDDING_DIM) {
    this.mlp = new MLP([inputDim, 256, 1], 'relu', 'sigmoid');
  }

  predict(embedding: Float32Array): Prediction {
    const output = this.mlp.forward(embedding);
    const prob = output[0];
    const confidence = Math.abs(2 * prob - 1);
    return {
      headName: this.name,
      value: prob,
      confidence,
      tsNs: BigInt(Date.now()) * 1_000_000n,
    };
  }

  getMlp(): MLP { return this.mlp; }
}

/**
 * RegimeTransitionHead: Predicts transition probabilities between regimes.
 * Architecture: 512 -> 256 -> 3, softmax output (Calm, Normal, Volatile).
 * Loss: Categorical cross-entropy.
 */
export class RegimeTransitionHead implements TrainablePredictionHead {
  readonly name = 'regime_transition';
  private readonly mlp: MLP;

  constructor(inputDim: number = TOTAL_EMBEDDING_DIM) {
    this.mlp = new MLP([inputDim, 256, 3], 'relu', 'softmax');
  }

  predict(embedding: Float32Array): Prediction {
    const output = this.mlp.forward(embedding);
    let maxIdx = 0;
    let maxProb = output[0];
    for (let i = 1; i < output.length; i++) {
      if (output[i] > maxProb) {
        maxProb = output[i];
        maxIdx = i;
      }
    }
    const confidence = Math.max(0, (maxProb - 1.0 / 3.0) / (2.0 / 3.0));
    return {
      headName: this.name,
      value: maxIdx,
      confidence,
      tsNs: BigInt(Date.now()) * 1_000_000n,
    };
  }

  /** Get raw softmax output for training (cross-entropy needs full distribution). */
  predictRaw(embedding: Float32Array): Float32Array {
    return this.mlp.forward(embedding);
  }

  getMlp(): MLP { return this.mlp; }
}

/** Create all six prediction heads. */
export function createAllPredictionHeads(inputDim?: number): PredictionHead[] {
  const dim = inputDim ?? TOTAL_EMBEDDING_DIM;
  return [
    new MidPriceHead(dim),
    new FillProbHead(dim),
    new CancelProbHead(dim),
    new SlippageHead(dim),
    new VolJumpHead(dim),
    new RegimeTransitionHead(dim),
  ];
}
