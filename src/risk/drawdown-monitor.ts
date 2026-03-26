/**
 * Rolling drawdown monitor with daily and weekly thresholds.
 *
 * Tracks cumulative PnL and computes drawdown from the high-water mark.
 * When drawdown exceeds either threshold, the circuit is broken and
 * only explicit human action can reset it.
 */
export class DrawdownMonitor {
  private readonly dailyThresholdPct: number;
  private readonly weeklyThresholdPct: number;

  // Daily tracking
  private dailyPnl = 0;
  private dailyPeakPnl = 0;
  private dailyDrawdownPct = 0;

  // Weekly tracking
  private weeklyPnl = 0;
  private weeklyPeakPnl = 0;
  private weeklyDrawdownPct = 0;

  // Circuit state
  private circuitBroken = false;
  private breakReason: string | null = null;

  // Base capital for drawdown percentage calculation
  private baseCapital: number;

  constructor(
    dailyThresholdPct: number,
    weeklyThresholdPct: number,
    baseCapital: number = 1_000_000,
  ) {
    this.dailyThresholdPct = dailyThresholdPct;
    this.weeklyThresholdPct = weeklyThresholdPct;
    this.baseCapital = baseCapital;
  }

  /**
   * Record a PnL change (positive = profit, negative = loss).
   * Automatically evaluates drawdown thresholds.
   */
  recordPnl(pnlUsd: number): void {
    if (this.circuitBroken) {
      return; // No further tracking once broken
    }

    // Update daily
    this.dailyPnl += pnlUsd;
    if (this.dailyPnl > this.dailyPeakPnl) {
      this.dailyPeakPnl = this.dailyPnl;
    }
    this.dailyDrawdownPct = this.computeDrawdownPct(
      this.dailyPnl,
      this.dailyPeakPnl,
    );

    // Update weekly
    this.weeklyPnl += pnlUsd;
    if (this.weeklyPnl > this.weeklyPeakPnl) {
      this.weeklyPeakPnl = this.weeklyPnl;
    }
    this.weeklyDrawdownPct = this.computeDrawdownPct(
      this.weeklyPnl,
      this.weeklyPeakPnl,
    );

    // Check thresholds
    if (this.dailyDrawdownPct >= this.dailyThresholdPct) {
      this.circuitBroken = true;
      this.breakReason = `Daily drawdown ${this.dailyDrawdownPct.toFixed(2)}% >= ${this.dailyThresholdPct}% threshold`;
    } else if (this.weeklyDrawdownPct >= this.weeklyThresholdPct) {
      this.circuitBroken = true;
      this.breakReason = `Weekly drawdown ${this.weeklyDrawdownPct.toFixed(2)}% >= ${this.weeklyThresholdPct}% threshold`;
    }
  }

  /**
   * Get the current drawdown percentage (max of daily and weekly).
   */
  getCurrentDrawdown(): number {
    return Math.max(this.dailyDrawdownPct, this.weeklyDrawdownPct);
  }

  /**
   * Get daily drawdown percentage.
   */
  getDailyDrawdown(): number {
    return this.dailyDrawdownPct;
  }

  /**
   * Get weekly drawdown percentage.
   */
  getWeeklyDrawdown(): number {
    return this.weeklyDrawdownPct;
  }

  /**
   * Whether the circuit breaker has been triggered.
   */
  isCircuitBroken(): boolean {
    return this.circuitBroken;
  }

  /**
   * Get the reason the circuit was broken, or null.
   */
  getBreakReason(): string | null {
    return this.breakReason;
  }

  /**
   * Reset daily tracking (call at start of new trading day).
   */
  resetDaily(): void {
    this.dailyPnl = 0;
    this.dailyPeakPnl = 0;
    this.dailyDrawdownPct = 0;
  }

  /**
   * Reset weekly tracking (call at start of new trading week).
   */
  resetWeekly(): void {
    this.weeklyPnl = 0;
    this.weeklyPeakPnl = 0;
    this.weeklyDrawdownPct = 0;
  }

  /**
   * Full reset including circuit breaker state.
   * Requires explicit human action.
   */
  reset(): void {
    this.dailyPnl = 0;
    this.dailyPeakPnl = 0;
    this.dailyDrawdownPct = 0;
    this.weeklyPnl = 0;
    this.weeklyPeakPnl = 0;
    this.weeklyDrawdownPct = 0;
    this.circuitBroken = false;
    this.breakReason = null;
  }

  /**
   * Compute drawdown percentage from current PnL vs peak.
   */
  private computeDrawdownPct(currentPnl: number, peakPnl: number): number {
    if (this.baseCapital <= 0) return 0;

    // Drawdown = (peak - current) as a percentage of base capital
    const drawdown = peakPnl - currentPnl;
    if (drawdown <= 0) return 0;

    return (drawdown / this.baseCapital) * 100;
  }
}
