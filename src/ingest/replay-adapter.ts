import { readFile } from 'node:fs/promises';
import type { FeedAdapter } from './feed-adapter.js';
import type { RawFrame, ReplayConfig } from './types.js';
import type { VenueId } from '../shared/types.js';
import type { Logger } from '../shared/logger.js';

/**
 * File-based replay adapter for backtesting.
 * Reads events from JSON files and replays them at configurable speed.
 * Implements the FeedAdapter interface for seamless integration with IngestPipeline.
 */
export class ReplayAdapter implements FeedAdapter {
  private connected = false;
  private paused = false;
  private events: unknown[] = [];
  private currentIndex = 0;
  private replayTimer: ReturnType<typeof setTimeout> | null = null;

  private frameHandlers: Array<(frame: RawFrame) => void> = [];
  private errorHandlers: Array<(error: Error) => void> = [];
  private disconnectHandlers: Array<() => void> = [];

  constructor(
    private readonly venueId: VenueId,
    private readonly config: ReplayConfig,
    private readonly logger: Logger,
  ) {}

  async connect(): Promise<void> {
    try {
      const content = await readFile(this.config.filePath, 'utf-8');
      this.events = JSON.parse(content) as unknown[];
      this.currentIndex = 0;
      this.connected = true;
      this.paused = false;
      this.logger.info(
        { filePath: this.config.filePath, eventCount: this.events.length, speed: this.config.speed },
        'Replay adapter connected',
      );
      this.scheduleNext();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const handler of this.errorHandlers) {
        handler(error);
      }
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.paused = false;
    this.clearTimer();
    for (const handler of this.disconnectHandlers) {
      handler();
    }
    this.logger.info('Replay adapter disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  onFrame(handler: (frame: RawFrame) => void): void {
    this.frameHandlers.push(handler);
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandlers.push(handler);
  }

  /**
   * Pause replay without disconnecting.
   */
  pause(): void {
    this.paused = true;
    this.clearTimer();
    this.logger.info('Replay paused');
  }

  /**
   * Resume a paused replay.
   */
  resume(): void {
    if (this.paused && this.connected) {
      this.paused = false;
      this.logger.info('Replay resumed');
      this.scheduleNext();
    }
  }

  /**
   * Load events directly (useful for testing without file I/O).
   */
  loadEvents(events: unknown[]): void {
    this.events = events;
    this.currentIndex = 0;
  }

  private scheduleNext(): void {
    if (!this.connected || this.paused || this.currentIndex >= this.events.length) {
      if (this.currentIndex >= this.events.length && this.connected) {
        if (this.config.loop) {
          this.currentIndex = 0;
          this.scheduleNext();
          return;
        }
        // Replay complete
        this.logger.info('Replay complete');
        for (const handler of this.disconnectHandlers) {
          handler();
        }
        this.connected = false;
      }
      return;
    }

    const delay = this.calculateDelay();

    if (delay <= 0) {
      // Max speed: emit immediately via setImmediate to avoid stack overflow
      this.replayTimer = setTimeout(() => this.emitNext(), 0);
    } else {
      this.replayTimer = setTimeout(() => this.emitNext(), delay);
    }
  }

  private emitNext(): void {
    if (!this.connected || this.paused) return;

    const data = this.events[this.currentIndex];
    if (data === undefined) return;

    const frame: RawFrame = {
      venueId: this.venueId,
      data,
      receivedAtNs: process.hrtime.bigint(),
    };

    for (const handler of this.frameHandlers) {
      handler(frame);
    }

    this.currentIndex++;
    this.scheduleNext();
  }

  private calculateDelay(): number {
    if (this.config.speed <= 0) return 0; // max speed

    const current = this.events[this.currentIndex] as Record<string, unknown> | undefined;
    const next = this.events[this.currentIndex + 1] as Record<string, unknown> | undefined;

    if (!current || !next) return 0;

    // Try to extract timestamps for realistic replay timing
    const currentTs = extractTimestamp(current);
    const nextTs = extractTimestamp(next);

    if (currentTs === null || nextTs === null) {
      // No timestamps, use fixed 1ms interval
      return Math.max(1, Math.floor(1 / this.config.speed));
    }

    const diffMs = nextTs - currentTs;
    if (diffMs <= 0) return 0;

    return Math.max(0, Math.floor(diffMs / this.config.speed));
  }

  private clearTimer(): void {
    if (this.replayTimer) {
      clearTimeout(this.replayTimer);
      this.replayTimer = null;
    }
  }
}

/**
 * Try to extract a millisecond timestamp from a Binance-format event.
 */
function extractTimestamp(data: Record<string, unknown>): number | null {
  // Binance trade: T is trade time
  if (typeof data['T'] === 'number') return data['T'] as number;
  // Binance depth: E is event time
  if (typeof data['E'] === 'number') return data['E'] as number;
  return null;
}
