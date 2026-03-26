import type { MarketEvent } from '../shared/types.js';

/**
 * Micro-batching event loop that collects MarketEvents
 * and processes them at a configurable tick interval.
 *
 * Provides backpressure detection via pending count monitoring.
 */
export class TickLoop {
  private readonly queue: MarketEvent[] = [];
  private readonly intervalMs: number;
  private readonly maxBatchSize: number;
  private handler: ((events: MarketEvent[]) => Promise<void>) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private processing = false;

  constructor(config: { intervalMs: number; maxBatchSize: number }) {
    this.intervalMs = config.intervalMs;
    this.maxBatchSize = config.maxBatchSize;
  }

  /**
   * Register the tick handler that processes each micro-batch.
   * Only one handler is supported; subsequent calls replace the previous one.
   */
  onTick(handler: (events: MarketEvent[]) => Promise<void>): void {
    this.handler = handler;
  }

  /**
   * Push an event into the internal queue for next tick processing.
   */
  push(event: MarketEvent): void {
    this.queue.push(event);
  }

  /**
   * Start the tick loop. Events will be drained and processed
   * at the configured interval.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  /**
   * Stop the tick loop. Does not drain remaining events;
   * call drainRemaining() if needed before stop.
   */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Number of events waiting in the queue.
   * Use this for backpressure detection.
   */
  getPendingCount(): number {
    return this.queue.length;
  }

  /**
   * Whether the tick loop is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Drain and process all remaining events in the queue.
   * Used during graceful shutdown.
   */
  async drainRemaining(): Promise<void> {
    while (this.queue.length > 0) {
      await this.tick();
    }
  }

  /**
   * Process a single tick: drain up to maxBatchSize events from the queue
   * and deliver them to the handler.
   */
  private async tick(): Promise<void> {
    if (!this.handler || this.processing) return;
    if (this.queue.length === 0) return;

    this.processing = true;
    try {
      const batchSize = Math.min(this.queue.length, this.maxBatchSize);
      const batch = this.queue.splice(0, batchSize);
      await this.handler(batch);
    } finally {
      this.processing = false;
    }
  }
}
