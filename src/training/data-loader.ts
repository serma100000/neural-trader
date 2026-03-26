import type { MarketEvent } from '../shared/types.js';
import { EventType } from '../shared/types.js';
import type { TrainingConfig, TrainingWindow, WindowLabels } from './types.js';
import { DEFAULT_TRAINING_CONFIG } from './types.js';

/**
 * Creates training windows from sequences of market events.
 *
 * Windows are created with a sliding window approach, maintaining
 * temporal order for proper time-series validation splitting.
 */
export class DataLoader {
  private readonly config: TrainingConfig;

  constructor(config?: Partial<TrainingConfig>) {
    this.config = { ...DEFAULT_TRAINING_CONFIG, ...config };
  }

  /**
   * Create training windows from a sequence of events.
   *
   * Each window spans `windowSizeNs` and slides by `strideNs`.
   * Labels are computed by looking at the next window for mid-price targets.
   */
  createWindows(events: MarketEvent[]): TrainingWindow[] {
    if (events.length === 0) return [];

    const sorted = [...events].sort(
      (a, b) => Number(a.tsExchangeNs - b.tsExchangeNs),
    );

    const startTs = sorted[0].tsExchangeNs as bigint;
    const endTs = sorted[sorted.length - 1].tsExchangeNs as bigint;
    const totalSpan = endTs - startTs;

    if (totalSpan < this.config.windowSizeNs) {
      // Not enough data for even one window with a next-window label
      return [];
    }

    const windows: TrainingWindow[] = [];
    let windowStart = startTs;

    while (windowStart + this.config.windowSizeNs <= endTs) {
      const windowEnd = windowStart + this.config.windowSizeNs;
      const nextWindowEnd = windowEnd + this.config.windowSizeNs;

      // Events in the current window
      const windowEvents = sorted.filter(
        (e) =>
          (e.tsExchangeNs as bigint) >= windowStart &&
          (e.tsExchangeNs as bigint) < windowEnd,
      );

      // Events in the next window (for label computation)
      const nextWindowEvents = sorted.filter(
        (e) =>
          (e.tsExchangeNs as bigint) >= windowEnd &&
          (e.tsExchangeNs as bigint) < nextWindowEnd,
      );

      if (windowEvents.length > 0) {
        const labels = this.computeLabels(windowEvents, nextWindowEvents);
        windows.push({ events: windowEvents, labels });
      }

      windowStart += this.config.strideNs;
    }

    return windows;
  }

  /**
   * Split windows into train/validation sets.
   * Uses temporal split (no shuffling) to avoid look-ahead bias.
   */
  splitTrainVal(
    windows: TrainingWindow[],
  ): { train: TrainingWindow[]; val: TrainingWindow[] } {
    const splitIdx = Math.floor(
      windows.length * (1 - this.config.validationSplit),
    );
    return {
      train: windows.slice(0, splitIdx),
      val: windows.slice(splitIdx),
    };
  }

  /**
   * Partition windows into mini-batches.
   * Preserves temporal order within each batch.
   */
  batch(windows: TrainingWindow[], batchSize: number): TrainingWindow[][] {
    const batches: TrainingWindow[][] = [];
    for (let i = 0; i < windows.length; i += batchSize) {
      batches.push(windows.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * Compute labels for a window based on its events and the next window's events.
   */
  private computeLabels(
    windowEvents: MarketEvent[],
    nextWindowEvents: MarketEvent[],
  ): WindowLabels {
    // Mid-price at window end
    const windowMid = this.computeMidPrice(windowEvents);

    // Mid-price at next window start (or window end if no next events)
    const nextMid =
      nextWindowEvents.length > 0
        ? this.computeMidPrice(nextWindowEvents)
        : windowMid;

    // Mid-price move in basis points
    const midPriceMoveBp =
      windowMid > 0 ? ((nextMid - windowMid) / windowMid) * 10_000 : 0;

    // Fill occurred: any Trade events
    const fillOccurred = windowEvents.some(
      (e) => e.eventType === EventType.Trade,
    );

    // Cancel occurred: any CancelOrder events
    const cancelOccurred = windowEvents.some(
      (e) => e.eventType === EventType.CancelOrder,
    );

    // Slippage: average difference between trade price and mid at time of trade
    const slippageBp = this.computeSlippage(windowEvents, windowMid);

    // Vol jump: price moved more than 2 std devs within the window
    const volJump = this.detectVolJump(windowEvents);

    // Regime label based on realized volatility
    const regimeLabel = this.classifyRegime(windowEvents);

    return {
      midPriceMoveBp,
      fillOccurred,
      cancelOccurred,
      slippageBp,
      volJump,
      regimeLabel,
    };
  }

  /**
   * Compute a mid-price estimate from events.
   * Uses the average price of all priced events as a proxy.
   */
  private computeMidPrice(events: MarketEvent[]): number {
    const prices: number[] = [];
    for (const e of events) {
      const p = Number(e.priceFp);
      if (p > 0) {
        prices.push(p);
      }
    }
    if (prices.length === 0) return 0;
    return prices.reduce((a, b) => a + b, 0) / prices.length;
  }

  /**
   * Compute average slippage for trades in the window.
   */
  private computeSlippage(events: MarketEvent[], mid: number): number {
    if (mid === 0) return 0;

    const trades = events.filter((e) => e.eventType === EventType.Trade);
    if (trades.length === 0) return 0;

    let totalSlippage = 0;
    for (const t of trades) {
      const tradePrice = Number(t.priceFp);
      totalSlippage += Math.abs(tradePrice - mid) / mid;
    }

    return (totalSlippage / trades.length) * 10_000; // convert to basis points
  }

  /**
   * Detect volatility jumps: price moved more than 2 standard deviations.
   */
  private detectVolJump(events: MarketEvent[]): boolean {
    const prices: number[] = [];
    for (const e of events) {
      const p = Number(e.priceFp);
      if (p > 0) prices.push(p);
    }
    if (prices.length < 3) return false;

    // Compute returns
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i - 1] > 0) {
        returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
      }
    }
    if (returns.length < 2) return false;

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return false;

    // Check if any return exceeds 2 standard deviations
    return returns.some((r) => Math.abs(r - mean) > 2 * stdDev);
  }

  /**
   * Classify regime based on realized volatility in the window.
   * 0=Calm, 1=Normal, 2=Volatile.
   */
  private classifyRegime(events: MarketEvent[]): number {
    const prices: number[] = [];
    for (const e of events) {
      const p = Number(e.priceFp);
      if (p > 0) prices.push(p);
    }
    if (prices.length < 2) return 1; // default to Normal

    // Compute realized volatility as std dev of returns
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i - 1] > 0) {
        returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
      }
    }
    if (returns.length === 0) return 1;

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
    const vol = Math.sqrt(variance);

    // Thresholds in return space (annualized equivalent not needed for classification)
    if (vol < 0.0005) return 0; // Calm
    if (vol < 0.002) return 1;  // Normal
    return 2;                    // Volatile
  }
}
