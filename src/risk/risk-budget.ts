import type { SymbolId } from '../shared/types.js';
import type {
  RiskBudgetConfig,
  RiskBudgetSnapshot,
  OrderIntent,
  PositionSnapshot,
} from '../policy/types.js';

/**
 * Sliding window for rate tracking.
 * Stores timestamps of events and counts within a rolling window.
 */
class RateWindow {
  private readonly windowMs: number;
  private timestamps: number[] = [];

  constructor(windowMs: number = 1000) {
    this.windowMs = windowMs;
  }

  record(): void {
    this.timestamps.push(Date.now());
    this.prune();
  }

  getRate(): number {
    this.prune();
    return this.timestamps.length;
  }

  reset(): void {
    this.timestamps = [];
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    // Remove expired entries from the front
    let i = 0;
    while (i < this.timestamps.length && this.timestamps[i] < cutoff) {
      i++;
    }
    if (i > 0) {
      this.timestamps = this.timestamps.slice(i);
    }
  }
}

// Fixed-point scale factor: 1_000_000 units = 1.0
const FP_SCALE = 1_000_000;

/**
 * Risk budget manager that enforces 7 independent budget checks
 * per ADR-004:
 *
 * 1. Total notional limit
 * 2. Per-symbol notional limit
 * 3. Order rate limit
 * 4. Cancel rate limit
 * 5. Cumulative slippage limit
 * 6. Session drawdown limit
 * 7. Rate throttle fraction (soft limit approaching hard cap)
 */
export class RiskBudget {
  private readonly config: RiskBudgetConfig;
  private totalNotionalUsed = 0;
  private perSymbolNotional = new Map<SymbolId, number>();
  private cumulativeSlippageBp = 0;
  private sessionDrawdownPct = 0;
  private sessionPeakPnl = 0;
  private sessionCumulativePnl = 0;
  private readonly orderRateWindow: RateWindow;
  private readonly cancelRateWindow: RateWindow;

  constructor(config: RiskBudgetConfig) {
    this.config = config;
    this.orderRateWindow = new RateWindow(1000);
    this.cancelRateWindow = new RateWindow(1000);
  }

  /**
   * Check whether an order intent is allowed under all budget constraints.
   * Returns allowed=true if all checks pass, or a list of violations.
   */
  check(
    intent: OrderIntent,
    currentPosition: PositionSnapshot,
  ): { allowed: boolean; violations: string[] } {
    const violations: string[] = [];
    const intentNotional = this.computeNotional(intent);

    // 1. Total notional limit
    if (this.totalNotionalUsed + intentNotional > this.config.maxNotionalUsd) {
      violations.push(
        `Total notional ${(this.totalNotionalUsed + intentNotional).toFixed(2)} > max ${this.config.maxNotionalUsd}`,
      );
    }

    // 2. Per-symbol notional limit
    const symbolNotional =
      (this.perSymbolNotional.get(intent.symbolId) ?? 0) + intentNotional;
    if (symbolNotional > this.config.maxSymbolNotionalUsd) {
      violations.push(
        `Symbol ${intent.symbolId} notional ${symbolNotional.toFixed(2)} > max ${this.config.maxSymbolNotionalUsd}`,
      );
    }

    // 3. Order rate limit
    const currentOrderRate = this.orderRateWindow.getRate();
    if (currentOrderRate >= this.config.maxOrderRatePerSec) {
      violations.push(
        `Order rate ${currentOrderRate}/s >= max ${this.config.maxOrderRatePerSec}/s`,
      );
    }

    // 4. Cancel rate limit
    const currentCancelRate = this.cancelRateWindow.getRate();
    if (currentCancelRate >= this.config.maxCancelRatePerSec) {
      violations.push(
        `Cancel rate ${currentCancelRate}/s >= max ${this.config.maxCancelRatePerSec}/s`,
      );
    }

    // 5. Cumulative slippage limit
    if (this.cumulativeSlippageBp > this.config.maxSlippageBp) {
      violations.push(
        `Cumulative slippage ${this.cumulativeSlippageBp.toFixed(2)}bp > max ${this.config.maxSlippageBp}bp`,
      );
    }

    // 6. Session drawdown limit
    if (this.sessionDrawdownPct > this.config.maxDrawdownPct) {
      violations.push(
        `Session drawdown ${this.sessionDrawdownPct.toFixed(2)}% > max ${this.config.maxDrawdownPct}%`,
      );
    }

    // 7. Rate throttle fraction (soft limit)
    const throttleThreshold =
      this.config.maxOrderRatePerSec * this.config.rateThrottleFraction;
    if (currentOrderRate >= throttleThreshold) {
      violations.push(
        `Order rate ${currentOrderRate}/s >= throttle threshold ${throttleThreshold.toFixed(0)}/s (${(this.config.rateThrottleFraction * 100).toFixed(0)}% of max)`,
      );
    }

    return {
      allowed: violations.length === 0,
      violations,
    };
  }

