import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Sequencer } from '../../src/ingest/sequencer.js';
import type { MarketEvent, SymbolId, VenueId, Timestamp, PriceFp, QtyFp, EventId } from '../../src/shared/types.js';
import { EventType, Side } from '../../src/shared/types.js';

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

function makeEvent(seq: bigint, symbolId = 100, venueId = 1): MarketEvent {
  return {
    eventId: `evt-${seq}` as EventId,
    tsExchangeNs: 1000000n as Timestamp,
    tsIngestNs: 2000000n as Timestamp,
    venueId: makeVenueId(venueId),
    symbolId: makeSymbolId(symbolId),
    eventType: EventType.Trade,
    side: Side.Bid,
    priceFp: 4200000000000n as PriceFp,
    qtyFp: 100000000n as QtyFp,
    flags: 0,
    seq,
  };
}

describe('Sequencer', () => {
  let sequencer: Sequencer;
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    logger = createLogger();
    sequencer = new Sequencer(logger);
  });

  describe('sequential events', () => {
    it('should pass through sequential events without gaps', () => {
      const gapHandler = vi.fn();
      sequencer.onGap(gapHandler);

      const e1 = makeEvent(1n);
      const e2 = makeEvent(2n);
      const e3 = makeEvent(3n);

      sequencer.process(e1);
      sequencer.process(e2);
      sequencer.process(e3);

      expect(gapHandler).not.toHaveBeenCalled();
    });

    it('should track sequence per (symbol, venue) pair independently', () => {
      const gapHandler = vi.fn();
      sequencer.onGap(gapHandler);

      sequencer.process(makeEvent(1n, 100, 1));
      sequencer.process(makeEvent(1n, 101, 1)); // different symbol
      sequencer.process(makeEvent(2n, 100, 1));
      sequencer.process(makeEvent(2n, 101, 1));

      expect(gapHandler).not.toHaveBeenCalled();
    });
  });

  describe('gap detection', () => {
    it('should detect a gap and call handler', () => {
      const gapHandler = vi.fn();
      sequencer.onGap(gapHandler);

      sequencer.process(makeEvent(1n));
      sequencer.process(makeEvent(5n)); // gap: expected 2, got 5

      expect(gapHandler).toHaveBeenCalledTimes(1);
      const gap = gapHandler.mock.calls[0]![0];
      expect(gap.expectedSeq).toBe(2n);
      expect(gap.receivedSeq).toBe(5n);
      expect(gap.symbolId).toBe(makeSymbolId(100));
      expect(gap.venueId).toBe(makeVenueId(1));
    });

    it('should log error for large gaps (>100)', () => {
      sequencer.process(makeEvent(1n));
      sequencer.process(makeEvent(200n));

      expect(logger.error).toHaveBeenCalled();
    });

    it('should log warn for small gaps', () => {
      sequencer.process(makeEvent(1n));
      sequencer.process(makeEvent(5n));

      expect(logger.warn).toHaveBeenCalled();
    });

    it('should detect out-of-order (negative gap)', () => {
      const gapHandler = vi.fn();
      sequencer.onGap(gapHandler);

      sequencer.process(makeEvent(5n));
      sequencer.process(makeEvent(3n)); // out of order

      expect(gapHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('reset', () => {
    it('should not detect gap after reset', () => {
      const gapHandler = vi.fn();
      sequencer.onGap(gapHandler);

      sequencer.process(makeEvent(1n));
      sequencer.reset(makeSymbolId(100), makeVenueId(1));
      sequencer.process(makeEvent(50n)); // fresh start after reset

      expect(gapHandler).not.toHaveBeenCalled();
    });

    it('should only reset the specified (symbol, venue) pair', () => {
      const gapHandler = vi.fn();
      sequencer.onGap(gapHandler);

      sequencer.process(makeEvent(1n, 100, 1));
      sequencer.process(makeEvent(1n, 101, 1));

      sequencer.reset(makeSymbolId(100), makeVenueId(1));

      // Symbol 100 resets, symbol 101 still tracked
      sequencer.process(makeEvent(50n, 100, 1)); // no gap
      sequencer.process(makeEvent(50n, 101, 1)); // gap: expected 2, got 50

      expect(gapHandler).toHaveBeenCalledTimes(1);
      expect(gapHandler.mock.calls[0]![0].symbolId).toBe(makeSymbolId(101));
    });

    it('should resetAll and clear all tracking', () => {
      const gapHandler = vi.fn();
      sequencer.onGap(gapHandler);

      sequencer.process(makeEvent(1n, 100, 1));
      sequencer.process(makeEvent(1n, 101, 1));
      sequencer.resetAll();

      sequencer.process(makeEvent(99n, 100, 1));
      sequencer.process(makeEvent(99n, 101, 1));

      expect(gapHandler).not.toHaveBeenCalled();
    });
  });

  describe('getCurrentSeq', () => {
    it('should return undefined for untracked pairs', () => {
      expect(sequencer.getCurrentSeq(makeSymbolId(100), makeVenueId(1))).toBeUndefined();
    });

    it('should return the last processed sequence', () => {
      sequencer.process(makeEvent(42n));
      expect(sequencer.getCurrentSeq(makeSymbolId(100), makeVenueId(1))).toBe(42n);
    });
  });
});
