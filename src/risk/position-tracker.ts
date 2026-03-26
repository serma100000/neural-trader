import { createHash } from 'node:crypto';
import type { SymbolId, Side } from '../shared/types.js';
import type { PositionSnapshot } from '../policy/types.js';

// Fixed-point scale: 1_000_000 = 1.0
const FP_SCALE = BigInt(1_000_000);

/**
 * Internal mutable position state.
 */
interface MutablePosition {
  symbolId: SymbolId;
  netQtyFp: bigint;
  avgEntryPriceFp: bigint;
  realizedPnlFp: bigint;
  openOrderCount: number;
  lastFillTsNs: bigint;
}

function absBI(val: bigint): bigint {
  return val < 0n ? -val : val;
}

/**
 * Tracks positions across symbols, computing PnL and average entry prices.
 *
 * Uses fixed-point arithmetic with a scale factor of 1,000,000.
 * Buy (Bid=0) increases position, Sell (Ask=1) decreases position.
 */
export class PositionTracker {
  private readonly positions = new Map<SymbolId, MutablePosition>();

  /**
   * Apply a fill to the position tracker.
   *
   * @param symbolId - The symbol that was filled
   * @param side - Bid (0) = buy, Ask (1) = sell
   * @param priceFp - Fill price in fixed-point
   * @param qtyFp - Fill quantity in fixed-point (always positive)
   * @param tsNs - Timestamp in nanoseconds (optional, defaults to 0)
   */
  applyFill(
    symbolId: SymbolId,
    side: Side,
    priceFp: bigint,
    qtyFp: bigint,
    tsNs: bigint = 0n,
  ): void {
    let pos = this.positions.get(symbolId);
    if (!pos) {
      pos = {
        symbolId,
        netQtyFp: 0n,
        avgEntryPriceFp: 0n,
        realizedPnlFp: 0n,
        openOrderCount: 0,
        lastFillTsNs: 0n,
      };
      this.positions.set(symbolId, pos);
    }

    pos.lastFillTsNs = tsNs;

    // Side.Bid = 0 means buy (increase position)
    // Side.Ask = 1 means sell (decrease position)
    const isBuy = side === 0;
    const signedQty = isBuy ? qtyFp : -qtyFp;
    const prevNet = pos.netQtyFp;

    if (isBuy) {
      this.handleBuy(pos, priceFp, qtyFp);
    } else {
      this.handleSell(pos, priceFp, qtyFp);
    }

    pos.netQtyFp = prevNet + signedQty;

    // Reset avg if flat
    if (pos.netQtyFp === 0n) {
      pos.avgEntryPriceFp = 0n;
    }
  }

  /**
   * Get a snapshot of the position for a given symbol.
   * Returns a zero-position if no fills have been recorded.
   */
  getPosition(symbolId: SymbolId): PositionSnapshot {
    const pos = this.positions.get(symbolId);
    if (!pos) {
      return {
        symbolId,
        netQtyFp: 0n,
        avgEntryPriceFp: 0n,
        realizedPnlFp: 0n,
        unrealizedPnlFp: 0n,
        openOrderCount: 0,
        lastFillTsNs: 0n,
      };
    }

    return {
      symbolId: pos.symbolId,
      netQtyFp: pos.netQtyFp,
      avgEntryPriceFp: pos.avgEntryPriceFp,
      realizedPnlFp: pos.realizedPnlFp,
      unrealizedPnlFp: 0n, // Requires mark price; set by caller
      openOrderCount: pos.openOrderCount,
      lastFillTsNs: pos.lastFillTsNs,
    };
  }

  /**
   * Get all tracked positions.
   */
  getAllPositions(): Map<SymbolId, PositionSnapshot> {
    const result = new Map<SymbolId, PositionSnapshot>();
    for (const [symbolId] of this.positions) {
      result.set(symbolId, this.getPosition(symbolId));
    }
    return result;
  }

