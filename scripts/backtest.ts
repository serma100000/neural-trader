#!/usr/bin/env tsx
/**
 * CLI entry point for running backtests.
 *
 * Usage:
 *   npx tsx scripts/backtest.ts --config config/strategy.yaml --start 2024-01-01 --end 2024-06-01
 *   npx tsx scripts/backtest.ts --config config/strategy.yaml --speed burst
 */

import { createLogger } from '../src/shared/logger.js';
import {
  EventType,
  type MarketEvent,
  type EventId,
  type Timestamp,
  type VenueId,
  type SymbolId,
  type PriceFp,
  type QtyFp,
} from '../src/shared/types.js';
import { createEventBus } from '../src/shared/event-bus.js';
import { MarketGraph } from '../src/graph/market-graph.js';
import { RulePolicyKernel } from '../src/policy/policy-kernel.js';
import { PositionTracker } from '../src/risk/position-tracker.js';
import { LivePipeline } from '../src/pipeline/live-pipeline.js';
import { ReplayEngine } from '../src/backtest/replay-engine.js';
import { BacktestRunner } from '../src/backtest/backtest-runner.js';
import type {
  CoherenceGateAdapter,
  GnnPipelineAdapter,
  OrderManagerAdapter,
  ReceiptStoreAdapter,
  SegmentStoreAdapter,
  KillSwitchAdapter,
} from '../src/pipeline/types.js';

const logger = createLogger({ component: 'backtest-cli' });

function parseArgs(): {
  config: string;
  start: string;
  end: string;
  speed: 'realtime' | 'accelerated' | 'burst';
  multiplier: number;
} {
  const args = process.argv.slice(2);
  const parsed: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const value = args[i + 1];
    if (key && value) {
      parsed[key] = value;
    }
  }

  return {
    config: parsed['config'] ?? 'config/default.yaml',
    start: parsed['start'] ?? '2024-01-01',
    end: parsed['end'] ?? '2024-12-31',
    speed: (parsed['speed'] as 'realtime' | 'accelerated' | 'burst') ?? 'burst',
    multiplier: parseInt(parsed['multiplier'] ?? '10', 10),
  };
}

/**
 * Generate synthetic market events for backtesting when no real data is available.
 */
function generateSyntheticEvents(count: number): MarketEvent[] {
  const events: MarketEvent[] = [];
  let price = 50000_00000000n; // $50,000 in 8-decimal fixed-point
  let seq = 0n;

  for (let i = 0; i < count; i++) {
    const delta = BigInt(Math.floor((Math.random() - 0.5) * 100_000_000));
    price += delta;

    events.push({
      eventId: `evt-${i}` as EventId,
      tsExchangeNs: (1700000000_000_000_000n + BigInt(i) * 100_000_000n) as Timestamp,
      tsIngestNs: (1700000000_000_000_000n + BigInt(i) * 100_000_000n + 1000n) as Timestamp,
      venueId: 0 as VenueId,
      symbolId: 0 as SymbolId,
      eventType: EventType.Trade,
      priceFp: price as PriceFp,
      qtyFp: (BigInt(Math.floor(Math.random() * 10_00000000)) + 1_00000000n) as QtyFp,
      flags: 0,
      seq: seq++,
    });
  }

  return events;
}

function createMockDependencies() {
  const eventBus = createEventBus();
  const graph = new MarketGraph();
  const positionTracker = new PositionTracker();

  let killSwitchActive = false;
  const killSwitch: KillSwitchAdapter = {
    isActive: () => killSwitchActive,
    activate: () => { killSwitchActive = true; },
    deactivate: () => { killSwitchActive = false; },
  };

  const policyKernel = new RulePolicyKernel(() => killSwitch.isActive());

  const coherenceGate: CoherenceGateAdapter = {
    evaluate: async () => ({
      allowRetrieve: true,
      allowWrite: true,
      allowLearn: true,
      allowAct: true,
      mincutValue: 100n,
      partitionHash: 'backtest-hash',
      driftScore: 0,
      cusumScore: 0,
      reasons: [],
    }),
  };

  const gnnPipeline: GnnPipelineAdapter = {
    process: async () => ({
      embeddings: [],
      predictions: [
        { headName: 'mid_1s', value: 0.5, confidence: 0.8, tsNs: 0n },
      ],
      controls: [
        { headName: 'place_signal', value: 0.05, confidence: 0.5 },
        { headName: 'side_signal', value: 0.6, confidence: 0.7 },
        { headName: 'size_signal', value: 0.3, confidence: 0.6 },
        { headName: 'urgency_signal', value: 0.2, confidence: 0.5 },
        { headName: 'regime_uncertainty', value: 0.1, confidence: 0.9 },
        { headName: 'adversarial_drift', value: 0.05, confidence: 0.9 },
      ],
      tsNs: 0n,
    }),
  };

  const orderManager: OrderManagerAdapter = {
    execute: async () => ({ orderId: `order-${Date.now()}`, success: true }),
  };

  const receiptStore: ReceiptStoreAdapter = {
    append: async () => {},
    getRecent: async () => [],
  };

  const segmentStore: SegmentStoreAdapter = {
    write: async () => true,
  };

  return {
    eventBus,
    logger,
    graph,
    policyKernel,
    positionTracker,
    coherenceGate,
    gnnPipeline,
    orderManager,
    receiptStore,
    segmentStore,
    killSwitch,
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  logger.info(args, 'Starting backtest');

  const deps = createMockDependencies();

  const pipeline = new LivePipeline(
    { mode: 'research', tickIntervalMs: 10, maxBatchSize: 512, backpressureThreshold: 2048 },
    deps,
  );

  const events = generateSyntheticEvents(1000);
  const replayEngine = new ReplayEngine(events, args.speed, args.multiplier);
  const runner = new BacktestRunner(pipeline, replayEngine, deps.eventBus, logger);

  const report = await runner.run();

  console.log('\n=== Backtest Report ===');
  console.log(`Total PnL:         ${report.totalPnl.toFixed(2)}`);
  console.log(`Sharpe Ratio:      ${report.sharpeRatio.toFixed(4)}`);
  console.log(`Sortino Ratio:     ${report.sortinoRatio.toFixed(4)}`);
  console.log(`Max Drawdown:      ${report.maxDrawdownPct.toFixed(2)}%`);
  console.log(`Win Rate:          ${(report.winRate * 100).toFixed(1)}%`);
  console.log(`Profit Factor:     ${report.profitFactor.toFixed(2)}`);
  console.log(`Total Trades:      ${report.totalTrades}`);
  console.log(`Avg Trade Return:  ${report.avgTradeReturn.toFixed(4)}`);
  console.log(`Coherence Uptime:  ${(report.coherenceUptime * 100).toFixed(1)}%`);
  console.log(`Gate Rejection:    ${(report.gateRejectionRate * 100).toFixed(1)}%`);
  console.log('======================\n');
}

main().catch((err) => {
  logger.error({ error: (err as Error).message }, 'Backtest failed');
  process.exit(1);
});
