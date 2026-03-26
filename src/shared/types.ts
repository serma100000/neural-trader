// Branded types for type safety
export type SymbolId = number & { readonly __brand: 'SymbolId' };
export type VenueId = number & { readonly __brand: 'VenueId' };
export type Timestamp = bigint & { readonly __brand: 'Timestamp' };
export type PriceFp = bigint & { readonly __brand: 'PriceFp' };
export type QtyFp = bigint & { readonly __brand: 'QtyFp' };
export type EventId = string & { readonly __brand: 'EventId' };
export type OrderIdHash = string & { readonly __brand: 'OrderIdHash' };

// Enums matching neural-trader-core
export enum EventType {
  NewOrder = 0,
  ModifyOrder = 1,
  CancelOrder = 2,
  Trade = 3,
  BookSnapshot = 4,
  SessionMarker = 5,
  VenueStatus = 6,
}

export enum Side {
  Bid = 0,
  Ask = 1,
}

export enum NodeKind {
  Symbol = 0,
  Venue = 1,
  PriceLevel = 2,
  Order = 3,
  Trade = 4,
  Event = 5,
  Participant = 6,
  TimeBucket = 7,
  Regime = 8,
  StrategyState = 9,
}

export enum EdgeKind {
  AtLevel = 0,
  NextTick = 1,
  Generated = 2,
  Matched = 3,
  ModifiedFrom = 4,
  CanceledBy = 5,
  BelongsToSymbol = 6,
  OnVenue = 7,
  InWindow = 8,
  CorrelatedWith = 9,
  InRegime = 10,
  AffectsState = 11,
}

export enum PropertyKey {
  VisibleDepth = 0,
  EstimatedHiddenDepth = 1,
  QueueLength = 2,
  LocalImbalance = 3,
  RefillRate = 4,
  DepletionRate = 5,
  SpreadDistance = 6,
  LocalRealizedVol = 7,
  CancelHazard = 8,
  FillHazard = 9,
  SlippageToMid = 10,
  PostTradeImpact = 11,
  InfluenceScore = 12,
  CoherenceContribution = 13,
  QueueEstimate = 14,
  Age = 15,
  ModifyCount = 16,
}

export enum RegimeLabel {
  Calm = 0,
  Normal = 1,
  Volatile = 2,
}

// Core market event (mirrors neural-trader-core MarketEvent)
export interface MarketEvent {
  eventId: EventId;
  tsExchangeNs: Timestamp;
  tsIngestNs: Timestamp;
  venueId: VenueId;
  symbolId: SymbolId;
  eventType: EventType;
  side?: Side;
  priceFp: PriceFp;
  qtyFp: QtyFp;
  orderIdHash?: OrderIdHash;
  participantIdHash?: string;
  flags: number;
  seq: bigint;
}

// Graph delta from apply_event
export interface GraphDelta {
  nodesAdded: number;
  edgesAdded: number;
  propertiesUpdated: number;
}

// Coherence decision (mirrors neural-trader-coherence)
export interface CoherenceDecision {
  allowRetrieve: boolean;
  allowWrite: boolean;
  allowLearn: boolean;
  allowAct: boolean;
  mincutValue: bigint;
  partitionHash: string;
  driftScore: number;
  cusumScore: number;
  reasons: string[];
}

// Verified token for proof-gated mutations
export interface VerifiedToken {
  tokenId: string;
  tsNs: Timestamp;
  coherenceHash: string;
  policyHash: string;
  actionIntent: string;
}

// Witness receipt
export interface WitnessReceipt {
  tsNs: Timestamp;
  modelId: string;
  inputSegmentHash: string;
  coherenceWitnessHash: string;
  policyHash: string;
  actionIntent: string;
  verifiedTokenId: string;
  resultingStateHash: string;
}