  /**
   * Get total notional across all positions using mid prices.
   */
  getTotalNotional(midPrices: Map<SymbolId, number>): number {
    let total = 0;
    for (const [symbolId, pos] of this.positions) {
      const midPrice = midPrices.get(symbolId) ?? 0;
      const absQty = absBI(pos.netQtyFp);
      const qty = Number(absQty) / Number(FP_SCALE);
      total += qty * midPrice;
    }
    return total;
  }

  /**
   * Compute a SHA-256 hash of all position states for witness receipts.
   */
  getStateHash(): string {
    const hash = createHash('sha256');
    const sortedIds = [...this.positions.keys()].sort((a, b) => a - b);

    for (const symbolId of sortedIds) {
      const pos = this.positions.get(symbolId)!;
      hash.update(
        `${symbolId}:${pos.netQtyFp.toString()}:${pos.avgEntryPriceFp.toString()}:${pos.realizedPnlFp.toString()}`,
      );
    }

    return hash.digest('hex');
  }

  /**
   * Get net quantity for a symbol (backward-compatible convenience method).
   */
  getNetQty(symbolId: SymbolId): bigint {
    return this.positions.get(symbolId)?.netQtyFp ?? 0n;
  }

  /**
   * Get all positions as an array (backward-compatible convenience method).
   */
  getAllPositionsArray(): PositionSnapshot[] {
    return Array.from(this.getAllPositions().values());
  }

  /**
   * Handle a buy fill: increase position, update average entry price.
   */
  private handleBuy(
    pos: MutablePosition,
    priceFp: bigint,
    qtyFp: bigint,
  ): void {
    if (pos.netQtyFp >= 0n) {
      // Adding to long position -- update weighted average entry price
      const existingCost = pos.avgEntryPriceFp * pos.netQtyFp;
      const newCost = priceFp * qtyFp;
      const totalQty = pos.netQtyFp + qtyFp;
      if (totalQty > 0n) {
        pos.avgEntryPriceFp = (existingCost + newCost) / totalQty;
      }
    } else {
      // Covering short position -- realize PnL
      const absNet = absBI(pos.netQtyFp);
      const coverQty = qtyFp < absNet ? qtyFp : absNet;
      // PnL for short cover: (entry - exit) * qty / FP_SCALE
      const pnl =
        ((pos.avgEntryPriceFp - priceFp) * coverQty) / FP_SCALE;
      pos.realizedPnlFp += pnl;

      // If we're crossing zero (flipping to long), set new entry price
      const remainingBuy = qtyFp - coverQty;
      if (remainingBuy > 0n) {
        pos.avgEntryPriceFp = priceFp;
      }
    }
  }

  /**
   * Handle a sell fill: decrease position, realize PnL if closing longs.
   */
  private handleSell(
    pos: MutablePosition,
    priceFp: bigint,
    qtyFp: bigint,
  ): void {
    if (pos.netQtyFp <= 0n) {
      // Adding to short position -- update weighted average entry price
      const absExisting = absBI(pos.netQtyFp);
      const existingCost = pos.avgEntryPriceFp * absExisting;
      const newCost = priceFp * qtyFp;
      const totalQty = absExisting + qtyFp;
      if (totalQty > 0n) {
        pos.avgEntryPriceFp = (existingCost + newCost) / totalQty;
      }
    } else {
      // Closing long position -- realize PnL
      const closeQty = qtyFp < pos.netQtyFp ? qtyFp : pos.netQtyFp;
      // PnL for long close: (exit - entry) * qty / FP_SCALE
      const pnl =
        ((priceFp - pos.avgEntryPriceFp) * closeQty) / FP_SCALE;
      pos.realizedPnlFp += pnl;

      // If we're crossing zero (flipping to short), set new entry price
      const remainingSell = qtyFp - closeQty;
      if (remainingSell > 0n) {
        pos.avgEntryPriceFp = priceFp;
      }
    }
  }
}
