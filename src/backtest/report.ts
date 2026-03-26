import type { BacktestReport, TradeRecord } from './types.js';

/**
 * Generate a BacktestReport from a series of trade records and
 * coherence tracking data.
 */
export function generateReport(
  trades: TradeRecord[],
  coherenceChecks: { total: number; allowed: number },
): BacktestReport {
  const pnlSeries = trades.map((t) => t.pnl);
  const totalPnl = pnlSeries.reduce((sum, p) => sum + p, 0);
  const totalTrades = trades.length;

  const winningTrades = trades.filter((t) => t.pnl > 0);
  const losingTrades = trades.filter((t) => t.pnl <= 0);

  const winRate = totalTrades > 0 ? winningTrades.length / totalTrades : 0;
  const avgTradeReturn =
    totalTrades > 0 ? totalPnl / totalTrades : 0;

  const grossProfit = winningTrades.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losingTrades.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const sharpeRatio = computeSharpe(pnlSeries);
  const sortinoRatio = computeSortino(pnlSeries);
  const maxDrawdownPct = computeMaxDrawdown(pnlSeries);

  const coherenceUptime =
    coherenceChecks.total > 0
      ? coherenceChecks.allowed / coherenceChecks.total
      : 1;
  const gateRejectionRate =
    coherenceChecks.total > 0
      ? 1 - coherenceChecks.allowed / coherenceChecks.total
      : 0;

  return {
    totalPnl,
    sharpeRatio,
    sortinoRatio,
    maxDrawdownPct,
    winRate,
    profitFactor,
    totalTrades,
    avgTradeReturn,
    coherenceUptime,
    gateRejectionRate,
  };
}

/**
 * Compute annualized Sharpe ratio from a series of PnL values.
 * Assumes each value is a single-period return.
 * Uses sqrt(252) annualization factor (daily trading periods).
 */
export function computeSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance =
    returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;
  return (mean / stdDev) * Math.sqrt(252);
}

/**
 * Compute annualized Sortino ratio (only penalizes downside volatility).
 */
export function computeSortino(returns: number[]): number {
  if (returns.length < 2) return 0;

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const downsideReturns = returns.filter((r) => r < 0);

  if (downsideReturns.length === 0) return mean > 0 ? Infinity : 0;

  const downsideVariance =
    downsideReturns.reduce((s, r) => s + r ** 2, 0) / downsideReturns.length;
  const downsideDev = Math.sqrt(downsideVariance);

  if (downsideDev === 0) return 0;
  return (mean / downsideDev) * Math.sqrt(252);
}

/**
 * Compute maximum drawdown as a percentage.
 * Returns the largest peak-to-trough decline in cumulative PnL.
 */
export function computeMaxDrawdown(returns: number[]): number {
  if (returns.length === 0) return 0;

  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;

  for (const r of returns) {
    cumulative += r;
    if (cumulative > peak) {
      peak = cumulative;
    }
    const drawdown = peak > 0 ? (peak - cumulative) / peak : 0;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  return maxDrawdown * 100;
}
