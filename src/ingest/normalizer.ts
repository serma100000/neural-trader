import { createHash } from 'node:crypto';
import type { MarketEvent, SymbolId, VenueId, Timestamp, PriceFp, QtyFp, EventId } from '../shared/types.js';
import { EventType, Side } from '../shared/types.js';
import type { Logger } from '../shared/logger.js';
import type { RawFrame, BinanceDepthUpdate, BinanceTrade, NormalizationResult } from './types.js';
import { PRICE_SCALE, QTY_SCALE } from './types.js';

/**
 * Normalizes raw venue frames into typed MarketEvent objects.
 * Handles Binance depth updates and trades, converting prices
 * and quantities to fixed-point i64 representation.
 */
export class Normalizer {
  private seq = 0n;

  constructor(
    private readonly symbolResolver: (venue: string, symbol: string) => SymbolId | undefined,
    private readonly logger: Logger,
  ) {}

  /**
   * Normalize a RawFrame into one or more MarketEvents.
   * Depth updates produce multiple events (one per price level).
   * Trades produce a single event.
   */
  normalize(frame: RawFrame): MarketEvent[] {
    const data = frame.data as Record<string, unknown>;
    if (!data || typeof data !== 'object') {
      this.logger.warn({ venueId: frame.venueId }, 'Malformed frame: not an object');
      return [];
    }

    const eventType = data['e'] as string | undefined;
    if (!eventType) {
      // Might be a subscription confirmation or ping
      return [];
    }

    switch (eventType) {
      case 'depthUpdate':
        return this.normalizeDepthUpdate(frame, data as unknown as BinanceDepthUpdate);
      case 'trade':
        return this.normalizeTrade(frame, data as unknown as BinanceTrade);
      default:
        this.logger.debug({ eventType, venueId: frame.venueId }, 'Unknown event type, skipping');
        return [];
    }
  }

  /** Reset internal sequence counter (e.g., on reconnect) */
  resetSequence(): void {
    this.seq = 0n;
  }

  private normalizeDepthUpdate(frame: RawFrame, msg: BinanceDepthUpdate): MarketEvent[] {
    const result = this.validateDepthUpdate(msg);
    if (!result.valid) {
      this.logger.warn({ reason: result.reason, venueId: frame.venueId }, 'Invalid depth update');
      return [];
    }

    const symbolId = this.resolveSymbol(frame.venueId, msg.s);
    if (symbolId === undefined) {
      this.logger.warn({ symbol: msg.s, venueId: frame.venueId }, 'Unknown symbol');
      return [];
    }

    const tsExchangeNs = BigInt(msg.E) * 1_000_000n as Timestamp;
    const events: MarketEvent[] = [];

    // Process bid updates
    for (const [priceStr, qtyStr] of msg.b) {
      const event = this.createBookEvent(
        frame, symbolId, tsExchangeNs, Side.Bid, priceStr, qtyStr,
      );
      if (event) events.push(event);
    }

    // Process ask updates
    for (const [priceStr, qtyStr] of msg.a) {
      const event = this.createBookEvent(
        frame, symbolId, tsExchangeNs, Side.Ask, priceStr, qtyStr,
      );
      if (event) events.push(event);
    }

    return events;
  }

  private normalizeTrade(frame: RawFrame, msg: BinanceTrade): MarketEvent[] {
    const result = this.validateTrade(msg);
    if (!result.valid) {
      this.logger.warn({ reason: result.reason, venueId: frame.venueId }, 'Invalid trade');
      return [];
    }

    const symbolId = this.resolveSymbol(frame.venueId, msg.s);
    if (symbolId === undefined) {
      this.logger.warn({ symbol: msg.s, venueId: frame.venueId }, 'Unknown symbol');
      return [];
    }

    const tsExchangeNs = BigInt(msg.T) * 1_000_000n as Timestamp;
    const priceFp = stringToFixedPoint(msg.p, PRICE_SCALE);
    const qtyFp = stringToFixedPoint(msg.q, QTY_SCALE);

    if (priceFp === null || qtyFp === null) {
      this.logger.warn(
        { price: msg.p, qty: msg.q, venueId: frame.venueId },
        'Failed to convert trade price/qty to fixed point',
      );
      return [];
    }

    this.seq++;
    const eventId = generateEventId(
      frame.venueId, symbolId, this.seq, tsExchangeNs,
    );

    // Binance: m=true means buyer is market maker, so trade was a sell
    const side = msg.m ? Side.Ask : Side.Bid;

    return [{
      eventId,
      tsExchangeNs,
      tsIngestNs: BigInt(frame.receivedAtNs) as Timestamp,
      venueId: frame.venueId,
      symbolId,
      eventType: EventType.Trade,
      side,
      priceFp: priceFp as PriceFp,
      qtyFp: qtyFp as QtyFp,
      flags: 0,
      seq: this.seq,
    }];
  }

