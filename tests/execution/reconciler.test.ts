import { describe, it, expect, beforeEach } from 'vitest';
import { Reconciler, type ExchangeState } from '../../src/execution/reconciler.js';
import { PositionTracker } from '../../src/risk/position-tracker.js';
import { createLogger } from '../../src/shared/logger.js';
import type { SymbolId, Side } from '../../src/shared/types.js';

describe('Reconciler', () => {
  let positionTracker: PositionTracker;
  let reconciler: Reconciler;

  beforeEach(() => {
    positionTracker = new PositionTracker();
    reconciler = new Reconciler(
      positionTracker,
      createLogger({ component: 'reconciler-test' }),
    );
  });

  describe('reconcile', () => {
    it('should report no mismatches when states match', () => {
      // Internal position: symbol 1 with 10 units (10 * 1_000_000 fixed-point)
      positionTracker.applyFill(
        1 as SymbolId,
        0 as Side, // buy
        50000_000000n,
        10_000000n,
      );

      const exchangeState: ExchangeState = {
        openOrders: [],
        balances: new Map([['1', 10]]), // 10 units matches 10_000000 fp
      };

      const result = reconciler.reconcile(exchangeState);

      expect(result.positionMismatches).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('should detect position mismatch', () => {
      // Internal position: symbol 1 with 10 units
      positionTracker.applyFill(
        1 as SymbolId,
        0 as Side, // buy
        50000_000000n,
        10_000000n,
      );

      const exchangeState: ExchangeState = {
        openOrders: [],
        balances: new Map([['1', 15]]), // exchange shows 15, internal is 10
      };

      const result = reconciler.reconcile(exchangeState);

      expect(result.positionMismatches).toHaveLength(1);
      expect(result.positionMismatches[0]!.symbolId).toBe(1);
      expect(result.positionMismatches[0]!.expected).toBe(10_000000n);
      expect(result.positionMismatches[0]!.actual).toBe(15);
    });

    it('should return warnings for unknown exchange balances', () => {
      // No internal positions at all

      const exchangeState: ExchangeState = {
        openOrders: [],
        balances: new Map([['99', 5.0]]), // unknown asset on exchange
      };

      const result = reconciler.reconcile(exchangeState);

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Unknown exchange balance');
      expect(result.warnings[0]).toContain('99');
    });
  });

  describe('findStaleOrders', () => {
    it('should identify stale orders not tracked internally', () => {
      const exchangeOrders: ExchangeState['openOrders'] = [
        { orderId: 'ord-1', symbolId: 1, side: 'buy', price: 50000, qty: 10, filledQty: 0 },
        { orderId: 'ord-2', symbolId: 1, side: 'sell', price: 51000, qty: 5, filledQty: 0 },
        { orderId: 'ord-3', symbolId: 2, side: 'buy', price: 3000, qty: 20, filledQty: 0 },
      ];

      const internalOrders = ['ord-1', 'ord-3'];

      const stale = reconciler.findStaleOrders(exchangeOrders, internalOrders);

      expect(stale).toEqual(['ord-2']);
    });

    it('should return empty array when all orders are tracked', () => {
      const exchangeOrders: ExchangeState['openOrders'] = [
        { orderId: 'ord-1', symbolId: 1, side: 'buy', price: 50000, qty: 10, filledQty: 0 },
      ];

      const internalOrders = ['ord-1'];

      const stale = reconciler.findStaleOrders(exchangeOrders, internalOrders);

      expect(stale).toHaveLength(0);
    });

    it('should flag all orders as stale when internal list is empty', () => {
      const exchangeOrders: ExchangeState['openOrders'] = [
        { orderId: 'ord-1', symbolId: 1, side: 'buy', price: 50000, qty: 10, filledQty: 0 },
        { orderId: 'ord-2', symbolId: 2, side: 'sell', price: 3000, qty: 5, filledQty: 0 },
      ];

      const stale = reconciler.findStaleOrders(exchangeOrders, []);

      expect(stale).toEqual(['ord-1', 'ord-2']);
    });
  });

  describe('detectMismatches', () => {
    it('should detect mismatches between exchange balances and internal positions', () => {
      positionTracker.applyFill(
        1 as SymbolId,
        0 as Side, // buy
        50000_000000n,
        10_000000n,
      );

      const exchangeBalances = new Map([['BTC', 15]]);
      const symbolMap = new Map([['BTC', 1]]);

      const mismatches = reconciler.detectMismatches(exchangeBalances, symbolMap);

      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]!.symbolId).toBe(1);
      expect(mismatches[0]!.expected).toBe(10_000000n);
      expect(mismatches[0]!.actual).toBe(15);
    });

    it('should return empty array when positions match', () => {
      positionTracker.applyFill(
        1 as SymbolId,
        0 as Side,
        50000_000000n,
        10_000000n,
      );

      const exchangeBalances = new Map([['BTC', 10]]);
      const symbolMap = new Map([['BTC', 1]]);

      const mismatches = reconciler.detectMismatches(exchangeBalances, symbolMap);

      expect(mismatches).toHaveLength(0);
    });

    it('should skip assets not in symbolMap', () => {
      const exchangeBalances = new Map([['UNKNOWN', 100]]);
      const symbolMap = new Map<string, number>();

      const mismatches = reconciler.detectMismatches(exchangeBalances, symbolMap);

      expect(mismatches).toHaveLength(0);
    });
  });
});
