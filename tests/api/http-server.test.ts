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
import { ApiServer } from '../../src/api/http-server.js';
import type {
  PipelineDependencies,
  CoherenceGateAdapter,
  GnnPipelineAdapter,
  OrderManagerAdapter,
  ReceiptStoreAdapter,
  SegmentStoreAdapter,
  KillSwitchAdapter,
} from '../../src/pipeline/types.js';

const logger = createLogger({ component: 'test-api' });

function createStubDeps(eventBus: DomainEventBus): PipelineDependencies {
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
    evaluate: vi.fn().mockResolvedValue({
      allowRetrieve: true,
      allowWrite: true,
      allowLearn: true,
      allowAct: true,
      mincutValue: 100n,
      partitionHash: 'test',
      driftScore: 0,
      cusumScore: 0,
      reasons: [],
    } satisfies CoherenceDecision),
  };

  const gnnPipeline: GnnPipelineAdapter = {
    process: vi.fn().mockResolvedValue({
      embeddings: [],
      predictions: [],
      controls: [],
      tsNs: 0n,
    }),
  };

  const orderManager: OrderManagerAdapter = {
    execute: vi.fn().mockResolvedValue({ orderId: 'ord-1', success: true }),
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

describe('ApiServer', () => {
  let eventBus: DomainEventBus;
  let pipeline: LivePipeline;
  let apiServer: ApiServer;
  let deps: PipelineDependencies;
  let baseUrl: string;

  beforeEach(async () => {
    eventBus = createEventBus();
    deps = createStubDeps(eventBus);
    pipeline = new LivePipeline(
      { mode: 'paper', tickIntervalMs: 50, maxBatchSize: 100, backpressureThreshold: 500 },
      deps,
    );

    // Use port 0 for random available port
    apiServer = new ApiServer(pipeline, {
      host: '127.0.0.1',
      port: 0,
      apiPrefix: '/api/v1',
      logger,
    });

    await apiServer.start();
    const server = apiServer.getServer();
    const address = server.addresses();
    const addr = address[0];
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await apiServer.stop();
    await pipeline.stop();
    eventBus.removeAllListeners();
  });

  it('GET /health should return 200 with component status', async () => {
    await pipeline.start();
    const res = await fetch(`${baseUrl}/api/v1/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty('healthy');
    expect(body).toHaveProperty('components');
    expect(body.components).toHaveProperty('graph');
    expect(body.components).toHaveProperty('gnn');
    expect(body).toHaveProperty('uptime');
  });

  it('GET /positions should return empty array initially', async () => {
    const res = await fetch(`${baseUrl}/api/v1/positions`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty('positions');
    expect(body.positions).toEqual([]);
  });

  it('GET /stats should return pipeline statistics', async () => {
    const res = await fetch(`${baseUrl}/api/v1/stats`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty('eventsProcessed');
    expect(body).toHaveProperty('avgLatencyMs');
    expect(body).toHaveProperty('p99LatencyMs');
    expect(body).toHaveProperty('graphNodeCount');
    expect(body).toHaveProperty('graphEdgeCount');
    expect(body).toHaveProperty('uptime');
  });

  it('GET /audit should return empty receipts initially', async () => {
    const res = await fetch(`${baseUrl}/api/v1/audit`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty('receipts');
    expect(body.receipts).toEqual([]);
  });

  it('POST /kill-switch/activate should activate kill switch', async () => {
    const res = await fetch(`${baseUrl}/api/v1/kill-switch/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'test activation' }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.activated).toBe(true);
    expect(body.reason).toBe('test activation');
    expect(deps.killSwitch.isActive()).toBe(true);
  });

  it('POST /kill-switch/deactivate should deactivate kill switch', async () => {
    deps.killSwitch.activate('pre-test');
    expect(deps.killSwitch.isActive()).toBe(true);

    const res = await fetch(`${baseUrl}/api/v1/kill-switch/deactivate`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.activated).toBe(false);
    expect(deps.killSwitch.isActive()).toBe(false);
  });

  it('GET /predictions/:symbol should return 404 for unknown symbol', async () => {
    const res = await fetch(`${baseUrl}/api/v1/predictions/999`);
    expect(res.status).toBe(404);
  });

  it('GET /coherence/:symbol should return 404 for unknown symbol', async () => {
    const res = await fetch(`${baseUrl}/api/v1/coherence/999`);
    expect(res.status).toBe(404);
  });

  it('GET /predictions/:symbol should return 400 for invalid ID', async () => {
    const res = await fetch(`${baseUrl}/api/v1/predictions/abc`);
    expect(res.status).toBe(400);
  });
});
