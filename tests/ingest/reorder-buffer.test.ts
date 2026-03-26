import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReorderBuffer } from '../../src/ingest/reorder-buffer.js';
import type { MarketEvent, SymbolId, VenueId, Timestamp, PriceFp, QtyFp, EventId } from '../../src/shared/types.js';
import { EventType, Side } from '../../src/shared/types.js';

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

function makeEvent(tsExchangeNs: bigint, seq: bigint): MarketEvent {
  return {
    eventId: `evt-${seq}` as EventId,
    tsExchangeNs: tsExchangeNs as Timestamp,
    tsIngestNs: (tsExchangeNs + 1000n) as Timestamp,
    venueId: 1 as VenueId,
    symbolId: 100 as SymbolId,
    eventType: EventType.Trade,
    side: Side.Bid,
    priceFp: 4200000000000n as PriceFp,
    qtyFp: 100000000n as QtyFp,
    flags: 0,
    seq,
  };
}

describe('ReorderBuffer', () => {
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    logger = createLogger();
  });

  it('should throw on invalid capacity', () => {
    expect(() => new ReorderBuffer(0, 100n, logger)).toThrow();
    expect(() => new ReorderBuffer(-1, 100n, logger)).toThrow();
  });

  describe('in-order events with tolerance', () => {
    it('should flush events after they fall outside the tolerance window', () => {
      const tolerance = 200n; // 200ns tolerance
      const buffer = new ReorderBuffer(2048, tolerance, logger);
      const flushed: MarketEvent[] = [];
      buffer.onFlush((e) => flushed.push(e));

      // Insert event at ts=1000
      buffer.insert(makeEvent(1000n, 1n));
      // Nothing flushed yet (only one event, nothing outside window)
      expect(flushed).toHaveLength(0);

      // Insert event at ts=1100 (within tolerance of 1000)
      buffer.insert(makeEvent(1100n, 2n));
      expect(flushed).toHaveLength(0);

      // Insert event at ts=1300 (cutoff = 1300-200 = 1100)
      // Both ts=1000 and ts=1100 are <= 1100, so both flush
      buffer.insert(makeEvent(1300n, 3n));
      expect(flushed).toHaveLength(2);
      expect(flushed[0]!.seq).toBe(1n);
      expect(flushed[1]!.seq).toBe(2n);
    });
  });

  describe('out-of-order events', () => {
    it('should reorder events correctly', () => {
      const tolerance = 100n;
      const buffer = new ReorderBuffer(2048, tolerance, logger);
      const flushed: MarketEvent[] = [];
      buffer.onFlush((e) => flushed.push(e));

      // Insert out of order: ts=300, ts=100, ts=200
      buffer.insert(makeEvent(300n, 3n));
      buffer.insert(makeEvent(100n, 1n));
      buffer.insert(makeEvent(200n, 2n));

      // Cutoff is 300-100=200, so events with ts<=200 flush
      // After sorting: 100, 200, 300
      // ts=100 <= 200: flushed
      // ts=200 <= 200: flushed
      expect(flushed).toHaveLength(2);
      expect(flushed[0]!.seq).toBe(1n); // ts=100
      expect(flushed[1]!.seq).toBe(2n); // ts=200

      // Now insert ts=500 to flush ts=300
      buffer.insert(makeEvent(500n, 4n));
      // cutoff = 500-100=400, ts=300 <= 400: flushed
      expect(flushed).toHaveLength(3);
      expect(flushed[2]!.seq).toBe(3n);
    });

    it('should break ties by seq number', () => {
      const tolerance = 500n;
      const buffer = new ReorderBuffer(2048, tolerance, logger);
      const flushed: MarketEvent[] = [];
      buffer.onFlush((e) => flushed.push(e));

      // Same timestamp, different seq - insert out of order
      buffer.insert(makeEvent(1000n, 3n));
      buffer.insert(makeEvent(1000n, 1n));
      buffer.insert(makeEvent(1000n, 2n));

      // Nothing flushed yet (all within tolerance)
      expect(flushed).toHaveLength(0);

      // Insert a future event to push the window past ts=1000
      buffer.insert(makeEvent(2000n, 4n));
      // cutoff = 2000-500 = 1500, all ts=1000 events flush in sorted order
      expect(flushed).toHaveLength(3);
      expect(flushed[0]!.seq).toBe(1n);
      expect(flushed[1]!.seq).toBe(2n);
      expect(flushed[2]!.seq).toBe(3n);
    });
  });

  describe('buffer capacity', () => {
    it('should force flush when buffer exceeds capacity', () => {
      const capacity = 4;
      const tolerance = 1_000_000n; // very large tolerance so nothing flushes naturally
      const buffer = new ReorderBuffer(capacity, tolerance, logger);
      const flushed: MarketEvent[] = [];
      buffer.onFlush((e) => flushed.push(e));

      // Insert 5 events (exceeds capacity of 4)
      for (let i = 1; i <= 5; i++) {
        buffer.insert(makeEvent(BigInt(i * 100), BigInt(i)));
      }

      // Should have force-flushed some events
      expect(flushed.length).toBeGreaterThan(0);
      // Buffer should be at or below capacity
      expect(buffer.size).toBeLessThanOrEqual(capacity);
    });
  });

  describe('flushAll', () => {
    it('should flush all remaining events in order', () => {
      const tolerance = 1_000_000n; // large tolerance
      const buffer = new ReorderBuffer(2048, tolerance, logger);
      const flushed: MarketEvent[] = [];
      buffer.onFlush((e) => flushed.push(e));

      buffer.insert(makeEvent(300n, 3n));
      buffer.insert(makeEvent(100n, 1n));
      buffer.insert(makeEvent(200n, 2n));

      // Nothing flushed yet due to large tolerance
      expect(flushed).toHaveLength(0);

      buffer.flushAll();
      expect(flushed).toHaveLength(3);
      // Should be in order
      expect(flushed[0]!.seq).toBe(1n);
      expect(flushed[1]!.seq).toBe(2n);
      expect(flushed[2]!.seq).toBe(3n);

      expect(buffer.size).toBe(0);
    });
  });
});
