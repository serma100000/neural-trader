import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  EventType,
  type MarketEvent,
  type EventId,
  type Timestamp,
  type VenueId,
  type SymbolId,
  type PriceFp,
  type QtyFp,
} from '../../src/shared/types.js';
import { TickLoop } from '../../src/pipeline/tick-loop.js';

function makeEvent(index: number): MarketEvent {
  return {
    eventId: `evt-${index}` as EventId,
    tsExchangeNs: (1000n + BigInt(index)) as Timestamp,
    tsIngestNs: (1001n + BigInt(index)) as Timestamp,
    venueId: 0 as VenueId,
    symbolId: 0 as SymbolId,
    eventType: EventType.Trade,
    priceFp: 50000_00000000n as PriceFp,
    qtyFp: 1_00000000n as QtyFp,
    flags: 0,
    seq: BigInt(index),
  };
}

describe('TickLoop', () => {
  let tickLoop: TickLoop;

  beforeEach(() => {
    tickLoop = new TickLoop({ intervalMs: 10, maxBatchSize: 5 });
  });

  afterEach(() => {
    tickLoop.stop();
  });

  it('should start and stop without error', () => {
    tickLoop.onTick(async () => {});
    tickLoop.start();
    expect(tickLoop.isRunning()).toBe(true);
    tickLoop.stop();
    expect(tickLoop.isRunning()).toBe(false);
  });

  it('should batch events correctly at tick interval', async () => {
    const batches: MarketEvent[][] = [];

    tickLoop.onTick(async (events) => {
      batches.push([...events]);
    });

    // Push 12 events, maxBatchSize is 5
    for (let i = 0; i < 12; i++) {
      tickLoop.push(makeEvent(i));
    }

    tickLoop.start();

    // Wait for several tick intervals
    await new Promise((resolve) => setTimeout(resolve, 80));
    tickLoop.stop();

    // Should have processed in batches of up to 5
    expect(batches.length).toBeGreaterThan(0);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(5);
    }

    // All 12 events should have been processed
    const totalProcessed = batches.reduce((sum, b) => sum + b.length, 0);
    expect(totalProcessed).toBe(12);
  });

  it('should detect backpressure when queue grows', () => {
    expect(tickLoop.getPendingCount()).toBe(0);

    for (let i = 0; i < 100; i++) {
      tickLoop.push(makeEvent(i));
    }

    expect(tickLoop.getPendingCount()).toBe(100);
  });

  it('should drain remaining events', async () => {
    const processed: MarketEvent[] = [];

    tickLoop.onTick(async (events) => {
      processed.push(...events);
    });

    for (let i = 0; i < 8; i++) {
      tickLoop.push(makeEvent(i));
    }

    await tickLoop.drainRemaining();

    expect(processed.length).toBe(8);
    expect(tickLoop.getPendingCount()).toBe(0);
  });

  it('should not process if no handler is registered', async () => {
    tickLoop.push(makeEvent(0));
    tickLoop.push(makeEvent(1));

    tickLoop.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    tickLoop.stop();

    // Events should still be in queue since no handler
    expect(tickLoop.getPendingCount()).toBe(2);
  });

  it('should handle empty queue gracefully on tick', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    tickLoop.onTick(handler);

    tickLoop.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    tickLoop.stop();

    // Handler should not have been called since queue was empty
    expect(handler).not.toHaveBeenCalled();
  });
});
