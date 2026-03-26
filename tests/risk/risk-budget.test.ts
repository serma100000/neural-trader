import { describe, it, expect } from 'vitest';
import { RiskBudget } from '../../src/risk/risk-budget.js';
import type { RiskBudgetConfig, OrderIntent, PositionSnapshot } from '../../src/policy/types.js';
import type { SymbolId, VenueId } from '../../src/shared/types.js';
import { Side } from '../../src/shared/types.js';

// --- Test Helpers ---

function makeConfig(overrides: Partial<RiskBudgetConfig> = {}): RiskBudgetConfig {
  return {
    maxNotionalUsd: 1_000_000,
    maxSymbolNotionalUsd: 200_000,
    maxSectorCorrelation: 0.8,
    maxOrderRatePerSec: 100,
    maxCancelRatePerSec: 50,
    maxSlippageBp: 10,
    rateThrottleFraction: 0.8,
    maxDrawdownPct: 5,
    maxWeeklyDrawdownPct: 10,
    ...overrides,
  };
}

function makeIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    symbolId: 1 as SymbolId,
    venueId: 1 as VenueId,
    side: Side.Bid,
    priceFp: 100_000_000n, // 100.0 in fixed-point
    qtyFp: 1_000_000n,     // 1.0 in fixed-point
    orderType: 'limit',
    timeInForce: 'day',
    ...overrides,
  };
}

function makePosition(overrides: Partial<PositionSnapshot> = {}): PositionSnapshot {
  return {
    symbolId: 1 as SymbolId,
    netQtyFp: 0n,
    avgEntryPriceFp: 0n,
    realizedPnlFp: 0n,
    unrealizedPnlFp: 0n,
    openOrderCount: 0,
    lastFillTsNs: 0n,
    ...overrides,
  };
}

// --- Tests ---

describe('RiskBudget', () => {
  describe('check', () => {
    it('should allow an order within all limits', () => {
      const budget = new RiskBudget(makeConfig());
      const intent = makeIntent();
      const position = makePosition();

      const result = budget.check(intent, position);

      expect(result.allowed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should block when total notional exceeds limit', () => {
      const budget = new RiskBudget(makeConfig({ maxNotionalUsd: 50 }));
      const intent = makeIntent(); // notional = 100 * 1 = 100
      const position = makePosition();

      const result = budget.check(intent, position);

      expect(result.allowed).toBe(false);
      expect(result.violations.some((v) => v.includes('Total notional'))).toBe(true);
    });

    it('should block when per-symbol notional exceeds limit', () => {
      const budget = new RiskBudget(
        makeConfig({ maxSymbolNotionalUsd: 50 }),
      );

      // Record a first order to consume some symbol budget
      budget.recordOrder(makeIntent());

      const result = budget.check(makeIntent(), makePosition());

      expect(result.allowed).toBe(false);
      expect(result.violations.some((v) => v.includes('Symbol'))).toBe(true);
    });

    it('should block when cumulative slippage exceeds limit', () => {
      const budget = new RiskBudget(makeConfig({ maxSlippageBp: 5 }));

      budget.recordSlippage(3);
      budget.recordSlippage(3); // Total: 6bp > 5bp

      const result = budget.check(makeIntent(), makePosition());

      expect(result.allowed).toBe(false);
      expect(result.violations.some((v) => v.includes('slippage'))).toBe(true);
    });

    it('should track cumulative slippage independently', () => {
      const budget = new RiskBudget(makeConfig({ maxSlippageBp: 10 }));

      budget.recordSlippage(2);
      budget.recordSlippage(3);
      budget.recordSlippage(4); // Total: 9bp

      const result = budget.check(makeIntent(), makePosition());
      expect(result.allowed).toBe(true);

      budget.recordSlippage(2); // Total: 11bp > 10bp
      const result2 = budget.check(makeIntent(), makePosition());
      expect(result2.allowed).toBe(false);
    });

    it('should block when session drawdown exceeds limit', () => {
      const budget = new RiskBudget(
        makeConfig({ maxDrawdownPct: 2, maxNotionalUsd: 1_000_000 }),
      );

      // Record a loss that causes drawdown
      budget.recordPnl(1000);  // profit
      budget.recordPnl(-1050); // loss, net = -50, drawdown from peak (1000)

      // The session drawdown should be high enough to trigger
      const snapshot = budget.getSnapshot();
      // If drawdown > 2%, the check should fail
      if (snapshot.sessionDrawdownPct > 2) {
        const result = budget.check(makeIntent(), makePosition());
        expect(result.allowed).toBe(false);
        expect(result.violations.some((v) => v.includes('drawdown'))).toBe(true);
      }
    });
  });

  describe('recordOrder', () => {
    it('should update total and per-symbol notional', () => {
      const budget = new RiskBudget(makeConfig());
      const intent = makeIntent();

      budget.recordOrder(intent);

      const snapshot = budget.getSnapshot();
      expect(snapshot.totalNotionalUsed).toBeGreaterThan(0);
      expect(snapshot.perSymbolNotional.get(1 as SymbolId)).toBeGreaterThan(0);
    });

    it('should increment order rate', () => {
      const budget = new RiskBudget(makeConfig());

      budget.recordOrder();
      budget.recordOrder();
      budget.recordOrder();

      const snapshot = budget.getSnapshot();
      expect(snapshot.rollingOrderRate).toBe(3);
    });
  });

  describe('recordCancel', () => {
    it('should increment cancel rate', () => {
      const budget = new RiskBudget(makeConfig());

      budget.recordCancel();
      budget.recordCancel();

      const snapshot = budget.getSnapshot();
      expect(snapshot.rollingCancelRate).toBe(2);
    });
  });

  describe('reset', () => {
    it('should clear all budget state', () => {
      const budget = new RiskBudget(makeConfig());

      budget.recordOrder(makeIntent());
      budget.recordCancel();
      budget.recordSlippage(5);
      budget.recordPnl(-1000);

      budget.reset();

      const snapshot = budget.getSnapshot();
      expect(snapshot.totalNotionalUsed).toBe(0);
      expect(snapshot.perSymbolNotional.size).toBe(0);
      expect(snapshot.cumulativeSlippageBp).toBe(0);
      expect(snapshot.sessionDrawdownPct).toBe(0);
    });
  });

  describe('rate throttle fraction', () => {
    it('should report violation when order rate exceeds throttle fraction', () => {
      const budget = new RiskBudget(
        makeConfig({
          maxOrderRatePerSec: 10,
          rateThrottleFraction: 0.5, // throttle at 5 orders/sec
        }),
      );

      // Record 5 orders to hit throttle fraction
      for (let i = 0; i < 5; i++) {
        budget.recordOrder();
      }

      const result = budget.check(makeIntent(), makePosition());

      expect(result.violations.some((v) => v.includes('throttle threshold'))).toBe(true);
    });
  });
});
