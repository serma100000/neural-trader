import type { VerifiedToken, SymbolId, VenueId, Side } from '../shared/types.js';
import type { OrderIntent, ModifyIntent, CancelIntent } from '../policy/types.js';
import type { BrokerAdapter } from './broker-adapter.js';
import type { FillReport, OpenOrder, PaperAdapterConfig } from './types.js';
import { DEFAULT_PAPER_CONFIG } from './types.js';

interface InternalOrder {
  orderId: string;
  symbolId: SymbolId;
  venueId: VenueId;
  side: Side;
  priceFp: bigint;
  qtyFp: bigint;
  filledQtyFp: bigint;
  status: 'pending' | 'open' | 'partial' | 'filled' | 'cancelled';
  createdAtNs: bigint;
  tokenId: string;
  orderType: 'limit' | 'marketable_limit' | 'ioc';
}

/**
 * Paper trading broker adapter that simulates exchange behavior.
 * Supports configurable latency, partial fills, and slippage.
 */
export class PaperBrokerAdapter implements BrokerAdapter {
  private readonly config: PaperAdapterConfig;
  private readonly orders = new Map<string, InternalOrder>();
  private readonly pendingFills: FillReport[] = [];
  private readonly positions = new Map<SymbolId, bigint>(); // net qty per symbol
  private orderCounter = 0;
  private rngState: number;

  constructor(config: Partial<PaperAdapterConfig> = {}) {
    this.config = { ...DEFAULT_PAPER_CONFIG, ...config };
    this.rngState = this.config.seed ?? Math.floor(Math.random() * 2147483647);
  }

  async submitOrder(intent: OrderIntent, token: VerifiedToken): Promise<string> {
    const orderId = `paper-${++this.orderCounter}`;
    const nowNs = BigInt(Date.now()) * 1_000_000n;

    const order: InternalOrder = {
      orderId,
      symbolId: intent.symbolId,
      venueId: intent.venueId,
      side: intent.side,
      priceFp: intent.priceFp,
      qtyFp: intent.qtyFp,
      filledQtyFp: 0n,
      status: 'pending',
      createdAtNs: nowNs,
      tokenId: token.tokenId,
      orderType: intent.orderType,
    };

    this.orders.set(orderId, order);

    // Simulate async fill processing
    await this.simulateLatency();

    if (this.isMarketable(intent)) {
      this.executeFill(order);
    } else if (intent.orderType === 'ioc') {
      // IOC non-marketable -> reject
      order.status = 'cancelled';
      this.pendingFills.push({
        type: 'rejected',
        reason: 'IOC order not marketable',
        tsNs: BigInt(Date.now()) * 1_000_000n,
      });
    } else {
      order.status = 'open';
    }

    return orderId;
  }

  async modifyOrder(intent: ModifyIntent, token: VerifiedToken): Promise<void> {
    const order = this.findOrderByHash(intent.orderIdHash);
    if (!order) {
      throw new Error(`Order not found for hash: ${intent.orderIdHash}`);
    }
    if (order.status === 'filled' || order.status === 'cancelled') {
      throw new Error(`Cannot modify order in status: ${order.status}`);
    }

    await this.simulateLatency();

    if (intent.newPriceFp !== undefined) {
      order.priceFp = intent.newPriceFp;
    }
    if (intent.newQtyFp !== undefined) {
      if (intent.newQtyFp <= order.filledQtyFp) {
        throw new Error('New quantity must exceed already filled quantity');
      }
      order.qtyFp = intent.newQtyFp;
    }
  }

  async cancelOrder(intent: CancelIntent, token: VerifiedToken): Promise<void> {
    const order = this.findOrderByHash(intent.orderIdHash);
    if (!order) {
      throw new Error(`Order not found for hash: ${intent.orderIdHash}`);
    }
    if (order.status === 'filled' || order.status === 'cancelled') {
      return; // Already terminal, no-op
    }

    await this.simulateLatency();

    order.status = 'cancelled';
    this.pendingFills.push({
      type: 'cancelled',
      tsNs: BigInt(Date.now()) * 1_000_000n,
    });
  }

  async flattenAll(reason: string, token: VerifiedToken): Promise<void> {
    await this.simulateLatency();

    // Cancel all open orders
    for (const order of this.orders.values()) {
      if (order.status === 'open' || order.status === 'partial' || order.status === 'pending') {
        order.status = 'cancelled';
        this.pendingFills.push({
          type: 'cancelled',
          tsNs: BigInt(Date.now()) * 1_000_000n,
        });
      }
    }

    // Close all open positions with market orders
    for (const [symbolId, netQty] of this.positions.entries()) {
      if (netQty === 0n) continue;
      const closeSide: Side = netQty > 0n ? (1 as Side) : (0 as Side); // sell if long, buy if short
      const closeQty = netQty < 0n ? -netQty : netQty;

      // Simulate a closing fill at current "market" price (use 0 slippage for flatten)
      const fillPrice = this.applySlippage(0n, closeSide);
      this.positions.set(symbolId, 0n);

      this.pendingFills.push({
        type: 'filled',
        fillPriceFp: fillPrice,
        fillQtyFp: closeQty,
        tsNs: BigInt(Date.now()) * 1_000_000n,
      });
    }
  }

