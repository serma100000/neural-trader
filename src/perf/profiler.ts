/**
 * Per-stage latency profiler using high-resolution timers.
 * Tracks percentiles using an in-memory digest per stage.
 */
export class Profiler {
  private readonly stages = new Map<string, StageDigest>();
  private readonly activeStages = new Map<string, number>();

  /**
   * Mark the start of a named stage.
   * Uses performance.now() for sub-millisecond resolution.
   */
  startStage(name: string): void {
    this.activeStages.set(name, performance.now());
  }

  /**
   * Mark the end of a named stage.
   * Records the elapsed time since startStage was called.
   */
  endStage(name: string): void {
    const start = this.activeStages.get(name);
    if (start === undefined) return;

    const elapsed = performance.now() - start;
    this.activeStages.delete(name);

    let digest = this.stages.get(name);
    if (!digest) {
      digest = new StageDigest();
      this.stages.set(name, digest);
    }
    digest.record(elapsed);
  }

  /**
   * Get latency statistics for all tracked stages.
   */
  getStats(): Map<
    string,
    { avg: number; p50: number; p95: number; p99: number; count: number }
  > {
    const result = new Map<
      string,
      { avg: number; p50: number; p95: number; p99: number; count: number }
    >();

    for (const [name, digest] of this.stages) {
      result.set(name, digest.summarize());
    }

    return result;
  }

  /**
   * Get stats for a single stage.
   */
  getStageStats(
    name: string,
  ): { avg: number; p50: number; p95: number; p99: number; count: number } | undefined {
    return this.stages.get(name)?.summarize();
  }

  /**
   * Reset all stage data.
   */
  reset(): void {
    this.stages.clear();
    this.activeStages.clear();
  }
}

/**
 * In-memory digest that tracks latency samples and computes percentiles.
 * Keeps a bounded buffer to prevent unbounded memory growth.
 */
class StageDigest {
  private readonly samples: number[] = [];
  private readonly maxSamples = 10_000;
  private total = 0;
  private count = 0;

  record(value: number): void {
    this.samples.push(value);
    this.total += value;
    this.count++;

    if (this.samples.length > this.maxSamples) {
      const removed = this.samples.shift()!;
      this.total -= removed;
      this.count--;
    }
  }

  summarize(): { avg: number; p50: number; p95: number; p99: number; count: number } {
    if (this.samples.length === 0) {
      return { avg: 0, p50: 0, p95: 0, p99: 0, count: 0 };
    }

    const sorted = [...this.samples].sort((a, b) => a - b);
    const len = sorted.length;

    return {
      avg: this.total / this.count,
      p50: sorted[Math.floor(len * 0.5)] ?? 0,
      p95: sorted[Math.floor(len * 0.95)] ?? 0,
      p99: sorted[Math.min(Math.floor(len * 0.99), len - 1)] ?? 0,
      count: this.count,
    };
  }
}
