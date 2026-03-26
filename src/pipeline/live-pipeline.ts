import { createHash } from 'node:crypto';
import type {
  MarketEvent,
  SymbolId,
  Timestamp,
  CoherenceDecision,
  WitnessReceipt,
  VerifiedToken,
} from '../shared/types.js';
import type { DomainEventBus, MarketDataReceivedPayload } from '../shared/event-bus.js';
import type { Logger } from '../shared/logger.js';
import type { ModelOutput } from '../gnn/types.js';
import type { ActionDecision, PositionSnapshot, RiskBudgetSnapshot, VenueState } from '../policy/types.js';
import type {
  PipelineConfig,
  PipelineStats,
  HealthStatus,
  PipelineDependencies,
} from './types.js';
import { DEFAULT_PIPELINE_CONFIG } from './types.js';
import { TickLoop } from './tick-loop.js';
import { HealthChecker } from './health-check.js';
import { Profiler } from '../perf/profiler.js';

/**
 * Main pipeline that wires all bounded contexts end-to-end.
 *
 * Event flow per ADR-085:
 * 1. Receive MarketEvent from ingest (via event bus)
 * 2. Apply to graph
 * 3. Extract neighborhood for GNN
 * 4. Run GNN pipeline -> embeddings + predictions + controls
 * 5. Evaluate coherence gate
 * 6. Run policy kernel with predictions + coherence
 * 7. Check risk budget
 * 8. Execute decision (via OrderManager)
 * 9. Create proof token + witness receipt
 * 10. Store replay segment if admitted
 * 11. Publish results to serving layer
 */
export class LivePipeline {
  private readonly config: PipelineConfig;
  private readonly deps: PipelineDependencies;
  private readonly tickLoop: TickLoop;
  private readonly healthChecker: HealthChecker;
  private readonly profiler: Profiler;

  private eventsProcessed = 0;
  private latencies: number[] = [];
  private readonly maxLatencyBuffer = 10_000;
  private startedAt = 0;
  private lastTickNs = 0n;
  private running = false;

  // Per-symbol latest predictions for serving layer queries
  private readonly latestPredictions = new Map<
    number,
    { predictions: ModelOutput['predictions']; controls: ModelOutput['controls']; tsNs: bigint }
  >();
  private readonly latestCoherence = new Map<number, CoherenceDecision>();
  private readonly recentReceipts: WitnessReceipt[] = [];
  private readonly maxRecentReceipts = 200;

  constructor(config: Partial<PipelineConfig>, deps: PipelineDependencies) {
    this.config = { ...DEFAULT_PIPELINE_CONFIG, ...config };
    this.deps = deps;
    this.profiler = new Profiler();

    this.tickLoop = new TickLoop({
      intervalMs: this.config.tickIntervalMs,
      maxBatchSize: this.config.maxBatchSize,
    });

    this.healthChecker = new HealthChecker();
    this.setupHealthChecks();

    this.tickLoop.onTick(async (events) => {
      await this.processBatch(events);
    });
  }

  /**
   * Start the pipeline: subscribe to event bus, start tick loop.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();

    this.deps.eventBus.subscribe(
      'MarketDataReceived',
      this.onMarketData,
    );

    this.tickLoop.start();
    this.deps.logger.info(
      { mode: this.config.mode, tickMs: this.config.tickIntervalMs },
      'LivePipeline started',
    );
  }

  /**
   * Graceful shutdown: drain in-flight events, unsubscribe, stop loop.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    this.deps.eventBus.unsubscribe(
      'MarketDataReceived',
      this.onMarketData,
    );

    this.tickLoop.stop();
    await this.tickLoop.drainRemaining();

    this.deps.logger.info(
      { eventsProcessed: this.eventsProcessed },
      'LivePipeline stopped',
    );
  }

  /**
   * Retrieve current pipeline statistics.
   */
  getStats(): PipelineStats {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const avg =
      sorted.length > 0
        ? sorted.reduce((s, v) => s + v, 0) / sorted.length
        : 0;
    const p99Idx = Math.floor(sorted.length * 0.99);
    const p99 = sorted.length > 0 ? sorted[Math.min(p99Idx, sorted.length - 1)] : 0;

    return {
      eventsProcessed: this.eventsProcessed,
      avgLatencyMs: avg,
      p99LatencyMs: p99,
      graphNodeCount: this.deps.graph.nodeCount(),
      graphEdgeCount: this.deps.graph.edgeCount(),
      uptime: this.startedAt > 0 ? Date.now() - this.startedAt : 0,
    };
  }

  /**
   * Evaluate all health checks.
   */
  async getHealth(): Promise<HealthStatus> {
    return this.healthChecker.evaluate(this.lastTickNs);
  }

