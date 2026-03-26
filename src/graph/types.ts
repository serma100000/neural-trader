import type {
  SymbolId,
  VenueId,
  NodeKind,
  EdgeKind,
  PropertyKey,
} from '../shared/types.js';

/** A node in the market graph. */
export interface GraphNode {
  id: bigint;
  kind: NodeKind;
  properties: Map<PropertyKey, number>;
  createdAtNs: bigint;
  updatedAtNs: bigint;
}

/** A directed edge in the market graph. */
export interface GraphEdge {
  id: bigint;
  kind: EdgeKind;
  sourceId: bigint;
  targetId: bigint;
  properties: Map<string, number>;
  createdAtNs: bigint;
}

/**
 * k-hop ego subgraph for GNN consumption.
 * Features are packed into Float64Arrays in COO sparse format.
 */
export interface Neighborhood {
  nodeIds: bigint[];
  nodeKinds: NodeKind[];
  features: Float64Array[];
  edgeIndex: [number, number][];
  edgeKinds: EdgeKind[];
  edgeFeatures: Float64Array[];
}

/** Statistics returned after a compaction pass. */
export interface CompactionStats {
  nodesRemoved: number;
  edgesRemoved: number;
  durationMs: number;
}

/** Describes a temporal window of graph state. */
export interface StateWindow {
  symbolId: SymbolId;
  venueId: VenueId;
  startNs: bigint;
  endNs: bigint;
  nodeCount: number;
  edgeCount: number;
}

/** Configuration for the MarketGraph. */
export interface GraphConfig {
  /** Retention window in nanoseconds (default: 60s = 60_000_000_000n). */
  retentionWindowNs: bigint;
  /** Hard cap on node count before emergency compaction (default: 500_000). */
  nodeHardCap: number;
  /** EMA alpha for rate estimations (default: 0.1). */
  emaAlpha: number;
  /** Feature dimension for neighborhood extraction (default: 8). */
  featureDim: number;
}

/** Default configuration values. */
export const DEFAULT_GRAPH_CONFIG: GraphConfig = {
  retentionWindowNs: 60_000_000_000n,
  nodeHardCap: 500_000,
  emaAlpha: 0.1,
  featureDim: 8,
};

/**
 * Composite key for domain-level node lookup.
 * Used to find existing Symbol, Venue, PriceLevel, and Order nodes
 * without full graph scans.
 */
export type DomainKey = string;

/** Build a domain key for a PriceLevel node. */
export function priceLevelKey(
  symbolId: SymbolId,
  venueId: VenueId,
  priceFp: bigint,
  side: number,
): DomainKey {
  return `pl:${symbolId}:${venueId}:${priceFp}:${side}`;
}

/** Build a domain key for a Symbol node. */
export function symbolKey(symbolId: SymbolId): DomainKey {
  return `sym:${symbolId}`;
}

/** Build a domain key for a Venue node. */
export function venueKey(venueId: VenueId): DomainKey {
  return `ven:${venueId}`;
}

/** Build a domain key for an Order node. */
export function orderKey(orderIdHash: string): DomainKey {
  return `ord:${orderIdHash}`;
}

/** Build a domain key for a TimeBucket node. */
export function timeBucketKey(symbolId: SymbolId, bucketNs: bigint): DomainKey {
  return `tb:${symbolId}:${bucketNs}`;
}
