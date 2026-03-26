import type { SymbolId } from '../shared/types.js';

export type { SymbolId };

export interface EmbeddingFamily {
  name: string;
  dimension: number;
  updateFrequency: 'tick' | 'event' | 'window' | 'position_change';
}

export interface Embedding {
  symbolId: SymbolId;
  familyName: string;
  vector: Float32Array;
  tsNs: bigint;
  metadata: Record<string, number>;
}

export interface Prediction {
  headName: string;
  value: number;
  confidence: number;
  tsNs: bigint;
}

export interface ControlSignal {
  headName: string;
  value: number;
  confidence: number;
}

export interface ModelOutput {
  embeddings: Embedding[];
  predictions: Prediction[];
  controls: ControlSignal[];
  tsNs: bigint;
}

export interface GnnConfig {
  messagePassingRounds: number;
  nodeFeatDim: number;
  edgeFeatDim: number;
  hiddenDim: number;
  embeddingDim: number;
  numEdgeTypes: number;
  attentionHeads: number;
}

export const DEFAULT_GNN_CONFIG: GnnConfig = {
  messagePassingRounds: 2,
  nodeFeatDim: 17,
  edgeFeatDim: 4,
  hiddenDim: 128,
  embeddingDim: 512,
  numEdgeTypes: 12,
  attentionHeads: 4,
};

export const EMBEDDING_FAMILIES: EmbeddingFamily[] = [
  { name: 'book_state', dimension: 128, updateFrequency: 'tick' },
  { name: 'queue_state', dimension: 64, updateFrequency: 'tick' },
  { name: 'event_stream', dimension: 128, updateFrequency: 'event' },
  { name: 'cross_symbol_regime', dimension: 64, updateFrequency: 'window' },
  { name: 'strategy_context', dimension: 64, updateFrequency: 'position_change' },
  { name: 'risk_context', dimension: 64, updateFrequency: 'window' },
];

export const TOTAL_EMBEDDING_DIM = 512;
