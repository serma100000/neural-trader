import type { NodeKind, EdgeKind } from '../shared/types.js';
import type { GraphNode, GraphEdge, DomainKey } from './types.js';

/**
 * In-memory graph store backed by Maps with adjacency lists and
 * secondary indices for fast kind-based and domain-key lookups.
 */
export class GraphStore {
  private nodes = new Map<bigint, GraphNode>();
  private edges = new Map<bigint, GraphEdge>();

  /** Outgoing adjacency: sourceId -> Set<edgeId> */
  private outgoing = new Map<bigint, Set<bigint>>();
  /** Incoming adjacency: targetId -> Set<edgeId> */
  private incoming = new Map<bigint, Set<bigint>>();

  /** Secondary index: NodeKind -> Set<nodeId> */
  private kindIndex = new Map<NodeKind, Set<bigint>>();

  /** Secondary index: DomainKey -> nodeId */
  private domainIndex = new Map<DomainKey, bigint>();

  private nextNodeId = 1n;
  private nextEdgeId = 1n;

  // ── Node CRUD ────────────────────────────────────────────────

  /** Add a node, assigning an id if 0n. Returns the stored node. */
  addNode(node: Omit<GraphNode, 'id'> & { id?: bigint }, domainKey?: DomainKey): GraphNode {
    const id = node.id && node.id !== 0n ? node.id : this.nextNodeId++;
    if (id >= this.nextNodeId) {
      this.nextNodeId = id + 1n;
    }

    const stored: GraphNode = {
      id,
      kind: node.kind,
      properties: new Map(node.properties),
      createdAtNs: node.createdAtNs,
      updatedAtNs: node.updatedAtNs,
    };

    this.nodes.set(id, stored);

    // Kind index
    let kindSet = this.kindIndex.get(stored.kind);
    if (!kindSet) {
      kindSet = new Set();
      this.kindIndex.set(stored.kind, kindSet);
    }
    kindSet.add(id);

    // Domain index
    if (domainKey) {
      this.domainIndex.set(domainKey, id);
    }

    return stored;
  }

  /** Add an edge, assigning an id if 0n. Returns the stored edge. */
  addEdge(edge: Omit<GraphEdge, 'id'> & { id?: bigint }): GraphEdge {
    const id = edge.id && edge.id !== 0n ? edge.id : this.nextEdgeId++;
    if (id >= this.nextEdgeId) {
      this.nextEdgeId = id + 1n;
    }

    const stored: GraphEdge = {
      id,
      kind: edge.kind,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      properties: new Map(edge.properties),
      createdAtNs: edge.createdAtNs,
    };

    this.edges.set(id, stored);

    // Outgoing adjacency
    let outSet = this.outgoing.get(stored.sourceId);
    if (!outSet) {
      outSet = new Set();
      this.outgoing.set(stored.sourceId, outSet);
    }
    outSet.add(id);

    // Incoming adjacency
    let inSet = this.incoming.get(stored.targetId);
    if (!inSet) {
      inSet = new Set();
      this.incoming.set(stored.targetId, inSet);
    }
    inSet.add(id);

    return stored;
  }

  getNode(id: bigint): GraphNode | undefined {
    return this.nodes.get(id);
  }

  getEdge(id: bigint): GraphEdge | undefined {
    return this.edges.get(id);
  }

  /** Look up a node by its domain key (e.g., symbol, venue, price level). */
  getNodeByDomainKey(key: DomainKey): GraphNode | undefined {
    const id = this.domainIndex.get(key);
    return id !== undefined ? this.nodes.get(id) : undefined;
  }

  /** Get the node id for a domain key. */
  getDomainNodeId(key: DomainKey): bigint | undefined {
    return this.domainIndex.get(key);
  }

  /** Set a domain key -> nodeId mapping. */
  setDomainKey(key: DomainKey, nodeId: bigint): void {
    this.domainIndex.set(key, nodeId);
  }