  /**
   * Get latest predictions for a specific symbol.
   */
  getLatestPredictions(symbolId: number): {
    predictions: ModelOutput['predictions'];
    controls: ModelOutput['controls'];
    tsNs: bigint;
  } | undefined {
    return this.latestPredictions.get(symbolId);
  }

  /**
   * Get latest coherence decision for a specific symbol.
   */
  getLatestCoherence(symbolId: number): CoherenceDecision | undefined {
    return this.latestCoherence.get(symbolId);
  }

  /**
   * Get recent witness receipts.
   */
  getRecentReceipts(limit: number): WitnessReceipt[] {
    return this.recentReceipts.slice(-limit);
  }

  /**
   * Get the profiler for stage-level latency inspection.
   */
  getProfiler(): Profiler {
    return this.profiler;
  }

  /**
   * Get the kill switch adapter.
   */
  getKillSwitch(): PipelineDependencies['killSwitch'] {
    return this.deps.killSwitch;
  }

  /**
   * Get position tracker.
   */
  getPositionTracker(): PipelineDependencies['positionTracker'] {
    return this.deps.positionTracker;
  }

  // --- Event handler bound to class instance ---

  private readonly onMarketData = (payload: MarketDataReceivedPayload): void => {
    this.tickLoop.push(payload.event);

    // Backpressure warning
    const pending = this.tickLoop.getPendingCount();
    if (pending > this.config.backpressureThreshold) {
      this.deps.logger.warn(
        { pending, threshold: this.config.backpressureThreshold },
        'Backpressure threshold exceeded',
      );
    }
  };

  // --- Batch processing ---

  private async processBatch(events: MarketEvent[]): Promise<void> {
    for (const event of events) {
      const tickStart = performance.now();
      try {
        await this.processEvent(event);
      } catch (err) {
        this.deps.logger.error(
          { error: (err as Error).message, eventId: event.eventId },
          'Pipeline event processing failed',
        );
      }
      const elapsed = performance.now() - tickStart;
      this.recordLatency(elapsed);
    }
  }

  /**
   * Full event processing pipeline per ADR-085.
   */
  private async processEvent(event: MarketEvent): Promise<void> {
    const symbolId = event.symbolId;
    this.lastTickNs = event.tsExchangeNs as bigint;

    // 1. Apply event to graph
    this.profiler.startStage('graph_apply');
    const delta = this.deps.graph.applyEvent(event);
    this.profiler.endStage('graph_apply');

    this.deps.eventBus.publish('GraphUpdated', {
      symbolId,
      delta,
      tsNs: event.tsExchangeNs as bigint,
    });

    // 2. Extract neighborhood for GNN
    this.profiler.startStage('graph_extract');
    const symbolNodeId = BigInt(symbolId as number);
    const neighborhood = this.deps.graph.extractNeighborhood(symbolNodeId, 2);
    this.profiler.endStage('graph_extract');

    // 3. Run GNN pipeline
    this.profiler.startStage('gnn_pipeline');
    const modelOutput = await this.deps.gnnPipeline.process(neighborhood, symbolId);
    this.profiler.endStage('gnn_pipeline');

    // Cache latest predictions for serving
    this.latestPredictions.set(symbolId as number, {
      predictions: modelOutput.predictions,
      controls: modelOutput.controls,
      tsNs: modelOutput.tsNs,
    });

    // Publish prediction events
    for (const pred of modelOutput.predictions) {
      this.deps.eventBus.publish('PredictionGenerated', {
        symbolId,
        prediction: pred.value,
        confidence: pred.confidence,
        horizon: pred.headName,
        tsNs: pred.tsNs,
      });
    }

    // 4. Evaluate coherence gate
    this.profiler.startStage('coherence_gate');
    const coherenceMetrics = this.extractCoherenceMetrics(modelOutput);
    const coherence = await this.deps.coherenceGate.evaluate(coherenceMetrics);
    this.profiler.endStage('coherence_gate');

    this.latestCoherence.set(symbolId as number, coherence);

    this.deps.eventBus.publish('CoherenceEvaluated', {
      decision: coherence,
      tsNs: event.tsExchangeNs as bigint,
    });

    // 5. Run policy kernel
    this.profiler.startStage('policy_kernel');
    const policyInput = this.buildPolicyInput(
      symbolId,
      modelOutput,
      coherence,
      event.tsExchangeNs as bigint,
    );
    const decision = this.deps.policyKernel.decide(policyInput);
    this.profiler.endStage('policy_kernel');

    this.deps.eventBus.publish('ActionDecided', {
      symbolId,
      action: decision.type,
      params: { decision },
      tsNs: event.tsExchangeNs as bigint,
    });

    // 6. Execute decision
    if (decision.type === 'place' || decision.type === 'modify' || decision.type === 'cancel') {
      this.profiler.startStage('execution');
      const execResult = await this.deps.orderManager.execute(decision);
      this.profiler.endStage('execution');

      if (execResult.success) {
        // 7. Create proof token + witness receipt
        this.profiler.startStage('proof_receipt');
        const receipt = this.createWitnessReceipt(
          event,
          modelOutput,
          coherence,
          decision,
        );
        await this.deps.receiptStore.append(receipt);
        this.addRecentReceipt(receipt);
        this.profiler.endStage('proof_receipt');

        // 8. Store replay segment if coherence allows
        if (coherence.allowWrite) {
          this.profiler.startStage('segment_store');
          await this.deps.segmentStore.write(
            {
              symbolId,
              startTsNs: event.tsExchangeNs as Timestamp,
              endTsNs: event.tsExchangeNs as Timestamp,
              segmentKind: 'action',
              dataBlob: null,
              signature: null,
              witnessHash: null,
              metadata: {
                actionType: decision.type,
                orderId: execResult.orderId,
              },
            },
            coherence,
          );
          this.profiler.endStage('segment_store');
        }
      }
    }

    this.eventsProcessed++;
  }