  private createBookEvent(
    frame: RawFrame,
    symbolId: SymbolId,
    tsExchangeNs: Timestamp,
    side: Side,
    priceStr: string,
    qtyStr: string,
  ): MarketEvent | null {
    const priceFp = stringToFixedPoint(priceStr, PRICE_SCALE);
    const qtyFp = stringToFixedPoint(qtyStr, QTY_SCALE);

    if (priceFp === null || qtyFp === null) {
      this.logger.warn(
        { price: priceStr, qty: qtyStr },
        'Failed to convert book level to fixed point',
      );
      return null;
    }

    this.seq++;
    const eventId = generateEventId(
      frame.venueId, symbolId, this.seq, tsExchangeNs,
    );

    // qty=0 means level removed (cancel), otherwise it's a new/modify
    const eventType = qtyFp === 0n
      ? EventType.CancelOrder
      : EventType.ModifyOrder;

    return {
      eventId,
      tsExchangeNs,
      tsIngestNs: BigInt(frame.receivedAtNs) as Timestamp,
      venueId: frame.venueId,
      symbolId,
      eventType,
      side,
      priceFp: priceFp as PriceFp,
      qtyFp: qtyFp as QtyFp,
      flags: 0,
      seq: this.seq,
    };
  }

  private resolveSymbol(venueId: VenueId, symbol: string): SymbolId | undefined {
    return this.symbolResolver(String(venueId), symbol);
  }

  private validateDepthUpdate(msg: BinanceDepthUpdate): { valid: true } | { valid: false; reason: string } {
    if (msg.e !== 'depthUpdate') return { valid: false, reason: 'wrong event type' };
    if (typeof msg.E !== 'number') return { valid: false, reason: 'missing event time' };
    if (typeof msg.s !== 'string' || msg.s.length === 0) return { valid: false, reason: 'missing symbol' };
    if (!Array.isArray(msg.b)) return { valid: false, reason: 'missing bids array' };
    if (!Array.isArray(msg.a)) return { valid: false, reason: 'missing asks array' };
    return { valid: true };
  }

  private validateTrade(msg: BinanceTrade): { valid: true } | { valid: false; reason: string } {
    if (msg.e !== 'trade') return { valid: false, reason: 'wrong event type' };
    if (typeof msg.T !== 'number') return { valid: false, reason: 'missing trade time' };
    if (typeof msg.s !== 'string' || msg.s.length === 0) return { valid: false, reason: 'missing symbol' };
    if (typeof msg.p !== 'string') return { valid: false, reason: 'missing price' };
    if (typeof msg.q !== 'string') return { valid: false, reason: 'missing quantity' };
    if (typeof msg.m !== 'boolean') return { valid: false, reason: 'missing maker flag' };
    return { valid: true };
  }
}

/**
 * Convert a decimal string (e.g. "0.00123400") to fixed-point bigint.
 * Returns null if the string is not a valid number.
 */
export function stringToFixedPoint(value: string, scale: bigint): bigint | null {
  if (typeof value !== 'string' || value.length === 0) return null;

  const parts = value.split('.');
  if (parts.length > 2) return null;

  const intPart = parts[0]!;
  const fracPart = parts[1] ?? '';

  // Validate characters
  if (!/^-?\d+$/.test(intPart)) return null;
  if (fracPart.length > 0 && !/^\d+$/.test(fracPart)) return null;

  const scaleDigits = scale.toString().length - 1; // 1e8 -> 8 digits
  const paddedFrac = fracPart.padEnd(scaleDigits, '0').slice(0, scaleDigits);

  const negative = intPart.startsWith('-');
  const absInt = negative ? intPart.slice(1) : intPart;

  const result = BigInt(absInt) * scale + BigInt(paddedFrac);
  return negative ? -result : result;
}

/**
 * Generate a deterministic event ID as hex hash of
 * (venueId, symbolId, seq, tsExchangeNs).
 */
export function generateEventId(
  venueId: VenueId,
  symbolId: SymbolId,
  seq: bigint,
  tsExchangeNs: Timestamp,
): EventId {
  const buf = Buffer.alloc(28);
  buf.writeInt32BE(venueId as number, 0);
  buf.writeInt32BE(symbolId as number, 4);
  buf.writeBigInt64BE(seq, 8);
  buf.writeBigInt64BE(tsExchangeNs as bigint, 16);
  // Extra 4 bytes left as zero padding for alignment

  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 32);
  return hash as EventId;
}
