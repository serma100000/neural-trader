import type { MarketEvent, SymbolId } from '../shared/types.js';
import type { DomainEventBus, OrderFilledPayload } from '../shared/event-bus.js';
import type { Logger } from '../shared/logger.js';
import type { LivePipeline } from '../pipeline/live-pipeline.js';
import type { ReplayEngine } from './replay-engine.js';
import type { BacktestReport, TradeRecord } from './types.js';
import { generateReport } from './report.js';

/**
 * Runs a LivePipeline against historical data from a ReplayEngine.
 * Collects fills, tracks positions, and produces a BacktestReport.
 */
export class BacktestRunner {
  private readonly pipeline: LivePipeline;
  private readonly replayEngine: ReplayEngine;
  private readonly eventBus: DomainEventBus;
  private readonly logger: Logger;

  private readonly fills: OrderFilledPayload[] = [];
  private coherenceTotal = 0;
  private coherenceAllowed = 0;

  constructor(
    pipeline: LivePipeline,
    replayEngine: ReplayEngine,
    eventBus: DomainEventBus,
    logger: Logger,
  ) {
    this.pipeline = pipeline;
    this.replayEngine = replayEngine;
    this.eventBus = eventBus;
    this.logger = logger;
  }

  /**
   * Execute the backtest:
   * 1. Start the pipeline
   * 2. Replay events through the event bus
   * 3. Collect fills and coherence decisions
   * 4. Stop the pipeline
   * 5. Generate and return the report
   */
  async run(): Promise<BacktestReport> {
    this.fills.length = 0;
    this.coherenceTotal = 0;
    this.coherenceAllowed = 0;

    // Subscribe to fills and coherence events
    const fillHandler = (payload: OrderFilledPayload): void => {
      this.fills.push(payload);
    };
    this.eventBus.subscribe('OrderFilled', fillHandler);

    const coherenceHandler = (
      payload: import('../shared/event-bus.js').CoherenceEvaluatedPayload,
    ): void => {
      this.coherenceTotal++;
      if (payload.decision.allowAct) {
        this.coherenceAllowed++;
      }
    };
    this.eventBus.subscribe('CoherenceEvaluated', coherenceHandler);

    // Start pipeline
    await this.pipeline.start();

    this.logger.info('Backtest started');

    // Replay events - each event gets published to the event bus
    await this.replayEngine.start(async (event: MarketEvent) => {
      this.eventBus.publish('MarketDataReceived', {
        event,
        receivedAt: event.tsIngestNs as bigint,
      });

      // Small yield to allow async pipeline processing
      await new Promise<void>((resolve) => {
        queueMicrotask(resolve);
      });
    });

    // Stop pipeline and clean up
    await this.pipeline.stop();

    this.eventBus.unsubscribe('OrderFilled', fillHandler);
    this.eventBus.unsubscribe('CoherenceEvaluated', coherenceHandler);

    const trades = this.buildTradeRecords();
    const progress = this.replayEngine.getProgress();

    this.logger.info(
      {
        eventsProcessed: progress.processed,
        tradesGenerated: trades.length,
        fillsCollected: this.fills.length,
      },
      'Backtest completed',
    );

    return generateReport(trades, {
      total: this.coherenceTotal,
      allowed: this.coherenceAllowed,
    });
  }

  /**
   * Convert collected fills into trade records.
   * Groups fills by symbol and pairs entries with exits.
   */
  private buildTradeRecords(): TradeRecord[] {
    const trades: TradeRecord[] = [];
    const openBySymbol = new Map<number, OrderFilledPayload[]>();

    for (const fill of this.fills) {
      const symbolId = fill.symbolId as number;
      const existing = openBySymbol.get(symbolId) ?? [];

      if (existing.length > 0) {
        // Close the position (simplified: first in, first out)
        const entry = existing.shift()!;
        const entryPrice = Number(entry.fillPrice) / 1e8;
        const exitPrice = Number(fill.fillPrice) / 1e8;
        const quantity = Number(fill.fillQty) / 1e8;
        const pnl = (exitPrice - entryPrice) * quantity;

        trades.push({
          symbolId,
          side: pnl >= 0 ? 'buy' : 'sell',
          entryPrice,
          exitPrice,
          quantity,
          pnl,
          entryTsNs: entry.tsNs,
          exitTsNs: fill.tsNs,
        });

        if (existing.length === 0) {
          openBySymbol.delete(symbolId);
        }
      } else {
        existing.push(fill);
        openBySymbol.set(symbolId, existing);
      }
    }

    return trades;
  }
}
