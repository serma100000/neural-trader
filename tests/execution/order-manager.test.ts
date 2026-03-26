import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OrderManager } from '../../src/execution/order-manager.js';
import { PaperBrokerAdapter } from '../../src/execution/paper-adapter.js';
import { PositionTracker } from '../../src/risk/position-tracker.js';
import { createEventBus, type DomainEventBus } from '../../src/shared/event-bus.js';
import type { ActionDecision, OrderIntent, CancelIntent } from '../../src/policy/types.js';
import type { VerifiedToken, SymbolId, VenueId, Side, Timestamp } from '../../src/shared/types.js';

function makeToken(id = 'tok-1'): VerifiedToken {
  return {
    tokenId: id,
    tsNs: BigInt(Date.now()) * 1_000_000n as Timestamp,
    coherenceHash: 'coh-hash',
    policyHash: 'pol-hash',
    actionIntent: 'place',
  };
}

function makePlaceDecision(overrides: Partial<OrderIntent> = {}): ActionDecision {
  return {
    type: 'place',
    intent: {
      symbolId: 1 as SymbolId,
      venueId: 1 as VenueId,
      side: 0 as Side, // Bid
      priceFp: 50000_00000000n,
      qtyFp: 10_00000000n,
      orderType: 'marketable_limit',
      timeInForce: 'day',
      ...overrides,
    },
  };
}

describe('OrderManager', () => {
  let adapter: PaperBrokerAdapter;
  let positionTracker: PositionTracker;
  let eventBus: DomainEventBus;
  let manager: OrderManager;

  beforeEach(() => {
    adapter = new PaperBrokerAdapter({
      fillLatencyMs: 0,
      partialFillProbability: 0,
      slippageStdBp: 0,
      slippageMeanBp: 0,
      seed: 42,
    });
    positionTracker = new PositionTracker();
    eventBus = createEventBus();
    manager = new OrderManager(adapter, positionTracker, eventBus);
  });

  it('should execute a Place decision and submit order', async () => {
    const decision = makePlaceDecision();
    await manager.execute(decision, makeToken());

    const stats = manager.getStats();
    expect(stats.totalOrders).toBe(1);
  });

  it('should execute Hold decision with no action', async () => {
    const decision: ActionDecision = {
      type: 'hold',
      reason: { ruleName: 'test', detail: 'no signal' },
    };
    await manager.execute(decision, makeToken());

    const stats = manager.getStats();
    expect(stats.totalOrders).toBe(0);
    expect(stats.totalCancels).toBe(0);
  });

  it('should execute EmergencyFlatten and cancel all', async () => {
    // Place a limit order first
    const placeDecision: ActionDecision = {
      type: 'place',
      intent: {
        symbolId: 1 as SymbolId,
        venueId: 1 as VenueId,
        side: 0 as Side,
        priceFp: 50000_00000000n,
        qtyFp: 10_00000000n,
        orderType: 'limit',
        timeInForce: 'day',
      },
    };
    await manager.execute(placeDecision, makeToken());

    // Verify order is open
    expect(manager.getOpenOrders().length).toBe(1);

    // Emergency flatten
    const flattenDecision: ActionDecision = {
      type: 'emergency_flatten',
      reason: 'circuit breaker triggered',
    };
    await manager.execute(flattenDecision, makeToken());

    // Open orders should be cleared
    expect(manager.getOpenOrders().length).toBe(0);
  });

  it('should process fills and update positions correctly', async () => {
    const decision = makePlaceDecision();
    await manager.execute(decision, makeToken());

    const fills = await manager.processFills();
    expect(fills.length).toBe(1);
    expect(fills[0]!.type).toBe('filled');

    // Position should be updated
    const position = positionTracker.getPosition(1 as SymbolId);
    expect(position).toBeDefined();
    expect(position!.netQtyFp).toBe(10_00000000n);

    const stats = manager.getStats();
    expect(stats.totalFills).toBe(1);
  });

  it('should publish OrderFilled event to bus', async () => {
    const handler = vi.fn();
    eventBus.subscribe('OrderFilled', handler);

    const decision = makePlaceDecision();
    await manager.execute(decision, makeToken());
    await manager.processFills();

    expect(handler).toHaveBeenCalledTimes(1);
    const payload = handler.mock.calls[0]![0];
    expect(payload.symbolId).toBe(1);
    expect(payload.fillQty).toBe(10_00000000n);
  });

  it('should publish PositionChanged event to bus', async () => {
    const handler = vi.fn();
    eventBus.subscribe('PositionChanged', handler);

    const decision = makePlaceDecision();
    await manager.execute(decision, makeToken());
    await manager.processFills();

    expect(handler).toHaveBeenCalledTimes(1);
    const payload = handler.mock.calls[0]![0];
    expect(payload.symbolId).toBe(1);
    expect(payload.previousQty).toBe(0n);
    expect(payload.currentQty).toBe(10_00000000n);
  });

  it('should track execution statistics across multiple orders', async () => {
    // Place and fill two orders
    await manager.execute(makePlaceDecision(), makeToken('tok-1'));
    await manager.processFills();

    await manager.execute(makePlaceDecision(), makeToken('tok-2'));
    await manager.processFills();

    const stats = manager.getStats();
    expect(stats.totalOrders).toBe(2);
    expect(stats.totalFills).toBe(2);
  });

  it('should handle cancel decision', async () => {
    // Place a limit order
    const placeDecision: ActionDecision = {
      type: 'place',
      intent: {
        symbolId: 1 as SymbolId,
        venueId: 1 as VenueId,
        side: 0 as Side,
        priceFp: 50000_00000000n,
        qtyFp: 10_00000000n,
        orderType: 'limit',
        timeInForce: 'day',
      },
    };
    await manager.execute(placeDecision, makeToken());

    const openOrders = manager.getOpenOrders();
    expect(openOrders.length).toBe(1);

    // Cancel it
    const cancelDecision: ActionDecision = {
      type: 'cancel',
      intent: {
        orderIdHash: openOrders[0]!.orderId,
        reason: 'strategy exit',
      },
    };
    await manager.execute(cancelDecision, makeToken());

    expect(manager.getOpenOrders().length).toBe(0);
    const stats = manager.getStats();
    expect(stats.totalCancels).toBe(1);
  });

  it('should cancelAll via the manager method', async () => {
    // Place a limit order
    const placeDecision: ActionDecision = {
      type: 'place',
      intent: {
        symbolId: 1 as SymbolId,
        venueId: 1 as VenueId,
        side: 0 as Side,
        priceFp: 50000_00000000n,
        qtyFp: 10_00000000n,
        orderType: 'limit',
        timeInForce: 'day',
      },
    };
    await manager.execute(placeDecision, makeToken());

    await manager.cancelAll('shutdown', makeToken());
    expect(manager.getOpenOrders().length).toBe(0);
  });

  it('should handle throttle decision with no action', async () => {
    const decision: ActionDecision = {
      type: 'throttle',
      resumeAfterNs: BigInt(Date.now()) * 1_000_000n + 5_000_000_000n,
      reason: 'rate limit',
    };
    await manager.execute(decision, makeToken());

    const stats = manager.getStats();
    expect(stats.totalOrders).toBe(0);
  });
});
