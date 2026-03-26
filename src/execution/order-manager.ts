import type { VerifiedToken, SymbolId, Side } from '../shared/types.js';
import type { ActionDecision } from '../policy/types.js';
import type { BrokerAdapter } from './broker-adapter.js';
import type { FillReport, OpenOrder, ExecutionStats } from './types.js';
import type { PositionTracker } from '../risk/position-tracker.js';
import type {
  DomainEventBus,
  OrderFilledPayload,
  PositionChangedPayload,
} from '../shared/event-bus.js';

/**
 * Manages order execution by routing ActionDecisions to the broker adapter,
 * processing fills, updating positions, and publishing domain events.
 */
export class OrderManager {
  private readonly adapter: BrokerAdapter;
  private readonly positionTracker: PositionTracker;
  private readonly eventBus: DomainEventBus;

  // Stats tracking
  private statsData: ExecutionStats = {
    totalOrders: 0,
    totalFills: 0,
    totalCancels: 0,
    avgFillLatencyMs: 0,
    totalSlippageBp: 0,
  };
  private totalFillLatencyMs = 0;

  // Track order metadata for fill processing
  private readonly orderMeta = new Map<
    string,
    { symbolId: SymbolId; venueId: number; side: Side; submittedAtMs: number; priceFp: bigint }
  >();

  constructor(
    adapter: BrokerAdapter,
    positionTracker: PositionTracker,
    eventBus: DomainEventBus,
  ) {
    this.adapter = adapter;
    this.positionTracker = positionTracker;
    this.eventBus = eventBus;
  }

  /**
   * Route an ActionDecision to the appropriate adapter method.
   */
  async execute(decision: ActionDecision, token: VerifiedToken): Promise<void> {
    switch (decision.type) {
      case 'place': {
        const orderId = await this.adapter.submitOrder(decision.intent, token);
        this.orderMeta.set(orderId, {
          symbolId: decision.intent.symbolId,
          venueId: decision.intent.venueId as number,
          side: decision.intent.side,
          submittedAtMs: Date.now(),
          priceFp: decision.intent.priceFp,
        });
        this.statsData.totalOrders++;
        break;
      }
      case 'modify': {
        await this.adapter.modifyOrder(decision.intent, token);
        break;
      }
      case 'cancel': {
        await this.adapter.cancelOrder(decision.intent, token);
        this.statsData.totalCancels++;
        break;
      }
      case 'hold': {
        // No action needed for hold
        break;
      }
      case 'throttle': {
        // No action; caller is responsible for scheduling resume
        break;
      }
      case 'emergency_flatten': {
        await this.adapter.flattenAll(decision.reason, token);
        this.statsData.totalCancels += this.adapter.getOpenOrders().length;
        break;
      }
    }
  }

  /**
   * Poll the adapter for new fills and process them.
   * Updates positions and publishes domain events.
   */
  async processFills(): Promise<FillReport[]> {
    const fills = await this.adapter.pollFills();

    for (const fill of fills) {
      if (fill.type === 'filled' || fill.type === 'partial_fill') {
        this.statsData.totalFills++;
        this.processOneFill(fill);
      }
      if (fill.type === 'cancelled') {
        this.statsData.totalCancels++;
      }
    }

    return fills;
  }

  /**
   * Return a snapshot of all currently open orders.
   */
  getOpenOrders(): OpenOrder[] {
    return this.adapter.getOpenOrders();
  }

  /**
   * Return current execution statistics.
   */
  getStats(): ExecutionStats {
    return {
      ...this.statsData,
      avgFillLatencyMs:
        this.statsData.totalFills > 0
          ? this.totalFillLatencyMs / this.statsData.totalFills
          : 0,
    };
  }

  /**
   * Cancel all open orders and flatten all positions.
   */
  async cancelAll(reason: string, token: VerifiedToken): Promise<void> {
    await this.adapter.flattenAll(reason, token);
  }

  // --- Private helpers ---

  private processOneFill(
    fill: Extract<FillReport, { type: 'filled' } | { type: 'partial_fill' }>,
  ): void {
    // Find which order this fill belongs to by matching the most recent open order
    // In a real system, fills would carry an orderId. Here we match by recency.
    const meta = this.findBestOrderMeta();

    if (meta) {
      const { symbolId, venueId, side, submittedAtMs, priceFp } = meta;

      // Calculate fill latency
      const fillLatencyMs = Date.now() - submittedAtMs;
      this.totalFillLatencyMs += fillLatencyMs;

      // Calculate slippage in basis points
      if (priceFp > 0n) {
        const slippageBp =
          Math.abs(Number(fill.fillPriceFp - priceFp)) /
          Number(priceFp) *
          10000;
        this.statsData.totalSlippageBp += slippageBp;
      }

      // Get previous position for event
      const previousQty = this.positionTracker.getNetQty(symbolId);

      // Update position tracker
      this.positionTracker.applyFill(
        symbolId,
        side,
        fill.fillPriceFp,
        fill.fillQtyFp,
        fill.tsNs,
      );

      const currentQty = this.positionTracker.getNetQty(symbolId);

      // Publish OrderFilled event
      const orderFilledPayload: OrderFilledPayload = {
        orderId: meta.key ?? 'unknown',
        symbolId,
        venueId: venueId as SymbolId & { readonly __brand: 'VenueId' },
        fillPrice: fill.fillPriceFp,
        fillQty: fill.fillQtyFp,
        tsNs: fill.tsNs,
      };
      this.eventBus.publish('OrderFilled', orderFilledPayload);

      // Publish PositionChanged event
      const positionChangedPayload: PositionChangedPayload = {
        symbolId,
        previousQty,
        currentQty,
        avgPrice: this.positionTracker.getPosition(symbolId)?.avgEntryPriceFp ?? 0n,
        tsNs: fill.tsNs,
      };
      this.eventBus.publish('PositionChanged', positionChangedPayload);

      // Remove if fully filled
      if (fill.type === 'filled' && meta.key) {
        this.orderMeta.delete(meta.key);
      }
    }
  }

  private findBestOrderMeta(): {
    symbolId: SymbolId;
    venueId: number;
    side: Side;
    submittedAtMs: number;
    priceFp: bigint;
    key?: string;
  } | undefined {
    // Return the earliest submitted order (FIFO matching)
    let best: { key: string; submittedAtMs: number } | undefined;
    for (const [key, val] of this.orderMeta.entries()) {
      if (!best || val.submittedAtMs < best.submittedAtMs) {
        best = { key, submittedAtMs: val.submittedAtMs };
      }
    }
    if (!best) return undefined;
    const meta = this.orderMeta.get(best.key)!;
    return { ...meta, key: best.key };
  }
}
