import { describe, it, expect, beforeEach } from 'vitest';
import { GraphStore } from '../../src/graph/graph-store.js';
import { GraphUpdater } from '../../src/graph/graph-updater.js';
import { DEFAULT_GRAPH_CONFIG } from '../../src/graph/types.js';
import { NodeKind, EdgeKind, PropertyKey } from '../../src/shared/types.js';
import {
  resetCounters,
  newOrderEvent,
  modifyOrderEvent,
  cancelOrderEvent,
  tradeEvent,
  bookSnapshotEvent,
  sessionMarkerEvent,
  venueStatusEvent,
  makeOrderId,
  qty,
  ts,
} from './test-helpers.js';

describe('GraphUpdater', () => {
  let store: GraphStore;
  let updater: GraphUpdater;

  beforeEach(() => {
    resetCounters();
    store = new GraphStore();
    updater = new GraphUpdater(store, DEFAULT_GRAPH_CONFIG);
  });

  describe('NewOrder', () => {
    it('should create Order and Event nodes with correct edges', () => {
      const event = newOrderEvent();
      const delta = updater.applyEvent(event);

      expect(delta.nodesAdded).toBe(2); // Order + Event
      expect(delta.edgesAdded).toBe(4); // AtLevel, Generated, BelongsToSymbol, OnVenue

      // Verify Order node exists
      const orders = store.getNodesByKind(NodeKind.Order);
      expect(orders).toHaveLength(1);
      expect(orders[0].properties.get(PropertyKey.VisibleDepth)).toBe(100);

      // Verify Event node exists
      const events = store.getNodesByKind(NodeKind.Event);
      expect(events).toHaveLength(1);

      // Verify PriceLevel was created
      const levels = store.getNodesByKind(NodeKind.PriceLevel);
      expect(levels).toHaveLength(1);
      expect(levels[0].properties.get(PropertyKey.VisibleDepth)).toBe(100);

      // Verify Symbol and Venue nodes
      const symbols = store.getNodesByKind(NodeKind.Symbol);
      expect(symbols).toHaveLength(1);
      const venues = store.getNodesByKind(NodeKind.Venue);
      expect(venues).toHaveLength(1);
    });

    it('should reuse existing Symbol/Venue nodes', () => {
      updater.applyEvent(newOrderEvent());
      updater.applyEvent(newOrderEvent({ orderIdHash: makeOrderId('second') }));

      const symbols = store.getNodesByKind(NodeKind.Symbol);
      expect(symbols).toHaveLength(1);

      const venues = store.getNodesByKind(NodeKind.Venue);
      expect(venues).toHaveLength(1);
    });

    it('should accumulate depth at the same price level', () => {
      updater.applyEvent(newOrderEvent({ orderIdHash: makeOrderId('a') }));
      updater.applyEvent(newOrderEvent({ orderIdHash: makeOrderId('b') }));

      const levels = store.getNodesByKind(NodeKind.PriceLevel);
      expect(levels).toHaveLength(1);
      // Two orders of qty 100 each
      expect(levels[0].properties.get(PropertyKey.VisibleDepth)).toBe(200);
    });
  });

  describe('ModifyOrder', () => {
    it('should update order properties and create ModifiedFrom edge', () => {
      const orderId = makeOrderId('mod-test');
      updater.applyEvent(newOrderEvent({ orderIdHash: orderId }));
      const initialOrders = store.getNodesByKind(NodeKind.Order);
      expect(initialOrders[0].properties.get(PropertyKey.VisibleDepth)).toBe(100);

      const delta = updater.applyEvent(modifyOrderEvent(orderId, qty(150)));

      expect(delta.nodesAdded).toBe(1); // New Event node
      expect(delta.edgesAdded).toBe(1); // ModifiedFrom

      // Order quantity should be updated
      const orders = store.getNodesByKind(NodeKind.Order);
      expect(orders[0].properties.get(PropertyKey.VisibleDepth)).toBe(150);
      expect(orders[0].properties.get(PropertyKey.ModifyCount)).toBe(1);
    });

    it('should handle modify for non-existent order gracefully', () => {
      const delta = updater.applyEvent(
        modifyOrderEvent(makeOrderId('ghost'), qty(100)),
      );
      expect(delta.nodesAdded).toBe(1); // Event node still created
    });
  });

  describe('CancelOrder', () => {
    it('should mark order as canceled and create CanceledBy edge', () => {
      const orderId = makeOrderId('cancel-test');
      updater.applyEvent(newOrderEvent({ orderIdHash: orderId }));

      const delta = updater.applyEvent(cancelOrderEvent(orderId));

      expect(delta.nodesAdded).toBe(1); // Event node
      expect(delta.edgesAdded).toBe(1); // CanceledBy

      // Order depth should be 0
      const orders = store.getNodesByKind(NodeKind.Order);
      expect(orders[0].properties.get(PropertyKey.VisibleDepth)).toBe(0);
      expect(orders[0].properties.get(PropertyKey.CancelHazard)).toBe(1);

      // PriceLevel depth should be reduced
      const levels = store.getNodesByKind(NodeKind.PriceLevel);
      expect(levels[0].properties.get(PropertyKey.VisibleDepth)).toBe(0);
    });
  });

  describe('Trade', () => {
    it('should create Trade and Event nodes', () => {
      const delta = updater.applyEvent(tradeEvent());

      expect(delta.nodesAdded).toBe(2); // Trade + Event
      expect(delta.edgesAdded).toBeGreaterThanOrEqual(3); // Generated, BelongsToSymbol, OnVenue

      const trades = store.getNodesByKind(NodeKind.Trade);
      expect(trades).toHaveLength(1);
      expect(trades[0].properties.get(PropertyKey.VisibleDepth)).toBe(50);
    });

    it('should create Matched edge when order exists', () => {
      const orderId = makeOrderId('resting');
      updater.applyEvent(newOrderEvent({ orderIdHash: orderId }));

      const delta = updater.applyEvent(
        tradeEvent({ orderIdHash: orderId, qtyFp: qty(30) }),
      );

      expect(delta.edgesAdded).toBeGreaterThanOrEqual(4); // includes Matched

      // Resting order depth should be reduced
      const orders = store.getNodesByKind(NodeKind.Order);
      expect(orders[0].properties.get(PropertyKey.VisibleDepth)).toBe(70); // 100 - 30
    });
  });

  describe('BookSnapshot', () => {
    it('should upsert price level depth', () => {
      const delta = updater.applyEvent(bookSnapshotEvent());

      expect(delta.nodesAdded).toBe(1); // Event node
      expect(delta.propertiesUpdated).toBeGreaterThanOrEqual(1);

      const levels = store.getNodesByKind(NodeKind.PriceLevel);
      expect(levels).toHaveLength(1);
      expect(levels[0].properties.get(PropertyKey.VisibleDepth)).toBe(500);
    });

    it('should update existing price level', () => {
      updater.applyEvent(bookSnapshotEvent({ qtyFp: qty(500) }));
      updater.applyEvent(bookSnapshotEvent({ qtyFp: qty(300) }));

      const levels = store.getNodesByKind(NodeKind.PriceLevel);
      expect(levels).toHaveLength(1);
      expect(levels[0].properties.get(PropertyKey.VisibleDepth)).toBe(300);
    });
  });

  describe('SessionMarker', () => {
    it('should create TimeBucket and Regime nodes', () => {
      const delta = updater.applyEvent(sessionMarkerEvent());

      expect(delta.nodesAdded).toBe(2); // TimeBucket + Regime
      expect(delta.edgesAdded).toBe(2); // InRegime + BelongsToSymbol

      const timeBuckets = store.getNodesByKind(NodeKind.TimeBucket);
      expect(timeBuckets).toHaveLength(1);

      const regimes = store.getNodesByKind(NodeKind.Regime);
      expect(regimes).toHaveLength(1);
    });
  });

  describe('VenueStatus', () => {
    it('should update venue node properties', () => {
      // First create the venue via another event
      updater.applyEvent(newOrderEvent());

      const delta = updater.applyEvent(venueStatusEvent({ flags: 42 }));

      expect(delta.propertiesUpdated).toBe(1);

      const venues = store.getNodesByKind(NodeKind.Venue);
      expect(venues).toHaveLength(1);
      expect(venues[0].properties.get(PropertyKey.InfluenceScore)).toBe(42);
    });
  });

  describe('node and edge counts', () => {
    it('should have correct total counts after mixed events', () => {
      const orderId = makeOrderId('mixed');
      updater.applyEvent(newOrderEvent({ orderIdHash: orderId }));
      updater.applyEvent(modifyOrderEvent(orderId, qty(200)));
      updater.applyEvent(tradeEvent({ orderIdHash: orderId, qtyFp: qty(50) }));
      updater.applyEvent(sessionMarkerEvent());

      // Structural: Symbol(1) + Venue(1) + PriceLevel(1)
      // Data: Order(1) + Event(4) + Trade(1) + TimeBucket(1) + Regime(1)
      expect(store.nodeCount()).toBeGreaterThanOrEqual(8);
      expect(store.edgeCount()).toBeGreaterThanOrEqual(8);
    });
  });
});
