import type { MarketEvent, SymbolId, VenueId } from '../shared/types.js';
import type { Logger } from '../shared/logger.js';
import type { SequenceGap } from './types.js';

type SequenceKey = string;

function makeKey(symbolId: SymbolId, venueId: VenueId): SequenceKey {
  return `${venueId}:${symbolId}`;
}

/**
 * Assigns monotonic sequence numbers per (symbolId, venueId) pair
 * and detects gaps in the incoming event stream.
 */
export class Sequencer {
  private readonly sequences = new Map<SequenceKey, bigint>();
  private readonly gapHandlers: Array<(gap: SequenceGap) => void> = [];

  constructor(private readonly logger: Logger) {}

  /**
   * Register a handler for sequence gap events.
   */
  onGap(handler: (gap: SequenceGap) => void): void {
    this.gapHandlers.push(handler);
  }

  /**
   * Process an event, checking its sequence against the expected value.
   * Returns the event with its validated sequence.
   */
  process(event: MarketEvent): MarketEvent {
    const key = makeKey(event.symbolId, event.venueId);
    const expectedSeq = this.sequences.get(key);

    if (expectedSeq !== undefined) {
      const expected = expectedSeq + 1n;
      if (event.seq !== expected) {
        const gap: SequenceGap = {
          symbolId: event.symbolId,
          venueId: event.venueId,
          expectedSeq: expected,
          receivedSeq: event.seq,
          detectedAtNs: process.hrtime.bigint(),
        };

        const gapSize = event.seq - expected;
        if (gapSize > 100n) {
          this.logger.error(
            { symbolId: event.symbolId, venueId: event.venueId, expected: expected.toString(), received: event.seq.toString(), gapSize: gapSize.toString() },
            'Large sequence gap detected',
          );
        } else if (gapSize > 0n) {
          this.logger.warn(
            { symbolId: event.symbolId, venueId: event.venueId, expected: expected.toString(), received: event.seq.toString() },
            'Sequence gap detected',
          );
        } else {
          // Negative gap = duplicate or out-of-order
          this.logger.warn(
            { symbolId: event.symbolId, venueId: event.venueId, expected: expected.toString(), received: event.seq.toString() },
            'Out-of-order or duplicate sequence',
          );
        }

        for (const handler of this.gapHandlers) {
          handler(gap);
        }
      }
    }

    this.sequences.set(key, event.seq);
    return event;
  }

  /**
   * Reset sequence tracking for a specific (symbolId, venueId) pair.
   * Call this on feed reconnection to avoid false gap detection.
   */
  reset(symbolId: SymbolId, venueId: VenueId): void {
    const key = makeKey(symbolId, venueId);
    this.sequences.delete(key);
    this.logger.info(
      { symbolId, venueId },
      'Sequence reset',
    );
  }

  /**
   * Reset all sequence tracking state.
   */
  resetAll(): void {
    this.sequences.clear();
    this.logger.info('All sequences reset');
  }

  /**
   * Get the current sequence number for a (symbolId, venueId) pair.
   */
  getCurrentSeq(symbolId: SymbolId, venueId: VenueId): bigint | undefined {
    return this.sequences.get(makeKey(symbolId, venueId));
  }
}