  getNodesByKind(kind: NodeKind): GraphNode[] {
    const ids = this.kindIndex.get(kind);
    if (!ids) return [];
    const result: GraphNode[] = [];
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (node) result.push(node);
    }
    return result;
  }

  getEdgesFrom(nodeId: bigint): GraphEdge[] {
    const ids = this.outgoing.get(nodeId);
    if (!ids) return [];
    const result: GraphEdge[] = [];
    for (const id of ids) {
      const edge = this.edges.get(id);
      if (edge) result.push(edge);
    }
    return result;
  }

  getEdgesTo(nodeId: bigint): GraphEdge[] {
    const ids = this.incoming.get(nodeId);
    if (!ids) return [];
    const result: GraphEdge[] = [];
    for (const id of ids) {
      const edge = this.edges.get(id);
      if (edge) result.push(edge);
    }
    return result;
  }

  /** Get all edges of a given kind from a node. */
  getEdgesFromByKind(nodeId: bigint, kind: EdgeKind): GraphEdge[] {
    return this.getEdgesFrom(nodeId).filter((e) => e.kind === kind);
  }

  /** Get all edges of a given kind pointing to a node. */
  getEdgesToByKind(nodeId: bigint, kind: EdgeKind): GraphEdge[] {
    return this.getEdgesTo(nodeId).filter((e) => e.kind === kind);
  }

  removeNode(id: bigint): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;

    // Remove from kind index
    const kindSet = this.kindIndex.get(node.kind);
    if (kindSet) {
      kindSet.delete(id);
      if (kindSet.size === 0) this.kindIndex.delete(node.kind);
    }

    // Remove domain keys pointing to this node
    for (const [key, nodeId] of this.domainIndex) {
      if (nodeId === id) {
        this.domainIndex.delete(key);
        break; // each node has at most one domain key
      }
    }

    // Remove all connected edges
    const outEdges = this.outgoing.get(id);
    if (outEdges) {
      for (const edgeId of outEdges) {
        const edge = this.edges.get(edgeId);
        if (edge) {
          const targetIn = this.incoming.get(edge.targetId);
          if (targetIn) {
            targetIn.delete(edgeId);
            if (targetIn.size === 0) this.incoming.delete(edge.targetId);
          }
          this.edges.delete(edgeId);
        }
      }
      this.outgoing.delete(id);
    }

    const inEdges = this.incoming.get(id);
    if (inEdges) {
      for (const edgeId of inEdges) {
        const edge = this.edges.get(edgeId);
        if (edge) {
          const sourceOut = this.outgoing.get(edge.sourceId);
          if (sourceOut) {
            sourceOut.delete(edgeId);
            if (sourceOut.size === 0) this.outgoing.delete(edge.sourceId);
          }
          this.edges.delete(edgeId);
        }
      }
      this.incoming.delete(id);
    }

    this.nodes.delete(id);
    return true;
  }

  removeEdge(id: bigint): boolean {
    const edge = this.edges.get(id);
    if (!edge) return false;

    const outSet = this.outgoing.get(edge.sourceId);
    if (outSet) {
      outSet.delete(id);
      if (outSet.size === 0) this.outgoing.delete(edge.sourceId);
    }

    const inSet = this.incoming.get(edge.targetId);
    if (inSet) {
      inSet.delete(id);
      if (inSet.size === 0) this.incoming.delete(edge.targetId);
    }

    this.edges.delete(id);
    return true;
  }

  nodeCount(): number {
    return this.nodes.size;
  }

  edgeCount(): number {
    return this.edges.size;
  }

  /** Iterate over all nodes. */
  allNodes(): IterableIterator<GraphNode> {
    return this.nodes.values();
  }

  /** Iterate over all edges. */
  allEdges(): IterableIterator<GraphEdge> {
    return this.edges.values();
  }

  /** Iterate over all node IDs. */
  allNodeIds(): IterableIterator<bigint> {
    return this.nodes.keys();
  }

  /** Clear the entire graph. */
  clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.outgoing.clear();
    this.incoming.clear();
    this.kindIndex.clear();
    this.domainIndex.clear();
    this.nextNodeId = 1n;
    this.nextEdgeId = 1n;
  }
}