  async pollFills(): Promise<FillReport[]> {
    const fills = [...this.pendingFills];
    this.pendingFills.length = 0;
    return fills;
  }

  getOpenOrders(): OpenOrder[] {
    const result: OpenOrder[] = [];
    for (const order of this.orders.values()) {
      if (order.status === 'open' || order.status === 'partial' || order.status === 'pending') {
        result.push({
          orderId: order.orderId,
          symbolId: order.symbolId,
          venueId: order.venueId,
          side: order.side,
          priceFp: order.priceFp,
          qtyFp: order.qtyFp,
          filledQtyFp: order.filledQtyFp,
          status: order.status,
          createdAtNs: order.createdAtNs,
          tokenId: order.tokenId,
        });
      }
    }
    return result;
  }

  /** Expose position map for testing and flattenAll */
  getPositions(): Map<SymbolId, bigint> {
    return new Map(this.positions);
  }

  /** Manually set a position for testing flattenAll */
  setPosition(symbolId: SymbolId, netQtyFp: bigint): void {
    this.positions.set(symbolId, netQtyFp);
  }

  // --- Private helpers ---

  private executeFill(order: InternalOrder): void {
    const remainingQty = order.qtyFp - order.filledQtyFp;
    const fillPrice = this.applySlippage(order.priceFp, order.side);
    const isPartial = this.nextRandom() < this.config.partialFillProbability;

    if (isPartial && remainingQty > 1n) {
      // Fill between 30% and 70% of remaining
      const fraction = 0.3 + this.nextRandom() * 0.4;
      const fillQty = BigInt(Math.max(1, Math.floor(Number(remainingQty) * fraction)));
      const leftover = remainingQty - fillQty;

      order.filledQtyFp += fillQty;
      order.status = 'partial';

      this.updatePosition(order.symbolId, order.side, fillQty);

      this.pendingFills.push({
        type: 'partial_fill',
        fillPriceFp: fillPrice,
        fillQtyFp: fillQty,
        remainingQtyFp: leftover,
        tsNs: BigInt(Date.now()) * 1_000_000n,
      });
    } else {
      order.filledQtyFp = order.qtyFp;
      order.status = 'filled';

      this.updatePosition(order.symbolId, order.side, remainingQty);

      this.pendingFills.push({
        type: 'filled',
        fillPriceFp: fillPrice,
        fillQtyFp: remainingQty,
        tsNs: BigInt(Date.now()) * 1_000_000n,
      });
    }
  }

  private updatePosition(symbolId: SymbolId, side: Side, qty: bigint): void {
    const current = this.positions.get(symbolId) ?? 0n;
    const signedQty = side === 0 ? qty : -qty; // Bid=buy=+, Ask=sell=-
    this.positions.set(symbolId, current + signedQty);
  }

  private isMarketable(intent: OrderIntent): boolean {
    // In paper trading, marketable_limit and ioc are immediately fillable
    // Regular limits are queued (simplified: always queue limits)
    return intent.orderType === 'marketable_limit' || intent.orderType === 'ioc';
  }

  private applySlippage(priceFp: bigint, side: Side): bigint {
    const slippageBp = this.boxMullerNormal() * this.config.slippageStdBp + this.config.slippageMeanBp;
    // Slippage is adverse: buys pay more, sells receive less
    const direction = side === 0 ? 1n : -1n; // Bid=0 -> adverse is up
    const slippageFp = BigInt(Math.round(Number(priceFp) * slippageBp / 10000));
    return priceFp + direction * slippageFp;
  }

  /** Box-Muller transform for normally distributed random values */
  private boxMullerNormal(): number {
    const u1 = this.nextRandom();
    const u2 = this.nextRandom();
    // Clamp u1 away from 0 to avoid log(0)
    const safeU1 = Math.max(u1, 1e-10);
    return Math.sqrt(-2 * Math.log(safeU1)) * Math.cos(2 * Math.PI * u2);
  }

  /** Seeded PRNG (xorshift32) for deterministic testing */
  private nextRandom(): number {
    let x = this.rngState;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    this.rngState = x;
    return Math.abs(x) / 2147483647;
  }

  private findOrderByHash(orderIdHash: string): InternalOrder | undefined {
    // Match by orderId directly (in paper mode, orderIdHash is the orderId)
    const direct = this.orders.get(orderIdHash);
    if (direct) return direct;

    // Also search by iterating (in case hash is a different key)
    for (const order of this.orders.values()) {
      if (order.orderId === orderIdHash) return order;
    }
    return undefined;
  }

  private async simulateLatency(): Promise<void> {
    if (this.config.fillLatencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.fillLatencyMs));
    }
  }
}
