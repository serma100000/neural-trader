import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DomainEventBus,
  createEventBus,
  type MarketDataReceivedPayload,
  type GraphUpdatedPayload,
  type KillSwitchActivatedPayload,
} from '../../src/shared/event-bus.js';
import { EventType, Side, type SymbolId, type VenueId, type EventId, type Timestamp, type PriceFp, type QtyFp } from '../../src/shared/types.js';

function makeMarketDataPayload(): MarketDataReceivedPayload {
  return {
    event: {
      eventId: 'evt-1' as EventId,
      tsExchangeNs: 1000n as Timestamp,
      tsIngestNs: 1001n as Timestamp,
      venueId: 0 as VenueId,
      symbolId: 0 as SymbolId,
      eventType: EventType.Trade,
      side: Side.Bid,
      priceFp: 50000_00000000n as PriceFp,
      qtyFp: 1_00000000n as QtyFp,
      flags: 0,
      seq: 1n,
    },
    receivedAt: 1001n,
  };
}

describe('DomainEventBus', () => {
  let bus: DomainEventBus;

  beforeEach(() => {
    bus = createEventBus();
  });

  it('should deliver published events to subscribers', () => {
    const handler = vi.fn();
    bus.subscribe('MarketDataReceived', handler);

    const payload = makeMarketDataPayload();
    bus.publish('MarketDataReceived', payload);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('should support multiple subscribers for the same event', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    bus.subscribe('MarketDataReceived', handler1);
    bus.subscribe('MarketDataReceived', handler2);

    bus.publish('MarketDataReceived', makeMarketDataPayload());

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('should not deliver events after unsubscribe', () => {
    const handler = vi.fn();
    bus.subscribe('MarketDataReceived', handler);
    bus.unsubscribe('MarketDataReceived', handler);

    bus.publish('MarketDataReceived', makeMarketDataPayload());

    expect(handler).not.toHaveBeenCalled();
  });

  it('should not cross-deliver between different event types', () => {
    const marketHandler = vi.fn();
    const killHandler = vi.fn();
    bus.subscribe('MarketDataReceived', marketHandler);
    bus.subscribe('KillSwitchActivated', killHandler);

    bus.publish('MarketDataReceived', makeMarketDataPayload());

    expect(marketHandler).toHaveBeenCalledTimes(1);
    expect(killHandler).not.toHaveBeenCalled();
  });

  it('should deliver typed payloads for GraphUpdated', () => {
    const handler = vi.fn<[GraphUpdatedPayload], void>();
    bus.subscribe('GraphUpdated', handler);

    const payload: GraphUpdatedPayload = {
      symbolId: 0 as SymbolId,
      delta: { nodesAdded: 3, edgesAdded: 5, propertiesUpdated: 2 },
      tsNs: 2000n,
    };
    bus.publish('GraphUpdated', payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0];
    expect(received.delta.nodesAdded).toBe(3);
  });

  it('should deliver typed payloads for KillSwitchActivated', () => {
    const handler = vi.fn<[KillSwitchActivatedPayload], void>();
    bus.subscribe('KillSwitchActivated', handler);

    const payload: KillSwitchActivatedPayload = {
      reason: 'Max daily loss exceeded',
      operator: 'risk-engine',
      tsNs: 3000n,
    };
    bus.publish('KillSwitchActivated', payload);

    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('should report correct listener count', () => {
    expect(bus.listenerCount('MarketDataReceived')).toBe(0);

    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.subscribe('MarketDataReceived', h1);
    bus.subscribe('MarketDataReceived', h2);

    expect(bus.listenerCount('MarketDataReceived')).toBe(2);

    bus.unsubscribe('MarketDataReceived', h1);
    expect(bus.listenerCount('MarketDataReceived')).toBe(1);
  });

  it('should remove all listeners', () => {
    bus.subscribe('MarketDataReceived', vi.fn());
    bus.subscribe('GraphUpdated', vi.fn());
    bus.removeAllListeners();

    expect(bus.listenerCount('MarketDataReceived')).toBe(0);
    expect(bus.listenerCount('GraphUpdated')).toBe(0);
  });
});
