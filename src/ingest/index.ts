// Ingest bounded context - public API
export type {
  FeedConfig,
  RawFrame,
  SequenceGap,
  IngestConfig,
  IngestStats,
  ReplayConfig,
  BinanceDepthUpdate,
  BinanceTrade,
  BinanceMessage,
  NormalizationResult,
} from './types.js';

export { PRICE_SCALE, QTY_SCALE } from './types.js';

export type { FeedAdapter } from './feed-adapter.js';

export { WsFeedAdapter } from './ws-feed-adapter.js';
export { BinanceAdapter } from './binance-adapter.js';
export { Normalizer, stringToFixedPoint, generateEventId } from './normalizer.js';
export { Sequencer } from './sequencer.js';
export { ReorderBuffer } from './reorder-buffer.js';
export { ReplayAdapter } from './replay-adapter.js';
export { IngestPipeline } from './ingest-pipeline.js';
