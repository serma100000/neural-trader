import type { MarketEvent } from '../shared/types.js';
import {
  EventType,
  Side,
} from '../shared/types.js';
import type {
  SymbolId,
  VenueId,
  Timestamp,
  PriceFp,
  QtyFp,
  EventId,
} from '../shared/types.js';

/**
 * Generate synthetic market events for training and testing.
 *
 * Produces a realistic-ish sequence of NewOrder, Trade, CancelOrder, and
 * ModifyOrder events with a random-walk mid price. Useful for end-to-end
 * testing of the training pipeline before real data is available.
 *
 * @param count - Number of events to generate
 * @param basePrice - Starting mid price in fixed-point representation
 * @param baseTsNs - Starting timestamp in nanoseconds
 * @returns Array of MarketEvent in temporal order
 */
export function generateSyntheticEvents(
  count: number,
  basePrice: number = 100_000_000,
  baseTsNs: bigint = 1_000_000_000_000n,
): MarketEvent[] {
  const events: MarketEvent[] = [];
  let currentPrice = basePrice;
  let tsNs = baseTsNs;
  let seq = 0n;

  const symbolId = 1 as SymbolId;
  const venueId = 1 as VenueId;

  for (let i = 0; i < count; i++) {
    // Random walk the price
    const priceChange = (Math.random() - 0.5) * basePrice * 0.001;
    currentPrice = Math.max(basePrice * 0.9, currentPrice + priceChange);

    // Advance time by 50-200ms
    tsNs += BigInt(Math.floor(50_000_000 + Math.random() * 150_000_000));

    // Pick event type with weighted distribution
    const roll = Math.random();
    let eventType: EventType;
    if (roll < 0.4) {
      eventType = EventType.NewOrder;
    } else if (roll < 0.6) {
      eventType = EventType.Trade;
    } else if (roll < 0.8) {
      eventType = EventType.CancelOrder;
    } else if (roll < 0.9) {
      eventType = EventType.ModifyOrder;
    } else {
      eventType = EventType.BookSnapshot;
    }

    const side = Math.random() < 0.5 ? Side.Bid : Side.Ask;

    // Add some spread noise for non-mid prices
    let price = currentPrice;
    if (eventType === EventType.NewOrder) {
      price += (side === Side.Bid ? -1 : 1) * basePrice * 0.0005 * Math.random();
    }
    if (eventType === EventType.Trade) {
      // Trades happen near mid with small slippage
      price += (Math.random() - 0.5) * basePrice * 0.0002;
    }

    const qty = Math.floor(100 + Math.random() * 900);

    events.push({
      eventId: `evt-${i}` as EventId,
      tsExchangeNs: tsNs as Timestamp,
      tsIngestNs: (tsNs + 1_000_000n) as Timestamp,
      venueId,
      symbolId,
      eventType,
      side,
      priceFp: BigInt(Math.round(price)) as PriceFp,
      qtyFp: BigInt(qty) as QtyFp,
      orderIdHash: undefined,
      participantIdHash: undefined,
      flags: 0,
      seq: seq++,
    });
  }

  return events;
}
