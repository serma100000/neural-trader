import { describe, it, expect } from 'vitest';
import { PositionTracker } from '../../src/risk/position-tracker.js';
import type { SymbolId } from '../../src/shared/types.js';
import { Side } from '../../src/shared/types.js';

const SYM1 = 1 as SymbolId;
const SYM2 = 2 as SymbolId;
const FP_SCALE = 1_000_000n;

describe('PositionTracker', () => {
  describe('applyFill', () => {
    it('should create a long position on buy', () => {
      const tracker = new PositionTracker();

      tracker.applyFill(SYM1, Side.Bid, 100n * FP_SCALE, 10n * FP_SCALE, 1000n);

      const pos = tracker.getPosition(SYM1);
      expect(pos.netQtyFp).toBe(10n * FP_SCALE);
      expect(pos.avgEntryPriceFp).toBe(100n * FP_SCALE);
      expect(pos.lastFillTsNs).toBe(1000n);
    });

    it('should create a short position on sell', () => {
      const tracker = new PositionTracker();

      tracker.applyFill(SYM1, Side.Ask, 100n * FP_SCALE, 10n * FP_SCALE, 1000n);

      const pos = tracker.getPosition(SYM1);
      expect(pos.netQtyFp).toBe(-10n * FP_SCALE);
      expect(pos.avgEntryPriceFp).toBe(100n * FP_SCALE);
    });

    it('should calculate correct average entry price with multiple buys', () => {
      const tracker = new PositionTracker();

      // Buy 10 @ 100
      tracker.applyFill(SYM1, Side.Bid, 100n * FP_SCALE, 10n * FP_SCALE, 1000n);
      // Buy 10 @ 200
      tracker.applyFill(SYM1, Side.Bid, 200n * FP_SCALE, 10n * FP_SCALE, 2000n);

      const pos = tracker.getPosition(SYM1);
      expect(pos.netQtyFp).toBe(20n * FP_SCALE);
      // Weighted average: (10*100 + 10*200) / 20 = 150
      expect(pos.avgEntryPriceFp).toBe(150n * FP_SCALE);
    });

    it('should realize PnL when closing a long position (buy then sell)', () => {
      const tracker = new PositionTracker();

      // Buy 10 @ 100
      tracker.applyFill(SYM1, Side.Bid, 100n * FP_SCALE, 10n * FP_SCALE, 1000n);
      // Sell 10 @ 120
      tracker.applyFill(SYM1, Side.Ask, 120n * FP_SCALE, 10n * FP_SCALE, 2000n);

      const pos = tracker.getPosition(SYM1);
      expect(pos.netQtyFp).toBe(0n);
      // PnL = (120 - 100) * 10 = 200 (in fixed-point scaled)
      expect(pos.realizedPnlFp).toBe(200n * FP_SCALE);
    });

    it('should realize negative PnL on a losing trade', () => {
      const tracker = new PositionTracker();

      // Buy 10 @ 100
      tracker.applyFill(SYM1, Side.Bid, 100n * FP_SCALE, 10n * FP_SCALE, 1000n);
      // Sell 10 @ 80
      tracker.applyFill(SYM1, Side.Ask, 80n * FP_SCALE, 10n * FP_SCALE, 2000n);

      const pos = tracker.getPosition(SYM1);
      expect(pos.netQtyFp).toBe(0n);
      // PnL = (80 - 100) * 10 = -200
      expect(pos.realizedPnlFp).toBe(-200n * FP_SCALE);
    });

    it('should realize PnL when partially closing a long position', () => {
      const tracker = new PositionTracker();

      // Buy 10 @ 100
      tracker.applyFill(SYM1, Side.Bid, 100n * FP_SCALE, 10n * FP_SCALE, 1000n);
      // Sell 5 @ 120
      tracker.applyFill(SYM1, Side.Ask, 120n * FP_SCALE, 5n * FP_SCALE, 2000n);

      const pos = tracker.getPosition(SYM1);
      expect(pos.netQtyFp).toBe(5n * FP_SCALE);
      // PnL = (120 - 100) * 5 = 100
      expect(pos.realizedPnlFp).toBe(100n * FP_SCALE);
      expect(pos.avgEntryPriceFp).toBe(100n * FP_SCALE); // Unchanged for remaining
    });

    it('should handle short position PnL correctly', () => {
      const tracker = new PositionTracker();

      // Sell 10 @ 100 (short)
      tracker.applyFill(SYM1, Side.Ask, 100n * FP_SCALE, 10n * FP_SCALE, 1000n);
      // Buy 10 @ 80 (cover)
      tracker.applyFill(SYM1, Side.Bid, 80n * FP_SCALE, 10n * FP_SCALE, 2000n);

      const pos = tracker.getPosition(SYM1);
      expect(pos.netQtyFp).toBe(0n);
      // PnL for short cover = (entry - exit) * qty = (100 - 80) * 10 = 200
      expect(pos.realizedPnlFp).toBe(200n * FP_SCALE);
    });

    it('should track multiple symbols independently', () => {
      const tracker = new PositionTracker();

      tracker.applyFill(SYM1, Side.Bid, 100n * FP_SCALE, 10n * FP_SCALE, 1000n);
      tracker.applyFill(SYM2, Side.Ask, 200n * FP_SCALE, 5n * FP_SCALE, 2000n);

      const pos1 = tracker.getPosition(SYM1);
      const pos2 = tracker.getPosition(SYM2);

      expect(pos1.netQtyFp).toBe(10n * FP_SCALE);
      expect(pos2.netQtyFp).toBe(-5n * FP_SCALE);
    });
  });

  describe('getPosition', () => {
    it('should return zero position for unknown symbol', () => {
      const tracker = new PositionTracker();

      const pos = tracker.getPosition(99 as SymbolId);

      expect(pos.netQtyFp).toBe(0n);
      expect(pos.avgEntryPriceFp).toBe(0n);
      expect(pos.realizedPnlFp).toBe(0n);
    });
  });

  describe('getAllPositions', () => {
    it('should return all tracked positions', () => {
      const tracker = new PositionTracker();

      tracker.applyFill(SYM1, Side.Bid, 100n * FP_SCALE, 10n * FP_SCALE, 1000n);
      tracker.applyFill(SYM2, Side.Ask, 200n * FP_SCALE, 5n * FP_SCALE, 2000n);

      const positions = tracker.getAllPositions();

      expect(positions.size).toBe(2);
      expect(positions.has(SYM1)).toBe(true);
      expect(positions.has(SYM2)).toBe(true);
    });
  });

  describe('getTotalNotional', () => {
    it('should calculate total notional using mid prices', () => {
      const tracker = new PositionTracker();

      tracker.applyFill(SYM1, Side.Bid, 100n * FP_SCALE, 10n * FP_SCALE, 1000n);
      tracker.applyFill(SYM2, Side.Ask, 200n * FP_SCALE, 5n * FP_SCALE, 2000n);

      const midPrices = new Map<SymbolId, number>();
      midPrices.set(SYM1, 105);
      midPrices.set(SYM2, 195);

      const total = tracker.getTotalNotional(midPrices);

      // SYM1: |10| * 105 = 1050
      // SYM2: |-5| * 195 = 975
      expect(total).toBeCloseTo(1050 + 975, 0);
    });
  });

  describe('getStateHash', () => {
    it('should produce a deterministic hash', () => {
      const tracker = new PositionTracker();

      tracker.applyFill(SYM1, Side.Bid, 100n * FP_SCALE, 10n * FP_SCALE, 1000n);

      const hash1 = tracker.getStateHash();
      const hash2 = tracker.getStateHash();

      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64);
    });

    it('should change when position updates', () => {
      const tracker = new PositionTracker();

      tracker.applyFill(SYM1, Side.Bid, 100n * FP_SCALE, 10n * FP_SCALE, 1000n);
      const hash1 = tracker.getStateHash();

      tracker.applyFill(SYM1, Side.Ask, 120n * FP_SCALE, 5n * FP_SCALE, 2000n);
      const hash2 = tracker.getStateHash();

      expect(hash1).not.toBe(hash2);
    });

    it('should be empty hash for no positions', () => {
      const tracker = new PositionTracker();

      const hash = tracker.getStateHash();

      expect(hash.length).toBe(64); // SHA-256 even with empty input
    });
  });
});
