import type { MarketEvent } from '../shared/types.js';

/**
 * Replays historical MarketEvent sequences at configurable speed.
 *
 * Speed modes:
 * - realtime:    events are replayed at their original pace
 * - accelerated: events are replayed at multiplied speed
 * - burst:       all events are delivered as fast as possible
 */
export class ReplayEngine {
  private readonly events: MarketEvent[];
  private readonly speed: 'realtime' | 'accelerated' | 'burst';
  private readonly multiplier: number;

  private processed = 0;
  private paused = false;
  private stopped = false;
  private pauseResolve: (() => void) | null = null;

  constructor(
    events: MarketEvent[],
    speed: 'realtime' | 'accelerated' | 'burst' = 'burst',
    multiplier = 1,
  ) {
    this.events = events;
    this.speed = speed;
    this.multiplier = Math.max(1, multiplier);
  }

  /**
   * Start replaying events, invoking the handler for each one.
   * Returns when all events are processed or stop() is called.
   */
  async start(handler: (event: MarketEvent) => Promise<void>): Promise<void> {
    this.processed = 0;
    this.stopped = false;
    this.paused = false;

    let prevTsNs = 0n;

    for (let i = 0; i < this.events.length; i++) {
      if (this.stopped) break;

      // Handle pause
      if (this.paused) {
        await new Promise<void>((resolve) => {
          this.pauseResolve = resolve;
        });
      }

      if (this.stopped) break;

      const event = this.events[i];
      const currentTsNs = event.tsExchangeNs as bigint;

      // Inter-event delay for realtime/accelerated modes
      if (this.speed !== 'burst' && prevTsNs > 0n && currentTsNs > prevTsNs) {
        const deltaNs = currentTsNs - prevTsNs;
        const delayMs = Number(deltaNs) / 1_000_000;
        const adjustedDelayMs =
          this.speed === 'accelerated'
            ? delayMs / this.multiplier
            : delayMs;

        if (adjustedDelayMs > 0) {
          await sleep(adjustedDelayMs);
        }
      }

      prevTsNs = currentTsNs;
      await handler(event);
      this.processed++;
    }
  }

  /**
   * Pause replay. Events in flight will complete.
   */
  pause(): void {
    this.paused = true;
  }

  /**
   * Resume a paused replay.
   */
  resume(): void {
    this.paused = false;
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
    }
  }

  /**
   * Stop replay entirely. Cannot be resumed.
   */
  stop(): void {
    this.stopped = true;
    this.paused = false;
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
    }
  }

  /**
   * Get replay progress.
   */
  getProgress(): { processed: number; total: number; pctComplete: number } {
    const total = this.events.length;
    return {
      processed: this.processed,
      total,
      pctComplete: total > 0 ? (this.processed / total) * 100 : 0,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
