import type { MarketEvent, Timestamp } from '../shared/types.js';
import type { Logger } from '../shared/logger.js';

interface BufferEntry {
  event: MarketEvent;
  insertedAt: bigint;
}

/**
 * Reorder buffer per ADR-005.
 * Buffers events and flushes them in tsExchangeNs order once they
 * fall outside the clock tolerance window. This corrects for
 * out-of-order delivery from venue feeds.
 */
export class ReorderBuffer {
  private buffer: BufferEntry[] = [];
  private readonly flushHandlers: Array<(event: MarketEvent) => void> = [];

  constructor(
    private readonly capacity: number,
    private readonly clockToleranceNs: bigint,
    private readonly logger: Logger,
  ) {
    if (capacity <= 0) {
      throw new Error(`ReorderBuffer capacity must be positive, got ${capacity}`);
    }
  }

  /**
   * Register a handler called when events are flushed in order.
   */
  onFlush(handler: (event: MarketEvent) => void): void {
    this.flushHandlers.push(handler);
  }

  /**
   * Insert an event into the buffer.
   * May trigger a flush if the buffer is full or events exceed the tolerance window.
   */
  insert(event: MarketEvent): void {
    const now = process.hrtime.bigint();

    this.buffer.push({ event, insertedAt: now });

    // Sort by tsExchangeNs (insertion sort would be more efficient for
    // nearly-sorted data, but Array.sort is fine for our buffer sizes)
    this.buffer.sort((a, b) => {
      const diff = a.event.tsExchangeNs - b.event.tsExchangeNs;
      if (diff < 0n) return -1;
      if (diff > 0n) return 1;
      // Break ties by seq
      const seqDiff = a.event.seq - b.event.seq;
      if (seqDiff < 0n) return -1;
      if (seqDiff > 0n) return 1;
      return 0;
    });

    // Flush events that are outside the tolerance window
    this.flushReady(now);

    // Force flush if buffer exceeds capacity
    if (this.buffer.length > this.capacity) {
      this.logger.warn(
        { bufferSize: this.buffer.length, capacity: this.capacity },
        'Buffer full, force flushing oldest events',
      );
      this.forceFlush();
    }
  }

  /**
   * Flush all remaining events in order.
   * Call this during shutdown or when the feed disconnects.
   */
  flushAll(): void {
    const events = this.buffer.splice(0);
    for (const entry of events) {
      this.emit(entry.event);
    }
  }

  /**
   * Number of events currently buffered.
   */
  get size(): number {
    return this.buffer.length;
  }

  /**
   * Flush events whose tsExchangeNs is older than (latestTs - tolerance).
   * This means we've waited long enough for any reordered events at that timestamp.
   */
  private flushReady(now: bigint): void {
    if (this.buffer.length === 0) return;

    // Use the latest event timestamp as the reference
    const latestTs = this.buffer[this.buffer.length - 1]!.event.tsExchangeNs;
    const cutoff = latestTs - this.clockToleranceNs;

    let flushCount = 0;
    while (this.buffer.length > 0) {
      const oldest = this.buffer[0]!;
      if ((oldest.event.tsExchangeNs as bigint) <= (cutoff as bigint)) {
        this.buffer.shift();
        this.emit(oldest.event);
        flushCount++;
      } else {
        break;
      }
    }

    if (flushCount > 0) {
      this.logger.debug({ flushCount, remaining: this.buffer.length }, 'Flushed events from reorder buffer');
    }
  }

  /**
   * Force-flush events when buffer is over capacity.
   * Flushes enough events to get back to 75% capacity.
   */
  private forceFlush(): void {
    const target = Math.floor(this.capacity * 0.75);
    while (this.buffer.length > target) {
      const entry = this.buffer.shift();
      if (entry) {
        this.emit(entry.event);
      }
    }
  }

  private emit(event: MarketEvent): void {
    for (const handler of this.flushHandlers) {
      handler(event);
    }
  }
}
