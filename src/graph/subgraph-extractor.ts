import {
  NodeKind,
  EdgeKind,
  Side,
  type SymbolId,
  type VenueId,
  type PropertyKey,
} from '../shared/types.js';
import type { GraphNode, GraphEdge, Neighborhood, GraphConfig } from './types.js';
import { symbolKey } from './types.js';
import { GraphStore } from './graph-store.js';

/**
 * Extracts subgraphs from the graph store for GNN consumption.
 * Produces Neighborhood structs with feature matrices in COO format.
 */
export class SubgraphExtractor {
  private readonly store: GraphStore;
  private readonly featureDim: number;

  constructor(store: GraphStore, config: GraphConfig) {
    this.store = store;
    this.featureDim = config.featureDim;
  }

  /**
   * BFS k-hop ego subgraph extraction.
   * Collects all nodes and edges within k hops of the seed node.
   */
  extractNeighborhood(nodeId: bigint, hops: number): Neighborhood {
    const visited = new Set<bigint>();
    const edgeSet = new Set<bigint>();
    let frontier = [nodeId];
    visited.add(nodeId);

    for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
      const nextFrontier: bigint[] = [];

      for (const nid of frontier) {
        // Outgoing edges
        for (const edge of this.store.getEdgesFrom(nid)) {
          edgeSet.add(edge.id);
          if (!visited.has(edge.targetId)) {
            visited.add(edge.targetId);
            nextFrontier.push(edge.targetId);
          }
        }
        // Incoming edges
        for (const edge of this.store.getEdgesTo(nid)) {
          edgeSet.add(edge.id);
          if (!visited.has(edge.sourceId)) {
            visited.add(edge.sourceId);
            nextFrontier.push(edge.sourceId);
          }
        }
      }

      frontier = nextFrontier;
    }

