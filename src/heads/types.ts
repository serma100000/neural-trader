export type ActivationName = 'linear' | 'relu' | 'sigmoid' | 'softplus' | 'softmax' | 'gelu';

export interface HeadConfig {
  name: string;
  inputDim: number;
  hiddenDim: number;
  outputDim: number;
  activation: ActivationName;
}

export interface PredictionHead {
  readonly name: string;
  predict(embedding: Float32Array): { headName: string; value: number; confidence: number; tsNs: bigint };
}

export interface ControlHead {
  readonly name: string;
  evaluate(embedding: Float32Array): { headName: string; value: number; confidence: number };
}

/** A prediction head that exposes its MLP for training. */
export interface TrainablePredictionHead extends PredictionHead {
  getMlp(): import('./mlp.js').MLP;
}
