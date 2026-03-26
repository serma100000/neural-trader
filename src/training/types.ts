import type { MarketEvent } from '../shared/types.js';

export interface TrainingConfig {
  /** Learning rate for gradient descent. Default 1e-4. */
  learningRate: number;
  /** Number of training epochs. Default 50. */
  epochs: number;
  /** Mini-batch size. Default 32. */
  batchSize: number;
  /** Window duration in nanoseconds. Default 60s. */
  windowSizeNs: bigint;
  /** Stride between windows in nanoseconds. Default 10s. */
  strideNs: bigint;
  /** Fraction of data held out for validation. Default 0.2. */
  validationSplit: number;
  /** Maximum L2 norm for gradient clipping. Default 1.0. */
  gradientClipNorm: number;
  /** Directory for saving checkpoints. */
  checkpointDir: string;
  /** Loss weight for fill/cancel probability heads. Default 1.0. */
  lambdaFill: number;
  /** Loss weight for risk-related heads (slippage, vol). Default 2.0. */
  lambdaRisk: number;
}

export const DEFAULT_TRAINING_CONFIG: TrainingConfig = {
  learningRate: 1e-4,
  epochs: 50,
  batchSize: 32,
  windowSizeNs: 60_000_000_000n,
  strideNs: 10_000_000_000n,
  validationSplit: 0.2,
  gradientClipNorm: 1.0,
  checkpointDir: 'data/checkpoints',
  lambdaFill: 1.0,
  lambdaRisk: 2.0,
};

export interface TrainingWindow {
  events: MarketEvent[];
  labels: WindowLabels;
}

export interface WindowLabels {
  /** Mid-price move in basis points to next window. */
  midPriceMoveBp: number;
  /** Whether a fill (Trade) occurred in this window. */
  fillOccurred: boolean;
  /** Whether a cancel occurred in this window. */
  cancelOccurred: boolean;
  /** Slippage in basis points. */
  slippageBp: number;
  /** Whether a volatility jump occurred (>2 std devs). */
  volJump: boolean;
  /** Regime label: 0=Calm, 1=Normal, 2=Volatile. */
  regimeLabel: number;
}

export interface TrainingMetrics {
  epoch: number;
  trainLoss: number;
  valLoss: number;
  perHeadLoss: Map<string, number>;
  learningRate: number;
  durationMs: number;
}

export interface Checkpoint {
  version: string;
  epoch: number;
  metrics: TrainingMetrics;
  weights: SerializedWeights;
  config: TrainingConfig;
  createdAt: string;
}

export interface SerializedWeights {
  gnnMessagePassing: SerializedLayer[];
  gnnAttention: SerializedLayer[];
  gnnProjection: SerializedLayer;
  heads: Record<string, SerializedLayer[]>;
}

export interface SerializedLayer {
  weights: number[];
  biases: number[];
}