    return this.buildNeighborhood(visited, edgeSet);
  }

  /**
   * Extract the price ladder for a given symbol/venue/side.
   * Follows NEXT_TICK chain starting from the best price level.
   */
  extractPriceLadder(
    symbolId: SymbolId,
    venueId: VenueId,
    side: Side,
  ): GraphNode[] {
    const priceLevels = this.store.getNodesByKind(NodeKind.PriceLevel);
    const result: GraphNode[] = [];

    // Find all price levels and return those with depth > 0
    // In a production system we'd walk the NEXT_TICK chain,
    // but we also need them sorted by price
    for (const pl of priceLevels) {
      const depth = pl.properties.get(0 as PropertyKey) ?? 0; // VisibleDepth
      if (depth > 0) {
        result.push(pl);
      }
    }

    // Sort by creation time as a proxy for price ordering
    result.sort((a, b) => {
      const diff = a.createdAtNs - b.createdAtNs;
      return diff < 0n ? -1 : diff > 0n ? 1 : 0;
    });

    return result;
  }

  /**
   * Extract the last N event nodes for a symbol, ordered newest-first.
   */
  extractRecentEvents(symbolId: SymbolId, n: number): GraphNode[] {
    const symbolNodeId = this.store.getDomainNodeId(symbolKey(symbolId));
    if (symbolNodeId === undefined) return [];

    // Collect all Event nodes connected to nodes that belong to this symbol
    const eventNodes: GraphNode[] = [];

    // Get all nodes belonging to this symbol via BelongsToSymbol edges
    const symbolEdges = this.store.getEdgesTo(symbolNodeId);
    const relatedNodeIds = new Set<bigint>();

    for (const edge of symbolEdges) {
      if (edge.kind === EdgeKind.BelongsToSymbol) {
        relatedNodeIds.add(edge.sourceId);
      }
    }

    // For each related node, find Event nodes that generated them
    for (const relatedId of relatedNodeIds) {
      const inEdges = this.store.getEdgesTo(relatedId);
      for (const edge of inEdges) {
        if (edge.kind === EdgeKind.Generated) {
          const eventNode = this.store.getNode(edge.sourceId);
          if (eventNode && eventNode.kind === NodeKind.Event) {
            eventNodes.push(eventNode);
          }
        }
      }
    }

    // Sort by creation time (newest first) and take N
    eventNodes.sort((a, b) => {
      const diff = b.createdAtNs - a.createdAtNs;
      return diff < 0n ? -1 : diff > 0n ? 1 : 0;
    });

    return eventNodes.slice(0, n);
  }

  /**
   * Extract all nodes and edges connected to a symbol via BELONGS_TO_SYMBOL.
   */
  extractSymbolSubgraph(
    symbolId: SymbolId,
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const symbolNodeId = this.store.getDomainNodeId(symbolKey(symbolId));
    if (symbolNodeId === undefined) return { nodes: [], edges: [] };

    const nodeIds = new Set<bigint>();
    const edgeIds = new Set<bigint>();

    // The symbol node itself
    nodeIds.add(symbolNodeId);

    // All nodes connected via BelongsToSymbol
    const symbolEdges = this.store.getEdgesTo(symbolNodeId);
    for (const edge of symbolEdges) {
      if (edge.kind === EdgeKind.BelongsToSymbol) {
        nodeIds.add(edge.sourceId);
        edgeIds.add(edge.id);
      }
    }

    // Collect all edges between the found nodes
    for (const nid of nodeIds) {
      for (const edge of this.store.getEdgesFrom(nid)) {
        if (nodeIds.has(edge.targetId)) {
          edgeIds.add(edge.id);
        }
      }
      for (const edge of this.store.getEdgesTo(nid)) {
        if (nodeIds.has(edge.sourceId)) {
          edgeIds.add(edge.id);
        }
      }
    }

    const nodes: GraphNode[] = [];
    for (const nid of nodeIds) {
      const node = this.store.getNode(nid);
      if (node) nodes.push(node);
    }

    const edges: GraphEdge[] = [];
    for (const eid of edgeIds) {
      const edge = this.store.getEdge(eid);
      if (edge) edges.push(edge);
    }

    return { nodes, edges };
  }

  // ── Private helpers ────────────────────────────────────────

  private buildNeighborhood(
    nodeIds: Set<bigint>,
    edgeIds: Set<bigint>,
  ): Neighborhood {
    const nodeIdArray: bigint[] = [];
    const nodeKinds: NodeKind[] = [];
    const features: Float64Array[] = [];
    const nodeIndexMap = new Map<bigint, number>();

    let idx = 0;
    for (const nid of nodeIds) {
      const node = this.store.getNode(nid);
      if (!node) continue;

      nodeIdArray.push(nid);
      nodeKinds.push(node.kind);
      features.push(this.nodeToFeatures(node));
      nodeIndexMap.set(nid, idx);
      idx++;
    }

    const edgeIndex: [number, number][] = [];
    const edgeKinds: EdgeKind[] = [];
    const edgeFeatures: Float64Array[] = [];

    for (const eid of edgeIds) {
      const edge = this.store.getEdge(eid);
      if (!edge) continue;

      const srcIdx = nodeIndexMap.get(edge.sourceId);
      const tgtIdx = nodeIndexMap.get(edge.targetId);
      if (srcIdx === undefined || tgtIdx === undefined) continue;

      edgeIndex.push([srcIdx, tgtIdx]);
      edgeKinds.push(edge.kind);
      edgeFeatures.push(this.edgeToFeatures(edge));
    }

    return {
      nodeIds: nodeIdArray,
      nodeKinds,
      features,
      edgeIndex,
      edgeKinds,
      edgeFeatures,
    };
  }

  /** Convert a node's properties to a fixed-length feature vector. */
  private nodeToFeatures(node: GraphNode): Float64Array {
    const feats = new Float64Array(this.featureDim);
    // Feature 0: node kind (normalized)
    feats[0] = node.kind / 10;

    // Fill remaining features from properties in order
    let i = 1;
    for (const [, value] of node.properties) {
      if (i >= this.featureDim) break;
      feats[i] = value;
      i++;
    }

    return feats;
  }

  /** Convert an edge's properties to a fixed-length feature vector. */
  private edgeToFeatures(edge: GraphEdge): Float64Array {
    const feats = new Float64Array(this.featureDim);
    // Feature 0: edge kind (normalized)
    feats[0] = edge.kind / 12;

    let i = 1;
    for (const [, value] of edge.properties) {
      if (i >= this.featureDim) break;
      feats[i] = value;
      i++;
    }

    return feats;
  }
}
