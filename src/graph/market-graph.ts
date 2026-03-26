import type {
  MarketEvent,
  GraphDelta,
  SymbolId,
  VenueId,
} from '../shared/types.js';
import { Side } from '../shared/types.js';
import type {
  GraphNode,
  GraphConfig,
  Neighborhood,
  CompactionStats,
  StateWindow,
} from './types.js';
import { DEFAULT_GRAPH_CONFIG } from './types.js';
import { GraphStore } from './graph-store.js';
import { GraphUpdater } from './graph-updater.js';
import { SlidingWindow } from './sliding-window.js';
import { SubgraphExtractor } from './subgraph-extractor.js';

/**
 * Main orchestrator for the L2 Dynamic Market Graph.
 * Combines the graph store, updater, sliding window, and subgraph extractor
 * into a single coherent API.
 */
export class MarketGraph {
  private readonly store: GraphStore;
  private readonly updater: GraphUpdater;
  private readonly window: SlidingWindow;
  private readonly extractor: SubgraphExtractor;
  private readonly config: GraphConfig;

  /** Track the latest event timestamp for compaction. */
  private latestTsNs = 0n;

  constructor(config?: Partial<GraphConfig>) {
    this.config = { ...DEFAULT_GRAPH_CONFIG, ...config };
    this.store = new GraphStore();
    this.updater = new GraphUpdater(this.store, this.config);
    this.window = new SlidingWindow(this.store, this.config);
    this.extractor = new SubgraphExtractor(this.store, this.config);
  }

  /**
   * Apply a single market event to the graph.
   * Triggers emergency compaction if the node hard cap is exceeded.
   */
  applyEvent(event: MarketEvent): GraphDelta {
    const tsNs = event.tsExchangeNs as bigint;
    if (tsNs > this.latestTsNs) {
      this.latestTsNs = tsNs;
    }

    const delta = this.updater.applyEvent(event);

    // Emergency compaction check
    if (this.window.needsEmergencyCompaction()) {
      this.window.emergencyCompact(this.latestTsNs);
    }

    return delta;
  }

  /**
   * Apply a batch of market events, returning an aggregated delta.
   */
  applyEventBatch(events: MarketEvent[]): GraphDelta {
    let totalNodes = 0;
    let totalEdges = 0;
    let totalProps = 0;

    for (const event of events) {
      const delta = this.applyEvent(event);
      totalNodes += delta.nodesAdded;
      totalEdges += delta.edgesAdded;
      totalProps += delta.propertiesUpdated;
    }

    return {
      nodesAdded: totalNodes,
      edgesAdded: totalEdges,
      propertiesUpdated: totalProps,
    };
  }

  /**
   * Extract a k-hop ego subgraph for GNN consumption.
   */
  extractNeighborhood(nodeId: bigint, hops: number): Neighborhood {
    return this.extractor.extractNeighborhood(nodeId, hops);
  }

  /**
   * Get the price ladder for a symbol/venue/side.
   * Returns PriceLevel nodes in price order.
   */
  getPriceLadder(symbolId: SymbolId, venueId: VenueId, side: Side): GraphNode[] {
    return this.extractor.extractPriceLadder(symbolId, venueId, side);
  }

  /**
   * Get the N most recent event nodes for a symbol.
   */
  getRecentEvents(symbolId: SymbolId, n: number): GraphNode[] {
    return this.extractor.extractRecentEvents(symbolId, n);
  }

  /**
   * Get all nodes and edges belonging to a symbol.
   */
  getSymbolSubgraph(symbolId: SymbolId): { nodes: GraphNode[]; edges: import('./types.js').GraphEdge[] } {
    return this.extractor.extractSymbolSubgraph(symbolId);
  }

  /**
   * Run temporal compaction, removing stale nodes outside the retention window.
   */
  compact(): CompactionStats {
    return this.window.compact(this.latestTsNs);
  }

  /**
   * Get a state window descriptor for a symbol/venue pair.
   */
  getStateWindow(
    symbolId: SymbolId,
    venueId: VenueId,
    durationNs: bigint,
  ): StateWindow {
    const subgraph = this.extractor.extractSymbolSubgraph(symbolId);
    const endNs = this.latestTsNs;
    const startNs = endNs - durationNs;

    // Filter nodes within the time range
    const nodesInWindow = subgraph.nodes.filter(
      (n) => n.createdAtNs >= startNs && n.createdAtNs <= endNs,
    );
    const nodeIdsInWindow = new Set(nodesInWindow.map((n) => n.id));
    const edgesInWindow = subgraph.edges.filter(
      (e) => nodeIdsInWindow.has(e.sourceId) || nodeIdsInWindow.has(e.targetId),
    );

    return {
      symbolId,
      venueId,
      startNs,
      endNs,
      nodeCount: nodesInWindow.length,
      edgeCount: edgesInWindow.length,
    };
  }

  /** Total number of nodes in the graph. */
  nodeCount(): number {
    return this.store.nodeCount();
  }

  /** Total number of edges in the graph. */
  edgeCount(): number {
    return this.store.edgeCount();
  }

  /** Access the underlying store (for testing). */
  getStore(): GraphStore {
    return this.store;
  }
}
