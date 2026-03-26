import { describe, it, expect, beforeEach } from 'vitest';
import { GraphStore } from '../../src/graph/graph-store.js';
import { GraphUpdater } from '../../src/graph/graph-updater.js';
import { SlidingWindow } from '../../src/graph/sliding-window.js';
import { DEFAULT_GRAPH_CONFIG } from '../../src/graph/types.js';
import type { GraphConfig } from '../../src/graph/types.js';
import { NodeKind } from '../../src/shared/types.js';
import {
  resetCounters,
  newOrderEvent,
  tradeEvent,
  sessionMarkerEvent,
  makeOrderId,
  cancelOrderEvent,
  ts,
} from './test-helpers.js';

describe('SlidingWindow', () => {
  let store: GraphStore;
  let updater: GraphUpdater;
  let config: GraphConfig;

  beforeEach(() => {
    resetCounters();
    config = {
      ...DEFAULT_GRAPH_CONFIG,
      retentionWindowNs: 10_000_000_000n, // 10 seconds for test
    };
    store = new GraphStore();
    updater = new GraphUpdater(store, config);
  });

  it('should remove stale Event nodes outside retention window', () => {
    // Create events at t=1s
    updater.applyEvent(
      newOrderEvent({ tsExchangeNs: ts(1_000_000_000), orderIdHash: makeOrderId('old') }),
    );

    // Create events at t=20s (well within window for t=25s cutoff)
    updater.applyEvent(
      newOrderEvent({ tsExchangeNs: ts(20_000_000_000), orderIdHash: makeOrderId('new') }),
    );

    const eventsBefore = store.getNodesByKind(NodeKind.Event);
    expect(eventsBefore.length).toBeGreaterThanOrEqual(2);

    // Compact at t=25s. Cutoff = 25s - 10s = 15s. Events at t=1s should be removed.
    const window = new SlidingWindow(store, config);
    const stats = window.compact(25_000_000_000n);

    expect(stats.nodesRemoved).toBeGreaterThan(0);
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);

    // Event at t=1s should be gone
    const eventsAfter = store.getNodesByKind(NodeKind.Event);
    for (const e of eventsAfter) {
      expect(e.createdAtNs).toBeGreaterThanOrEqual(15_000_000_000n);
    }
  });

  it('should keep Symbol and Venue nodes (protected kinds)', () => {
    updater.applyEvent(
      newOrderEvent({ tsExchangeNs: ts(1_000_000_000), orderIdHash: makeOrderId('keep') }),
    );

    const symbolsBefore = store.getNodesByKind(NodeKind.Symbol);
    const venuesBefore = store.getNodesByKind(NodeKind.Venue);
    expect(symbolsBefore).toHaveLength(1);
    expect(venuesBefore).toHaveLength(1);

    const window = new SlidingWindow(store, config);
    window.compact(100_000_000_000n); // very late -> everything is stale

    // Symbol and Venue must survive
    expect(store.getNodesByKind(NodeKind.Symbol)).toHaveLength(1);
    expect(store.getNodesByKind(NodeKind.Venue)).toHaveLength(1);
  });

  it('should remove canceled Orders outside retention window', () => {
    const orderId = makeOrderId('cancel-compact');
    updater.applyEvent(
      newOrderEvent({ tsExchangeNs: ts(1_000_000_000), orderIdHash: orderId }),
    );
    updater.applyEvent(
      cancelOrderEvent(orderId, { tsExchangeNs: ts(2_000_000_000) }),
    );

    const ordersBefore = store.getNodesByKind(NodeKind.Order);
    expect(ordersBefore).toHaveLength(1);

    const window = new SlidingWindow(store, config);
    window.compact(50_000_000_000n); // cutoff = 40s, order updated at 2s

    // Canceled order should be removed
    const ordersAfter = store.getNodesByKind(NodeKind.Order);
    expect(ordersAfter).toHaveLength(0);
  });

  it('should keep active Orders within retention window', () => {
    updater.applyEvent(
      newOrderEvent({ tsExchangeNs: ts(20_000_000_000), orderIdHash: makeOrderId('active') }),
    );

    const window = new SlidingWindow(store, config);
    window.compact(25_000_000_000n); // cutoff = 15s, order at 20s

    // Active order within window should survive
    const orders = store.getNodesByKind(NodeKind.Order);
    expect(orders).toHaveLength(1);
  });

  it('should remove old Trade nodes', () => {
    updater.applyEvent(
      tradeEvent({ tsExchangeNs: ts(1_000_000_000) }),
    );

    const tradesBefore = store.getNodesByKind(NodeKind.Trade);
    expect(tradesBefore).toHaveLength(1);

    const window = new SlidingWindow(store, config);
    window.compact(50_000_000_000n);

    expect(store.getNodesByKind(NodeKind.Trade)).toHaveLength(0);
  });

  it('should keep Regime nodes (protected kind)', () => {
    updater.applyEvent(
      sessionMarkerEvent({ tsExchangeNs: ts(1_000_000_000) }),
    );

    const regimesBefore = store.getNodesByKind(NodeKind.Regime);
    expect(regimesBefore).toHaveLength(1);

    const window = new SlidingWindow(store, config);
    window.compact(100_000_000_000n);

    // Regime is protected
    expect(store.getNodesByKind(NodeKind.Regime)).toHaveLength(1);
  });

  describe('emergency compaction', () => {
    it('should compact when node count exceeds hard cap', () => {
      const smallCap: GraphConfig = {
        ...config,
        nodeHardCap: 20,
      };
      const ecStore = new GraphStore();
      const ecUpdater = new GraphUpdater(ecStore, smallCap);

      // Add enough orders to exceed cap (each NewOrder creates ~5 nodes first time, ~2 after)
      for (let i = 0; i < 15; i++) {
        ecUpdater.applyEvent(
          newOrderEvent({
            tsExchangeNs: ts(BigInt(i) * 1_000_000n),
            orderIdHash: makeOrderId(`ec-${i}`),
          }),
        );
      }

      expect(ecStore.nodeCount()).toBeGreaterThan(20);

      const ecWindow = new SlidingWindow(ecStore, smallCap);
      const stats = ecWindow.emergencyCompact(100_000_000_000n);

      expect(stats.nodesRemoved).toBeGreaterThan(0);
      // Should be at or below 80% of cap
      expect(ecStore.nodeCount()).toBeLessThanOrEqual(20);
    });

    it('should not compact when below hard cap', () => {
      const window = new SlidingWindow(store, config);
      const stats = window.emergencyCompact(100_000_000_000n);

      expect(stats.nodesRemoved).toBe(0);
    });

    it('should report needsEmergencyCompaction correctly', () => {
      const window = new SlidingWindow(store, config);
      expect(window.needsEmergencyCompaction()).toBe(false);
    });
  });
});