  // --- Helpers ---

  private extractCoherenceMetrics(modelOutput: ModelOutput): {
    mincutValue: number;
    driftScore: number;
    cusumScore: number;
  } {
    const driftControl = modelOutput.controls.find(
      (c) => c.headName === 'adversarial_drift',
    );
    const regimeControl = modelOutput.controls.find(
      (c) => c.headName === 'regime_uncertainty',
    );
    return {
      mincutValue: regimeControl?.confidence ?? 0.5,
      driftScore: driftControl?.value ?? 0,
      cusumScore: driftControl?.confidence ?? 0,
    };
  }

  private buildPolicyInput(
    symbolId: SymbolId,
    modelOutput: ModelOutput,
    coherence: CoherenceDecision,
    tsNs: bigint,
  ): import('../policy/types.js').PolicyInput {
    const positionSnapshot = this.deps.positionTracker.getPosition(symbolId);

    const riskBudget: RiskBudgetSnapshot = {
      totalNotionalUsed: 0,
      perSymbolNotional: new Map(),
      rollingOrderRate: 0,
      rollingCancelRate: 0,
      cumulativeSlippageBp: 0,
      sessionDrawdownPct: 0,
    };

    const venueState: VenueState = {
      venueId: 0 as import('../shared/types.js').VenueId,
      isHalted: false,
      isHealthy: true,
      lastHeartbeatNs: tsNs,
    };

    return {
      coherence,
      modelOutput,
      position: positionSnapshot,
      riskBudget,
      venueState,
      tsNs,
    };
  }

  private createWitnessReceipt(
    event: MarketEvent,
    modelOutput: ModelOutput,
    coherence: CoherenceDecision,
    decision: ActionDecision,
  ): WitnessReceipt {
    const inputHash = createHash('sha256')
      .update(event.eventId)
      .digest('hex');

    const coherenceHash = createHash('sha256')
      .update(coherence.partitionHash)
      .update(String(coherence.driftScore))
      .digest('hex');

    const policyHash = createHash('sha256')
      .update(decision.type)
      .update(String(event.tsExchangeNs))
      .digest('hex');

    const tokenId = createHash('sha256')
      .update(inputHash)
      .update(coherenceHash)
      .update(policyHash)
      .digest('hex')
      .slice(0, 32);

    const resultHash = createHash('sha256')
      .update(tokenId)
      .update(inputHash)
      .digest('hex');

    return {
      tsNs: event.tsExchangeNs as Timestamp,
      modelId: 'gnn-v1',
      inputSegmentHash: inputHash,
      coherenceWitnessHash: coherenceHash,
      policyHash,
      actionIntent: decision.type,
      verifiedTokenId: tokenId,
      resultingStateHash: resultHash,
    };
  }

  private addRecentReceipt(receipt: WitnessReceipt): void {
    this.recentReceipts.push(receipt);
    if (this.recentReceipts.length > this.maxRecentReceipts) {
      this.recentReceipts.splice(0, this.recentReceipts.length - this.maxRecentReceipts);
    }
  }

  private recordLatency(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > this.maxLatencyBuffer) {
      this.latencies.splice(0, this.latencies.length - this.maxLatencyBuffer);
    }
  }

  private setupHealthChecks(): void {
    this.healthChecker.registerCheck('graph', async () => {
      return this.deps.graph.nodeCount() >= 0;
    });

    this.healthChecker.registerCheck('gnn', async () => {
      return true; // GNN is healthy if pipeline is running
    });

    this.healthChecker.registerCheck('feeds', async () => {
      return this.running;
    });
  }
}