  /**
   * Record that an order was sent. Updates rate tracking and notional.
   */
  recordOrder(intent?: OrderIntent): void {
    this.orderRateWindow.record();
    if (intent) {
      const notional = this.computeNotional(intent);
      this.totalNotionalUsed += notional;
      const current = this.perSymbolNotional.get(intent.symbolId) ?? 0;
      this.perSymbolNotional.set(intent.symbolId, current + notional);
    }
  }

  /**
   * Record that a cancel was sent.
   */
  recordCancel(): void {
    this.cancelRateWindow.record();
  }

  /**
   * Record observed slippage in basis points.
   */
  recordSlippage(slippageBp: number): void {
    this.cumulativeSlippageBp += slippageBp;
  }

  /**
   * Record realized PnL and update drawdown tracking.
   */
  recordPnl(pnlUsd: number): void {
    this.sessionCumulativePnl += pnlUsd;
    if (this.sessionCumulativePnl > this.sessionPeakPnl) {
      this.sessionPeakPnl = this.sessionCumulativePnl;
    }
    if (this.sessionPeakPnl > 0) {
      this.sessionDrawdownPct =
        ((this.sessionPeakPnl - this.sessionCumulativePnl) /
          this.sessionPeakPnl) *
        100;
    } else if (this.sessionCumulativePnl < 0) {
      // If we never had positive PnL, drawdown is the absolute loss
      // relative to starting equity (approximated as maxNotionalUsd)
      this.sessionDrawdownPct =
        (Math.abs(this.sessionCumulativePnl) / this.config.maxNotionalUsd) *
        100;
    }
  }

  /**
   * Get a snapshot of the current risk budget state.
   */
  getSnapshot(): RiskBudgetSnapshot {
    return {
      totalNotionalUsed: this.totalNotionalUsed,
      perSymbolNotional: new Map(this.perSymbolNotional),
      rollingOrderRate: this.orderRateWindow.getRate(),
      rollingCancelRate: this.cancelRateWindow.getRate(),
      cumulativeSlippageBp: this.cumulativeSlippageBp,
      sessionDrawdownPct: this.sessionDrawdownPct,
    };
  }

  /**
   * Reset all budget state (e.g., at start of new session).
   */
  reset(): void {
    this.totalNotionalUsed = 0;
    this.perSymbolNotional.clear();
    this.cumulativeSlippageBp = 0;
    this.sessionDrawdownPct = 0;
    this.sessionPeakPnl = 0;
    this.sessionCumulativePnl = 0;
    this.orderRateWindow.reset();
    this.cancelRateWindow.reset();
  }

  /**
   * Compute approximate notional USD from an OrderIntent.
   * Uses fixed-point price * qty / FP_SCALE^2.
   */
  private computeNotional(intent: OrderIntent): number {
    // If priceFp is 0, estimate using a nominal price of 1.0
    const price =
      intent.priceFp === 0n
        ? 1.0
        : Number(intent.priceFp) / FP_SCALE;
    const qty = Number(intent.qtyFp) / FP_SCALE;
    return price * qty;
  }
}
