import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  EventType,
  type MarketEvent,
  type EventId,
  type Timestamp,
  type VenueId,
  type SymbolId,
  type PriceFp,
  type QtyFp,
  type CoherenceDecision,
} from '../../src/shared/types.js';
import { createEventBus, type DomainEventBus } from '../../src/shared/event-bus.js';
import { createLogger } from '../../src/shared/logger.js';
import { MarketGraph } from '../../src/graph/market-graph.js';
import { RulePolicyKernel } from '../../src/policy/policy-kernel.js';
import { PositionTracker } from '../../src/risk/position-tracker.js';
import { LivePipeline } from '../../src/pipeline/live-pipeline.js';
import type {
  PipelineDependencies,
  CoherenceGateAdapter,
  GnnPipelineAdapter,
  OrderManagerAdapter,
  ReceiptStoreAdapter,
  SegmentStoreAdapter,
  KillSwitchAdapter,
} from '../../src/pipeline/types.js';

const logger = createLogger({ component: 'test-pipeline' });

function makeSyntheticEvent(index: number): MarketEvent {
  return {
    eventId: `evt-${index}` as EventId,
    tsExchangeNs: (1700000000_000_000_000n + BigInt(index) * 1_000_000n) as Timestamp,
    tsIngestNs: (1700000000_000_000_000n + BigInt(index) * 1_000_000n + 500n) as Timestamp,
    venueId: 0 as VenueId,
    symbolId: 0 as SymbolId,
    eventType: EventType.Trade,
    priceFp: 50000_00000000n as PriceFp,
    qtyFp: 1_00000000n as QtyFp,
    flags: 0,
    seq: BigInt(index),
  };
}

function createStubDependencies(eventBus: DomainEventBus): PipelineDependencies {
  const graph = new MarketGraph();
  const positionTracker = new PositionTracker();

  let killSwitchActive = false;
  const killSwitch: KillSwitchAdapter = {
    isActive: () => killSwitchActive,
    activate: () => { killSwitchActive = true; },
    deactivate: () => { killSwitchActive = false; },
  };

  const policyKernel = new RulePolicyKernel(() => killSwitch.isActive());

  const coherenceDecision: CoherenceDecision = {
    allowRetrieve: true,
    allowWrite: true,
    allowLearn: true,
    allowAct: true,
    mincutValue: 100n,
    partitionHash: 'test-hash',
    driftScore: 0,
    cusumScore: 0,
    reasons: [],
  };

  const coherenceGate: CoherenceGateAdapter = {
    evaluate: vi.fn().mockResolvedValue(coherenceDecision),
  };

  const gnnPipeline: GnnPipelineAdapter = {
    process: vi.fn().mockResolvedValue({
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
    execute: vi.fn().mockResolvedValue({ orderId: 'test-order-1', success: true }),
  };

  const receiptStore: ReceiptStoreAdapter = {
    append: vi.fn().mockResolvedValue(undefined),
    getRecent: vi.fn().mockResolvedValue([]),
  };

  const segmentStore: SegmentStoreAdapter = {
    write: vi.fn().mockResolvedValue(true),
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

describe('LivePipeline', () => {
  let eventBus: DomainEventBus;
  let deps: PipelineDependencies;
  let pipeline: LivePipeline;

  beforeEach(() => {
    eventBus = createEventBus();
    deps = createStubDependencies(eventBus);
    pipeline = new LivePipeline(
      { mode: 'paper', tickIntervalMs: 5, maxBatchSize: 50, backpressureThreshold: 500 },
      deps,
    );
  });

  afterEach(async () => {
    await pipeline.stop();
    eventBus.removeAllListeners();
  });

  it('should start and stop without error', async () => {
    await pipeline.start();
    const health = await pipeline.getHealth();
    expect(health.healthy).toBe(true);
    await pipeline.stop();
  });

  it('should process events through all stages', async () => {
    await pipeline.start();

    // Publish events into the bus
    const eventCount = 20;
    for (let i = 0; i < eventCount; i++) {
      eventBus.publish('MarketDataReceived', {
        event: makeSyntheticEvent(i),
        receivedAt: BigInt(Date.now()) * 1_000_000n,
      });
    }

    // Wait for tick loop to process
    await new Promise((resolve) => setTimeout(resolve, 100));

    const stats = pipeline.getStats();
    expect(stats.eventsProcessed).toBeGreaterThan(0);
    expect(stats.uptime).toBeGreaterThan(0);
  });

  it('should feed 100 synthetic events and report correct counts', async () => {
    await pipeline.start();

    for (let i = 0; i < 100; i++) {
      eventBus.publish('MarketDataReceived', {
        event: makeSyntheticEvent(i),
        receivedAt: BigInt(Date.now()) * 1_000_000n,
      });
    }

    // Allow time for all ticks to process
    await new Promise((resolve) => setTimeout(resolve, 300));

    const stats = pipeline.getStats();
    expect(stats.eventsProcessed).toBe(100);
    expect(stats.graphNodeCount).toBeGreaterThan(0);
  });

  it('should call GNN pipeline for each event', async () => {
    await pipeline.start();

    for (let i = 0; i < 5; i++) {
      eventBus.publish('MarketDataReceived', {
        event: makeSyntheticEvent(i),
        receivedAt: BigInt(Date.now()) * 1_000_000n,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(deps.gnnPipeline.process).toHaveBeenCalled();
  });

  it('should cache latest predictions per symbol', async () => {
    await pipeline.start();

    eventBus.publish('MarketDataReceived', {
      event: makeSyntheticEvent(0),
      receivedAt: BigInt(Date.now()) * 1_000_000n,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const predictions = pipeline.getLatestPredictions(0);
    expect(predictions).toBeDefined();
    expect(predictions!.predictions.length).toBeGreaterThan(0);
  });

  it('should return pipeline stats with latency data', async () => {
    await pipeline.start();

    for (let i = 0; i < 10; i++) {
      eventBus.publish('MarketDataReceived', {
        event: makeSyntheticEvent(i),
        receivedAt: BigInt(Date.now()) * 1_000_000n,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    const stats = pipeline.getStats();
    expect(stats.avgLatencyMs).toBeGreaterThanOrEqual(0);
    expect(stats.p99LatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('should handle kill switch activation', async () => {
    await pipeline.start();
    deps.killSwitch.activate('test');
    expect(deps.killSwitch.isActive()).toBe(true);

    deps.killSwitch.deactivate();
    expect(deps.killSwitch.isActive()).toBe(false);
  });
});
