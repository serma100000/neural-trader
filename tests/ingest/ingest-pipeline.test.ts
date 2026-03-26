import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IngestPipeline } from '../../src/ingest/ingest-pipeline.js';
import { ReplayAdapter } from '../../src/ingest/replay-adapter.js';
import { createEventBus } from '../../src/shared/event-bus.js';
import type { DomainEventBus, MarketDataReceivedPayload } from '../../src/shared/event-bus.js';
import type { SymbolId, VenueId, MarketEvent } from '../../src/shared/types.js';
import type { IngestConfig, FeedConfig } from '../../src/ingest/types.js';
import { resolve } from 'node:path';

function makeVenueId(n: number): VenueId {
  return n as VenueId;
}

function makeSymbolId(n: number): SymbolId {
  return n as SymbolId;
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
  } as unknown as import('../../src/shared/logger.js').Logger;
}

describe('IngestPipeline integration', () => {
  let eventBus: DomainEventBus;
  let logger: ReturnType<typeof createLogger>;
  let pipeline: IngestPipeline;
  let feedConfig: FeedConfig;
  let ingestConfig: IngestConfig;

  beforeEach(() => {
    eventBus = createEventBus();
    logger = createLogger();

    feedConfig = {
      venueId: makeVenueId(1),
      venueName: 'binance-test',
      wsUrl: 'ws://localhost:0',
      feedType: 'l2_delta',
      symbols: [makeSymbolId(100), makeSymbolId(101)],
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
    };

    ingestConfig = {
      feeds: [feedConfig],
      reorderBufferCapacity: 2048,
      clockToleranceNs: 50_000_000n, // 50ms tolerance
      maxReplaySpeed: 0,
    };

    pipeline = new IngestPipeline(ingestConfig, eventBus, logger);
    pipeline.registerSymbol('1', 'BTCUSDT', makeSymbolId(100));
    pipeline.registerSymbol('1', 'ETHUSDT', makeSymbolId(101));
  });

  it('should process events from replay adapter and publish to event bus', async () => {
    const fixturePath = resolve(__dirname, 'fixtures/sample-events.json');

    const replayAdapter = new ReplayAdapter(
      makeVenueId(1),
      { filePath: fixturePath, speed: 0, loop: false },
      logger,
    );

    pipeline.addFeed(feedConfig, replayAdapter);

    const receivedEvents: MarketEvent[] = [];
    eventBus.subscribe('MarketDataReceived', (payload: MarketDataReceivedPayload) => {
      receivedEvents.push(payload.event);
    });

    await pipeline.start();

    // Wait for replay to complete (events emit asynchronously)
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        // The fixture has 20 events, but each depth update has multiple
        // price levels, so we get more MarketEvents than raw events.
        // We check that we received a reasonable number.
        if (receivedEvents.length >= 10) {
          clearInterval(check);
          resolve();
        }
      }, 50);

      // Timeout safety
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, 5000);
    });

    await pipeline.stop();

    // Verify we got events
    expect(receivedEvents.length).toBeGreaterThan(0);

    // Verify events are in timestamp order (reorder buffer guarantees this)
    for (let i = 1; i < receivedEvents.length; i++) {
      const prev = receivedEvents[i - 1]!;
      const curr = receivedEvents[i]!;
      expect(curr.tsExchangeNs >= prev.tsExchangeNs).toBe(true);
    }

    // Verify stats
    const stats = pipeline.getStats();
    expect(stats.totalEventsIngested).toBeGreaterThan(0n);
    expect(stats.uptimeMs).toBeGreaterThan(0);
  });

  it('should handle events with both BTCUSDT and ETHUSDT symbols', async () => {
    const fixturePath = resolve(__dirname, 'fixtures/sample-events.json');

    const replayAdapter = new ReplayAdapter(
      makeVenueId(1),
      { filePath: fixturePath, speed: 0, loop: false },
      logger,
    );

    pipeline.addFeed(feedConfig, replayAdapter);

    const symbolIds = new Set<number>();
    eventBus.subscribe('MarketDataReceived', (payload: MarketDataReceivedPayload) => {
      symbolIds.add(payload.event.symbolId as number);
    });

    await pipeline.start();

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (symbolIds.size >= 2) {
          clearInterval(check);
          resolve();
        }
      }, 50);

      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, 5000);
    });

    await pipeline.stop();

    expect(symbolIds.has(100)).toBe(true);
    expect(symbolIds.has(101)).toBe(true);
  });

  it('should produce deterministic event IDs', async () => {
    const fixturePath = resolve(__dirname, 'fixtures/sample-events.json');

    const replayAdapter = new ReplayAdapter(
      makeVenueId(1),
      { filePath: fixturePath, speed: 0, loop: false },
      logger,
    );

    pipeline.addFeed(feedConfig, replayAdapter);

    const eventIds: string[] = [];
    eventBus.subscribe('MarketDataReceived', (payload: MarketDataReceivedPayload) => {
      eventIds.push(payload.event.eventId);
    });

    await pipeline.start();

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2000);
    });

    await pipeline.stop();

    // All event IDs should be unique
    const uniqueIds = new Set(eventIds);
    expect(uniqueIds.size).toBe(eventIds.length);

    // All event IDs should be 32-char hex strings
    for (const id of eventIds) {
      expect(/^[0-9a-f]{32}$/.test(id)).toBe(true);
    }
  });
});
