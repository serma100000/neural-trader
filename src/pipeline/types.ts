import type { DomainEventBus } from '../shared/event-bus.js';
import type { Logger } from '../shared/logger.js';
import type { MarketGraph } from '../graph/market-graph.js';
import type { RulePolicyKernel } from '../policy/policy-kernel.js';
import type { PositionTracker } from '../risk/position-tracker.js';

export interface PipelineConfig {
  mode: 'research' | 'paper' | 'live';
  tickIntervalMs: number;
  maxBatchSize: number;
  backpressureThreshold: number;
}

export interface PipelineStats {
  eventsProcessed: number;
  avgLatencyMs: number;
  p99LatencyMs: number;
  graphNodeCount: number;
  graphEdgeCount: number;
  uptime: number;
}

export interface HealthStatus {
  healthy: boolean;
  components: {
    wasm: boolean;
    database: boolean;
    feeds: boolean;
    graph: boolean;
    gnn: boolean;
  };
  uptime: number;
  lastTickNs: bigint;
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  mode: 'paper',
  tickIntervalMs: 50,
  maxBatchSize: 256,
  backpressureThreshold: 1024,
};

/**
 * Dependencies injected into the LivePipeline.
 * All components are provided via constructor injection
 * to support testing with mocks/stubs.
 */
export interface PipelineDependencies {
  eventBus: DomainEventBus;
  logger: Logger;
  graph: MarketGraph;
  policyKernel: RulePolicyKernel;
  positionTracker: PositionTracker;
  coherenceGate: CoherenceGateAdapter;
  gnnPipeline: GnnPipelineAdapter;
  orderManager: OrderManagerAdapter;
  receiptStore: ReceiptStoreAdapter;
  segmentStore: SegmentStoreAdapter;
  killSwitch: KillSwitchAdapter;
}

/**
 * Adapters decouple the pipeline from concrete implementations,
 * allowing mock injection during backtest and testing.
 */
export interface CoherenceGateAdapter {
  evaluate(metrics: {
    mincutValue: number;
    driftScore: number;
    cusumScore: number;
  }): Promise<import('../shared/types.js').CoherenceDecision>;
}

export interface GnnPipelineAdapter {
  process(
    neighborhood: import('../graph/types.js').Neighborhood,
    symbolId: import('../shared/types.js').SymbolId,
  ): Promise<import('../gnn/types.js').ModelOutput>;
}

export interface OrderManagerAdapter {
  execute(
    decision: import('../policy/types.js').ActionDecision,
  ): Promise<{ orderId: string; success: boolean }>;
}

export interface ReceiptStoreAdapter {
  append(receipt: import('../shared/types.js').WitnessReceipt): Promise<void>;
  getRecent(limit: number): Promise<import('../shared/types.js').WitnessReceipt[]>;
}

export interface SegmentStoreAdapter {
  write(
    segment: {
      symbolId: import('../shared/types.js').SymbolId;
      startTsNs: import('../shared/types.js').Timestamp;
      endTsNs: import('../shared/types.js').Timestamp;
      segmentKind: string;
      dataBlob: Buffer | null;
      signature: Buffer | null;
      witnessHash: Buffer | null;
      metadata: Record<string, unknown> | null;
    },
    coherenceDecision: import('../shared/types.js').CoherenceDecision,
  ): Promise<boolean>;
}

export interface KillSwitchAdapter {
  isActive(): boolean;
  activate(reason: string): void;
  deactivate(): void;
}
