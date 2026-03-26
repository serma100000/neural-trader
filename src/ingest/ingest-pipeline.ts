import type { MarketEvent, SymbolId } from '../shared/types.js';
import type { Logger } from '../shared/logger.js';
import type { DomainEventBus } from '../shared/event-bus.js';
import type { FeedAdapter } from './feed-adapter.js';
import type { IngestConfig, IngestStats, FeedConfig, SequenceGap } from './types.js';
import { Normalizer } from './normalizer.js';
import { Sequencer } from './sequencer.js';
import { ReorderBuffer } from './reorder-buffer.js';

/**
 * Orchestrates the full ingest flow:
 *   connect feeds -> normalize -> sequence -> reorder -> publish to event bus
 */
export class IngestPipeline {
  private readonly adapters = new Map<string, FeedAdapter>();
  private readonly normalizer: Normalizer;
  private readonly sequencer: Sequencer;
  private readonly reorderBuffer: ReorderBuffer;
  private readonly symbolMap = new Map<string, SymbolId>();
  private startedAt: number | null = null;

  private totalEventsIngested = 0n;
  private totalGapsDetected = 0n;
  private totalMalformedFrames = 0n;
  private readonly eventsPerFeed = new Map<string, bigint>();
  private lastEventTsNs = 0n;

  constructor(
    private readonly config: IngestConfig,
    private readonly eventBus: DomainEventBus,
    private readonly logger: Logger,
  ) {
    this.normalizer = new Normalizer(
      (venue, symbol) => this.resolveSymbol(venue, symbol),
      logger,
    );

    this.sequencer = new Sequencer(logger);
    this.sequencer.onGap((gap: SequenceGap) => {
      this.totalGapsDetected++;
      this.logger.warn(
        {
          symbolId: gap.symbolId,
          venueId: gap.venueId,
          expected: gap.expectedSeq.toString(),
          received: gap.receivedSeq.toString(),
        },
        'Sequence gap in ingest pipeline',
      );
    });

    this.reorderBuffer = new ReorderBuffer(
      config.reorderBufferCapacity,
      config.clockToleranceNs,
      logger,
    );

    this.reorderBuffer.onFlush((event: MarketEvent) => {
      this.publishEvent(event);
    });
  }

  /**
   * Register a symbol mapping for normalization.
   */
  registerSymbol(venueId: string, symbolName: string, symbolId: SymbolId): void {
    const key = `${venueId}:${symbolName}`;
    this.symbolMap.set(key, symbolId);
  }

  /**
   * Add a feed adapter to the pipeline.
   */
  addFeed(feedConfig: FeedConfig, adapter: FeedAdapter): void {
    const feedKey = `${feedConfig.venueId}:${feedConfig.venueName}`;

    adapter.onFrame((frame) => {
      const events = this.normalizer.normalize(frame);
      if (events.length === 0) {
        // Could be subscription ack or malformed
        return;
      }

      for (const event of events) {
        const sequenced = this.sequencer.process(event);
        this.reorderBuffer.insert(sequenced);

        // Update per-feed stats
        const current = this.eventsPerFeed.get(feedKey) ?? 0n;
        this.eventsPerFeed.set(feedKey, current + 1n);
      }
    });

    adapter.onError((error) => {
      this.logger.error(
        { error: error.message, feed: feedKey },
        'Feed error',
      );
    });

    adapter.onDisconnect(() => {
      this.logger.warn({ feed: feedKey }, 'Feed disconnected');
      // Reset sequences for symbols on this feed to avoid false gaps on reconnect
      for (const symbolId of feedConfig.symbols) {
        this.sequencer.reset(symbolId, feedConfig.venueId);
      }
      this.normalizer.resetSequence();
    });

    this.adapters.set(feedKey, adapter);
    this.logger.info({ feed: feedKey }, 'Feed added to pipeline');
  }

  /**
   * Start all configured feeds.
   */
  async start(): Promise<void> {
    this.startedAt = Date.now();
    this.logger.info(
      { feedCount: this.adapters.size },
      'Starting ingest pipeline',
    );

    const connectPromises: Promise<void>[] = [];
    for (const [key, adapter] of this.adapters) {
      connectPromises.push(
        adapter.connect().catch((err) => {
          this.logger.error({ feed: key, err }, 'Failed to connect feed');
        }),
      );
    }

    await Promise.allSettled(connectPromises);
    this.logger.info('Ingest pipeline started');
  }

  /**
   * Stop all feeds and flush remaining events.
   */
  async stop(): Promise<void> {
    this.logger.info('Stopping ingest pipeline');

    const disconnectPromises: Promise<void>[] = [];
    for (const [key, adapter] of this.adapters) {
      disconnectPromises.push(
        adapter.disconnect().catch((err) => {
          this.logger.error({ feed: key, err }, 'Failed to disconnect feed');
        }),
      );
    }

    await Promise.allSettled(disconnectPromises);

    // Flush any remaining events in the reorder buffer
    this.reorderBuffer.flushAll();

    this.logger.info(
      {
        totalEvents: this.totalEventsIngested.toString(),
        totalGaps: this.totalGapsDetected.toString(),
      },
      'Ingest pipeline stopped',
    );
  }

  /**
   * Get current pipeline statistics.
   */
  getStats(): IngestStats {
    return {
      totalEventsIngested: this.totalEventsIngested,
      totalGapsDetected: this.totalGapsDetected,
      totalMalformedFrames: this.totalMalformedFrames,
      eventsPerFeed: new Map(this.eventsPerFeed),
      lastEventTsNs: this.lastEventTsNs,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }

  private publishEvent(event: MarketEvent): void {
    this.totalEventsIngested++;
    this.lastEventTsNs = event.tsExchangeNs as bigint;

    this.eventBus.publish('MarketDataReceived', {
      event,
      receivedAt: event.tsIngestNs as bigint,
    });
  }

  private resolveSymbol(venue: string, symbol: string): SymbolId | undefined {
    return this.symbolMap.get(`${venue}:${symbol}`);
  }
}
