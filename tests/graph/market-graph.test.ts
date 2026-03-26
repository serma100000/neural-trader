import { describe, it, expect, beforeEach } from 'vitest';
import { MarketGraph } from '../../src/graph/market-graph.js';
import { NodeKind, Side } from '../../src/shared/types.js';
import {
  resetCounters,
  newOrderEvent,
  tradeEvent,
  cancelOrderEvent,
  sessionMarkerEvent,
  bookSnapshotEvent,
  makeOrderId,
  generateEventBatch,
  ts,
  qty,
  price,
  TEST_SYMBOL,
  TEST_VENUE,
} from './test-helpers.js';

describe('MarketGraph', () => {
  let graph: MarketGraph;

  beforeEach(() => {
    resetCounters();
    graph = new MarketGraph({
      retentionWindowNs: 30_000_000_000n,
      nodeHardCap: 100_000,
    });
  });

  describe('applyEvent', () => {
    it('should apply a single event and update counts', () => {
      const delta = graph.applyEvent(newOrderEvent());

      expect(delta.nodesAdded).toBeGreaterThan(0);
      expect(graph.nodeCount()).toBeGreaterThan(0);
      expect(graph.edgeCount()).toBeGreaterThan(0);
    });

    it('should handle all event types without error', () => {
      const orderId = makeOrderId('all-types');

      graph.applyEvent(newOrderEvent({ orderIdHash: orderId }));
      graph.applyEvent(tradeEvent({ orderIdHash: orderId, qtyFp: qty(10) }));
      graph.applyEvent(cancelOrderEvent(orderId));
      graph.applyEvent(sessionMarkerEvent());
      graph.applyEvent(bookSnapshotEvent());

      expect(graph.nodeCount()).toBeGreaterThan(5);
    });
  });

  describe('applyEventBatch', () => {
    it('should apply a batch and return aggregated delta', () => {
      const events = [
        newOrderEvent({ orderIdHash: makeOrderId('b1') }),
        newOrderEvent({ orderIdHash: makeOrderId('b2') }),
        newOrderEvent({ orderIdHash: makeOrderId('b3') }),
      ];

      const delta = graph.applyEventBatch(events);

      expect(delta.nodesAdded).toBeGreaterThanOrEqual(6); // 3 orders + 3 events
      expect(delta.edgesAdded).toBeGreaterThanOrEqual(12); // 4 edges per order
    });
  });

  describe('extractNeighborhood', () => {
    it('should extract a 1-hop neighborhood', () => {
      const orderId = makeOrderId('neigh');
      graph.applyEvent(newOrderEvent({ orderIdHash: orderId }));

      // Get the order node
      const store = graph.getStore();
      const orders = store.getNodesByKind(NodeKind.Order);
      expect(orders).toHaveLength(1);

      const neighborhood = graph.extractNeighborhood(orders[0].id, 1);

      expect(neighborhood.nodeIds.length).toBeGreaterThan(1);
      expect(neighborhood.features.length).toBe(neighborhood.nodeIds.length);
      expect(neighborhood.edgeIndex.length).toBeGreaterThan(0);
      expect(neighborhood.nodeKinds.length).toBe(neighborhood.nodeIds.length);
    });

    it('should extract a 2-hop neighborhood with more nodes', () => {
      graph.applyEvent(newOrderEvent({ orderIdHash: makeOrderId('n1') }));
      graph.applyEvent(newOrderEvent({ orderIdHash: makeOrderId('n2') }));

      const store = graph.getStore();
      const orders = store.getNodesByKind(NodeKind.Order);

      const hop1 = graph.extractNeighborhood(orders[0].id, 1);
      const hop2 = graph.extractNeighborhood(orders[0].id, 2);

      // 2-hop should include more or equal nodes than 1-hop
      expect(hop2.nodeIds.length).toBeGreaterThanOrEqual(hop1.nodeIds.length);
    });

    it('should produce valid COO format edge indices', () => {
      graph.applyEvent(newOrderEvent({ orderIdHash: makeOrderId('coo') }));

      const store = graph.getStore();
      const orders = store.getNodesByKind(NodeKind.Order);
      const neighborhood = graph.extractNeighborhood(orders[0].id, 1);

      for (const [src, tgt] of neighborhood.edgeIndex) {
        expect(src).toBeGreaterThanOrEqual(0);
        expect(src).toBeLessThan(neighborhood.nodeIds.length);
        expect(tgt).toBeGreaterThanOrEqual(0);
        expect(tgt).toBeLessThan(neighborhood.nodeIds.length);
      }
    });
  });

  describe('getPriceLadder', () => {
    it('should return price level nodes with depth', () => {
      graph.applyEvent(
        bookSnapshotEvent({ priceFp: price(10000), qtyFp: qty(100), side: Side.Bid }),
      );
      graph.applyEvent(
        bookSnapshotEvent({ priceFp: price(10010), qtyFp: qty(200), side: Side.Bid }),
      );

      const ladder = graph.getPriceLadder(TEST_SYMBOL, TEST_VENUE, Side.Bid);
      expect(ladder.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getRecentEvents', () => {
    it('should return event nodes for a symbol', () => {
      graph.applyEvent(newOrderEvent({ orderIdHash: makeOrderId('re1') }));
      graph.applyEvent(newOrderEvent({ orderIdHash: makeOrderId('re2') }));
      graph.applyEvent(newOrderEvent({ orderIdHash: makeOrderId('re3') }));

      const recent = graph.getRecentEvents(TEST_SYMBOL, 2);
      expect(recent.length).toBeLessThanOrEqual(2);
      for (const e of recent) {
        expect(e.kind).toBe(NodeKind.Event);
      }
    });

    it('should return empty for unknown symbol', () => {
      const recent = graph.getRecentEvents(999 as any, 5);
      expect(recent).toHaveLength(0);
    });
  });

  describe('getSymbolSubgraph', () => {
    it('should return all nodes belonging to a symbol', () => {
      graph.applyEvent(newOrderEvent({ orderIdHash: makeOrderId('sg1') }));
      graph.applyEvent(tradeEvent());

      const subgraph = graph.getSymbolSubgraph(TEST_SYMBOL);
      expect(subgraph.nodes.length).toBeGreaterThan(0);
      expect(subgraph.edges.length).toBeGreaterThan(0);
    });

    it('should return empty for unknown symbol', () => {
      const subgraph = graph.getSymbolSubgraph(999 as any);
      expect(subgraph.nodes).toHaveLength(0);
      expect(subgraph.edges).toHaveLength(0);
    });
  });

  describe('compact', () => {
    it('should remove stale nodes and return stats', () => {
      // Add old events
      graph.applyEvent(
        newOrderEvent({ tsExchangeNs: ts(1_000_000_000), orderIdHash: makeOrderId('old1') }),
      );
      // Add recent events
      graph.applyEvent(
        newOrderEvent({ tsExchangeNs: ts(50_000_000_000), orderIdHash: makeOrderId('new1') }),
      );

      const countBefore = graph.nodeCount();
      const stats = graph.compact();

      expect(stats.nodesRemoved).toBeGreaterThan(0);
      expect(graph.nodeCount()).toBeLessThan(countBefore);
    });
  });

  describe('getStateWindow', () => {
    it('should return a valid state window', () => {
      graph.applyEvent(
        newOrderEvent({ tsExchangeNs: ts(10_000_000_000), orderIdHash: makeOrderId('sw1') }),
      );
      graph.applyEvent(
        newOrderEvent({ tsExchangeNs: ts(20_000_000_000), orderIdHash: makeOrderId('sw2') }),
      );

      const window = graph.getStateWindow(TEST_SYMBOL, TEST_VENUE, 15_000_000_000n);

      expect(window.symbolId).toBe(TEST_SYMBOL);
      expect(window.venueId).toBe(TEST_VENUE);
      expect(window.endNs).toBe(20_000_000_000n);
      expect(window.startNs).toBe(5_000_000_000n);
      expect(window.nodeCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('integration: 1000 synthetic events', () => {
    it('should ingest 1000 events and maintain graph consistency', () => {
      const events = generateEventBatch(1000, {
        startNs: 1_000_000_000n,
      });

      const delta = graph.applyEventBatch(events);

      expect(delta.nodesAdded).toBeGreaterThan(500);
      expect(delta.edgesAdded).toBeGreaterThan(500);
      expect(graph.nodeCount()).toBeGreaterThan(100);
      expect(graph.edgeCount()).toBeGreaterThan(100);

      // Verify structural integrity: every edge points to existing nodes
      const store = graph.getStore();
      for (const edge of store.allEdges()) {
        const source = store.getNode(edge.sourceId);
        const target = store.getNode(edge.targetId);
        expect(source).toBeDefined();
        expect(target).toBeDefined();
      }
    });

    it('should extract neighborhoods from a large graph', () => {
      const events = generateEventBatch(500, { startNs: 1_000_000_000n });
      graph.applyEventBatch(events);

      const store = graph.getStore();
      const orders = store.getNodesByKind(NodeKind.Order);
      expect(orders.length).toBeGreaterThan(0);

      const neighborhood = graph.extractNeighborhood(orders[0].id, 2);
      expect(neighborhood.nodeIds.length).toBeGreaterThan(1);

      // Verify feature dimensions
      for (const feat of neighborhood.features) {
        expect(feat).toBeInstanceOf(Float64Array);
        expect(feat.length).toBe(8); // default featureDim
      }
    });

    it('should compact a large graph and maintain consistency', () => {
      // Events spread over a wide time range
      const events = generateEventBatch(500, {
        startNs: 1_000_000_000n,
      });
      graph.applyEventBatch(events);

      // Move time far ahead so most events are stale
      graph.applyEvent(
        newOrderEvent({
          tsExchangeNs: ts(100_000_000_000),
          orderIdHash: makeOrderId('future'),
        }),
      );

      const countBefore = graph.nodeCount();
      const stats = graph.compact();

      expect(stats.nodesRemoved).toBeGreaterThan(0);
      expect(graph.nodeCount()).toBeLessThan(countBefore);

      // Verify structural integrity after compaction
      const store = graph.getStore();
      for (const edge of store.allEdges()) {
        const source = store.getNode(edge.sourceId);
        const target = store.getNode(edge.targetId);
        expect(source).toBeDefined();
        expect(target).toBeDefined();
      }
    });
  });

  describe('emergency compaction', () => {
    it('should trigger emergency compaction when hard cap is exceeded', () => {
      const smallGraph = new MarketGraph({
        retentionWindowNs: 60_000_000_000n,
        nodeHardCap: 50,
      });

      const events = generateEventBatch(100, { startNs: 1_000_000_000n });

      // This should trigger emergency compaction internally
      smallGraph.applyEventBatch(events);

      // After emergency compaction, should be at or below the cap
      expect(smallGraph.nodeCount()).toBeLessThanOrEqual(50);
    });
  });
});
