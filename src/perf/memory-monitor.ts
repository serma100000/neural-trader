export interface MemorySample {
  rssBytes: number;
  heapUsed: number;
  heapTotal: number;
  graphNodes: number;
  timestamp: number;
}

/**
 * Monitors process memory usage and graph size.
 * Maintains a rolling history of samples for trend analysis.
 */
export class MemoryMonitor {
  private readonly history: MemorySample[] = [];
  private readonly maxHistory: number;
  private graphNodesFn: (() => number) | null = null;

  constructor(maxHistory = 1000) {
    this.maxHistory = maxHistory;
  }

  /**
   * Register a function that returns the current graph node count.
   */
  setGraphNodesFn(fn: () => number): void {
    this.graphNodesFn = fn;
  }

  /**
   * Take a memory sample and add it to history.
   */
  sample(): MemorySample {
    const mem = process.memoryUsage();
    const s: MemorySample = {
      rssBytes: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      graphNodes: this.graphNodesFn ? this.graphNodesFn() : 0,
      timestamp: Date.now(),
    };

    this.history.push(s);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    return s;
  }

  /**
   * Check if RSS is below the given threshold.
   */
  isHealthy(maxRssBytes: number): boolean {
    const latest = this.history[this.history.length - 1];
    if (!latest) return true;
    return latest.rssBytes <= maxRssBytes;
  }

  /**
   * Get the last N memory samples.
   */
  getHistory(n: number): MemorySample[] {
    return this.history.slice(-n);
  }

  /**
   * Get the most recent sample, or null if none taken yet.
   */
  getLatest(): MemorySample | null {
    return this.history[this.history.length - 1] ?? null;
  }
}
