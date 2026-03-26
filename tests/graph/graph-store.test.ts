import { describe, it, expect, beforeEach } from 'vitest';
import { GraphStore } from '../../src/graph/graph-store.js';
import { NodeKind, EdgeKind, PropertyKey } from '../../src/shared/types.js';

describe('GraphStore', () => {
  let store: GraphStore;

  beforeEach(() => {
    store = new GraphStore();
  });

  describe('addNode / getNode', () => {
    it('should add a node and retrieve it by id', () => {
      const node = store.addNode({
        kind: NodeKind.Symbol,
        properties: new Map([[PropertyKey.InfluenceScore, 42]]),
        createdAtNs: 1000n,
        updatedAtNs: 1000n,
      });

      expect(node.id).toBeGreaterThan(0n);
      expect(node.kind).toBe(NodeKind.Symbol);

      const retrieved = store.getNode(node.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.kind).toBe(NodeKind.Symbol);
      expect(retrieved!.properties.get(PropertyKey.InfluenceScore)).toBe(42);
    });

    it('should auto-assign incrementing ids', () => {
      const n1 = store.addNode({
        kind: NodeKind.Order,
        properties: new Map(),
        createdAtNs: 100n,
        updatedAtNs: 100n,
      });
      const n2 = store.addNode({
        kind: NodeKind.Order,
        properties: new Map(),
        createdAtNs: 200n,
        updatedAtNs: 200n,
      });

      expect(n2.id).toBe(n1.id + 1n);
    });

    it('should return undefined for non-existent node', () => {
      expect(store.getNode(999n)).toBeUndefined();
    });
  });

  describe('addEdge / getEdge', () => {
    it('should add an edge and retrieve it', () => {
      const n1 = store.addNode({
        kind: NodeKind.Order,
        properties: new Map(),
        createdAtNs: 100n,
        updatedAtNs: 100n,
      });
      const n2 = store.addNode({
        kind: NodeKind.PriceLevel,
        properties: new Map(),
        createdAtNs: 100n,
        updatedAtNs: 100n,
      });

      const edge = store.addEdge({
        kind: EdgeKind.AtLevel,
        sourceId: n1.id,
        targetId: n2.id,
        properties: new Map(),
        createdAtNs: 100n,
      });

      expect(edge.id).toBeGreaterThan(0n);
      expect(edge.kind).toBe(EdgeKind.AtLevel);

      const retrieved = store.getEdge(edge.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.sourceId).toBe(n1.id);
      expect(retrieved!.targetId).toBe(n2.id);
    });
  });

  describe('adjacency queries', () => {
    it('should return outgoing edges', () => {
      const n1 = store.addNode({
        kind: NodeKind.Order,
        properties: new Map(),
        createdAtNs: 100n,
        updatedAtNs: 100n,
      });
      const n2 = store.addNode({
        kind: NodeKind.PriceLevel,
        properties: new Map(),
        createdAtNs: 100n,
        updatedAtNs: 100n,
      });
      const n3 = store.addNode({
        kind: NodeKind.Symbol,
        properties: new Map(),
        createdAtNs: 100n,
        updatedAtNs: 100n,
      });

      store.addEdge({
        kind: EdgeKind.AtLevel,
        sourceId: n1.id,
        targetId: n2.id,
        properties: new Map(),
        createdAtNs: 100n,
      });
      store.addEdge({
        kind: EdgeKind.BelongsToSymbol,
        sourceId: n1.id,
        targetId: n3.id,
        properties: new Map(),
        createdAtNs: 100n,
      });

      const outgoing = store.getEdgesFrom(n1.id);
      expect(outgoing).toHaveLength(2);
    });

    it('should return incoming edges', () => {
      const n1 = store.addNode({
        kind: NodeKind.Event,
        properties: new Map(),
        createdAtNs: 100n,
        updatedAtNs: 100n,
      });
      const n2 = store.addNode({
        kind: NodeKind.Order,
        properties: new Map(),
        createdAtNs: 100n,
        updatedAtNs: 100n,
      });

      store.addEdge({
        kind: EdgeKind.Generated,
        sourceId: n1.id,
        targetId: n2.id,
        properties: new Map(),
        createdAtNs: 100n,
      });

      const incoming = store.getEdgesTo(n2.id);
      expect(incoming).toHaveLength(1);
      expect(incoming[0].kind).toBe(EdgeKind.Generated);
    });

    it('should filter edges by kind', () => {
      const n1 = store.addNode({
        kind: NodeKind.Order,
        properties: new Map(),
        createdAtNs: 100n,
        updatedAtNs: 100n,
      });
      const n2 = store.addNode({
        kind: NodeKind.PriceLevel,
        properties: new Map(),
        createdAtNs: 100n,
        updatedAtNs: 100n,
      });
      const n3 = store.addNode({
        kind: NodeKind.Symbol,
        properties: new Map(),
        createdAtNs: 100n,
        updatedAtNs: 100n,
      });

      store.addEdge({
        kind: EdgeKind.AtLevel,
        sourceId: n1.id,
        targetId: n2.id,
        properties: new Map(),
        createdAtNs: 100n,
      });
      store.addEdge({
        kind: EdgeKind.BelongsToSymbol,
        sourceId: n1.id,
        targetId: n3.id,
        properties: new Map(),
        createdAtNs: 100n,
      });

      const atLevel = store.getEdgesFromByKind(n1.id, EdgeKind.AtLevel);
      expect(atLevel).toHaveLength(1);
      expect(atLevel[0].targetId).toBe(n2.id);
    });
  });

  describe('kind-based queries', () => {
    it('should return nodes by kind', () => {
      store.addNode({
        kind: NodeKind.Order,
        properties: new Map(),
        createdAtNs: 100n,
        updatedAtNs: 100n,
      });
      store.addNode({
        kind: NodeKind.Order,
        properties: new Map(),
        createdAtNs: 200n,
        updatedAtNs: 200n,
      });
      store.addNode({
        kind: NodeKind.Symbol,
        properties: new Map(),
        createdAtNs: 300n,
        updatedAtNs: 300n,
      });

      const orders = store.getNodesByKind(NodeKind.Order);
      expect(orders).toHaveLength(2);

      const symbols = store.getNodesByKind(NodeKind.Symbol);
      expect(symbols).toHaveLength(1);

      const trades = store.getNodesByKind(NodeKind.Trade);
      expect(trades).toHaveLength(0);
    });
  });

  describe('domain key index', () => {
    it('should look up nodes by domain key', () => {
      const node = store.addNode(
        {
          kind: NodeKind.Symbol,
          properties: new Map(),
          createdAtNs: 100n,
          updatedAtNs: 100n,
        },
        'sym:1',
      );

      const found = store.getNodeByDomainKey('sym:1');
      expect(found).toBeDefined();
      expect(found!.id).toBe(node.id);

      expect(store.getNodeByDomainKey('sym:999')).toBeUndefined();
    });

    it('should support setDomainKey', () => {
      const node = store.addNode({
        kind: NodeKind.Venue,
        properties: new Map(),
        createdAtNs: 100n,
        updatedAtNs: 100n,
      });

      store.setDomainKey('ven:42', node.id);
      expect(store.getDomainNodeId('ven:42')).toBe(node.id);
    });
  });

  describe('removeNode', () => {
    it('should remove a node and its connected edges', () => {
      const n1 = store.addNode({
        kind: NodeKind.Order,
        properties: new Map(),
        createdAtNs: 100n,
        updatedAtNs: 100n,
      });
      const n2 = store.addNode({
        kind: NodeKind.PriceLevel,
        properties: new Map(),
        createdAtNs: 100n,
        updatedAtNs: 100n,
      });

      store.addEdge({
        kind: EdgeKind.AtLevel,
        sourceId: n1.id,
        targetId: n2.id,
        properties: new Map(),
        createdAtNs: 100n,
      });

      expect(store.nodeCount()).toBe(2);
      expect(store.edgeCount()).toBe(1);

      const removed = store.removeNode(n1.id);
      expect(removed).toBe(true);
      expect(store.nodeCount()).toBe(1);
      expect(store.edgeCount()).toBe(0);
      expect(store.getNode(n1.id)).toBeUndefined();
    });

    it('should return false for non-existent node', () => {
      expect(store.removeNode(999n)).toBe(false);
    });

    it('should update kind index on removal', () => {
      const n = store.addNode({
        kind: NodeKind.Event,
        properties: new Map(),
        createdAtNs: 100n,
        updatedAtNs: 100n,
      });

      expect(store.getNodesByKind(NodeKind.Event)).toHaveLength(1);
      store.removeNode(n.id);
      expect(store.getNodesByKind(NodeKind.Event)).toHaveLength(0);
    });
  });

  describe('removeEdge', () => {
    it('should remove an edge and update adjacency lists', () => {
      const n1 = store.addNode({
        kind: NodeKind.Order,
        properties: new Map(),
        createdAtNs: 100n,
        updatedAtNs: 100n,
      });
      const n2 = store.addNode({
        kind: NodeKind.PriceLevel,
        properties: new Map(),
        createdAtNs: 100n,
        updatedAtNs: 100n,
      });

      const edge = store.addEdge({
        kind: EdgeKind.AtLevel,
        sourceId: n1.id,
        targetId: n2.id,
        properties: new Map(),
        createdAtNs: 100n,
      });

      expect(store.removeEdge(edge.id)).toBe(true);
      expect(store.edgeCount()).toBe(0);
      expect(store.getEdgesFrom(n1.id)).toHaveLength(0);
      expect(store.getEdgesTo(n2.id)).toHaveLength(0);
    });
  });

  describe('nodeCount / edgeCount', () => {
    it('should track counts accurately', () => {
      expect(store.nodeCount()).toBe(0);
      expect(store.edgeCount()).toBe(0);

      const n1 = store.addNode({
        kind: NodeKind.Order,
        properties: new Map(),
        createdAtNs: 100n,
        updatedAtNs: 100n,
      });
      expect(store.nodeCount()).toBe(1);

      const n2 = store.addNode({
        kind: NodeKind.PriceLevel,
        properties: new Map(),
        createdAtNs: 100n,
        updatedAtNs: 100n,
      });
      expect(store.nodeCount()).toBe(2);

      store.addEdge({
        kind: EdgeKind.AtLevel,
        sourceId: n1.id,
        targetId: n2.id,
        properties: new Map(),
        createdAtNs: 100n,
      });
      expect(store.edgeCount()).toBe(1);
    });
  });

  describe('clear', () => {
    it('should reset the entire graph', () => {
      store.addNode({
        kind: NodeKind.Order,
        properties: new Map(),
        createdAtNs: 100n,
        updatedAtNs: 100n,
      });
      store.addNode({
        kind: NodeKind.PriceLevel,
        properties: new Map(),
        createdAtNs: 100n,
        updatedAtNs: 100n,
      });

      store.clear();
      expect(store.nodeCount()).toBe(0);
      expect(store.edgeCount()).toBe(0);
      expect(store.getNodesByKind(NodeKind.Order)).toHaveLength(0);
    });
  });
});
