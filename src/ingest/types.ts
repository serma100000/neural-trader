import type { SymbolId, VenueId, Timestamp, PriceFp, QtyFp } from '../shared/types.js';

export interface FeedConfig {
  venueId: VenueId;
  venueName: string;
  wsUrl: string;
  feedType: 'l2_delta' | 'l3_full';
  symbols: SymbolId[];
  reconnectBaseMs: number;
  reconnectMaxMs: number;
}

export interface RawFrame {
  venueId: VenueId;
  data: unknown;
  receivedAtNs: bigint;
}

export interface SequenceGap {
  symbolId: SymbolId;
  venueId: VenueId;
  expectedSeq: bigint;
  receivedSeq: bigint;
  detectedAtNs: bigint;
}

export interface IngestConfig {
  feeds: FeedConfig[];
  reorderBufferCapacity: number;
  clockToleranceNs: bigint;
  maxReplaySpeed: number;
}

export interface IngestStats {
  totalEventsIngested: bigint;
  totalGapsDetected: bigint;
  totalMalformedFrames: bigint;
  eventsPerFeed: Map<string, bigint>;
  lastEventTsNs: bigint;
  uptimeMs: number;
}

export interface ReplayConfig {
  filePath: string;
  speed: number;
  loop: boolean;
}

/** Binance depth update message shape */
export interface BinanceDepthUpdate {
  e: 'depthUpdate';
  E: number;
  s: string;
  U: number;
  u: number;
  b: [string, string][];
  a: [string, string][];
}

/** Binance trade message shape */
export interface BinanceTrade {
  e: 'trade';
  E: number;
  s: string;
  t: number;
  p: string;
  q: string;
  b: number;
  a: number;
  T: number;
  m: boolean;
  M: boolean;
}

export type BinanceMessage = BinanceDepthUpdate | BinanceTrade;

export interface NormalizationSuccess {
  success: true;
  event: import('../shared/types.js').MarketEvent;
}

export interface NormalizationFailure {
  success: false;
  reason: string;
}

export type NormalizationResult = NormalizationSuccess | NormalizationFailure;

export const PRICE_SCALE = BigInt(1e8);
export const QTY_SCALE = BigInt(1e8);
