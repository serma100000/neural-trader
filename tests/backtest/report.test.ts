import { describe, it, expect } from 'vitest';
import {
  generateReport,
  computeSharpe,
  computeSortino,
  computeMaxDrawdown,
} from '../../src/backtest/report.js';
import type { TradeRecord } from '../../src/backtest/types.js';

function makeTrade(pnl: number, symbolId = 0): TradeRecord {
  return {
    symbolId,
    side: pnl >= 0 ? 'buy' : 'sell',
    entryPrice: 100,
    exitPrice: 100 + pnl,
    quantity: 1,
    pnl,
    entryTsNs: 1000n,
    exitTsNs: 2000n,
  };
}

describe('computeSharpe', () => {
  it('should return 0 for fewer than 2 returns', () => {
    expect(computeSharpe([])).toBe(0);
    expect(computeSharpe([1])).toBe(0);
  });

  it('should return 0 for constant returns (zero stddev)', () => {
    expect(computeSharpe([5, 5, 5, 5])).toBe(0);
  });

  it('should compute correct Sharpe for known series', () => {
    // Known series: mean = 1, stddev = 1, annualized = 1 * sqrt(252)
    const returns = [0, 2, 0, 2, 0, 2, 0, 2];
    const mean = 1;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    const stdDev = Math.sqrt(variance);
    const expectedSharpe = (mean / stdDev) * Math.sqrt(252);

    const result = computeSharpe(returns);
    expect(result).toBeCloseTo(expectedSharpe, 4);
  });

  it('should return positive Sharpe for positive mean returns', () => {
    const returns = [1, 2, 3, 1, 2, 3];
    expect(computeSharpe(returns)).toBeGreaterThan(0);
  });

  it('should return negative Sharpe for negative mean returns', () => {
    const returns = [-1, -2, -3, -1, -2, -3];
    expect(computeSharpe(returns)).toBeLessThan(0);
  });
});

describe('computeSortino', () => {
  it('should return 0 for fewer than 2 returns', () => {
    expect(computeSortino([])).toBe(0);
    expect(computeSortino([1])).toBe(0);
  });

  it('should return Infinity for all positive returns with positive mean', () => {
    const result = computeSortino([1, 2, 3, 4, 5]);
    expect(result).toBe(Infinity);
  });

  it('should compute positive Sortino for net-positive series with some losses', () => {
    const returns = [5, -1, 3, -0.5, 4, 2];
    expect(computeSortino(returns)).toBeGreaterThan(0);
  });
});

describe('computeMaxDrawdown', () => {
  it('should return 0 for empty series', () => {
    expect(computeMaxDrawdown([])).toBe(0);
  });

  it('should return 0 for monotonically increasing cumulative PnL', () => {
    expect(computeMaxDrawdown([1, 1, 1, 1])).toBe(0);
  });

  it('should detect drawdown correctly', () => {
    // Cumulative: 10, 15, 10, 5, 12
    // Peak at 15, trough at 5 => drawdown = (15-5)/15 = 66.67%
    const returns = [10, 5, -5, -5, 7];
    const result = computeMaxDrawdown(returns);
    expect(result).toBeCloseTo(66.67, 0);
  });

  it('should detect 100% drawdown when all gains are lost', () => {
    const returns = [10, -10];
    // Peak = 10, trough = 0 => 100%
    const result = computeMaxDrawdown(returns);
    expect(result).toBeCloseTo(100, 0);
  });

  it('should handle all negative returns', () => {
    const returns = [-1, -1, -1];
    // Cumulative: -1, -2, -3. Peak stays at 0, so drawdown formula = (0 - cum)/0 = 0
    const result = computeMaxDrawdown(returns);
    expect(result).toBe(0);
  });
});

describe('generateReport', () => {
  it('should compute correct win rate', () => {
    const trades = [
      makeTrade(10),
      makeTrade(5),
      makeTrade(-3),
      makeTrade(8),
    ];

    const report = generateReport(trades, { total: 10, allowed: 8 });
    expect(report.winRate).toBeCloseTo(0.75, 2);
  });

  it('should compute correct total PnL', () => {
    const trades = [
      makeTrade(10),
      makeTrade(-5),
      makeTrade(3),
    ];

    const report = generateReport(trades, { total: 5, allowed: 5 });
    expect(report.totalPnl).toBeCloseTo(8, 4);
  });

  it('should compute profit factor correctly', () => {
    const trades = [
      makeTrade(10),
      makeTrade(5),
      makeTrade(-3),
      makeTrade(-2),
    ];

    const report = generateReport(trades, { total: 10, allowed: 10 });
    // Gross profit = 15, Gross loss = 5
    expect(report.profitFactor).toBeCloseTo(3, 4);
  });

  it('should compute coherence uptime and rejection rate', () => {
    const trades = [makeTrade(1)];
    const report = generateReport(trades, { total: 100, allowed: 80 });

    expect(report.coherenceUptime).toBeCloseTo(0.8, 4);
    expect(report.gateRejectionRate).toBeCloseTo(0.2, 4);
  });

  it('should handle empty trades', () => {
    const report = generateReport([], { total: 0, allowed: 0 });
    expect(report.totalPnl).toBe(0);
    expect(report.totalTrades).toBe(0);
    expect(report.winRate).toBe(0);
    expect(report.sharpeRatio).toBe(0);
    expect(report.coherenceUptime).toBe(1);
  });

  it('should compute average trade return', () => {
    const trades = [
      makeTrade(10),
      makeTrade(-4),
      makeTrade(6),
    ];
    const report = generateReport(trades, { total: 3, allowed: 3 });
    expect(report.avgTradeReturn).toBeCloseTo(4, 4);
  });
});
