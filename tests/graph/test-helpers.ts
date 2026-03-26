import {
  EventType,
  Side,
  type MarketEvent,
  type SymbolId,
  type VenueId,
  type Timestamp,
  type PriceFp,
  type QtyFp,
  type EventId,
  type OrderIdHash,
} from '../../src/shared/types.js';

let eventCounter = 0;
let seqCounter = 0n;

/** Reset counters between tests. */
export function resetCounters(): void {
  eventCounter = 0;
  seqCounter = 0n;
}

/** Create a unique event id. */
function nextEventId(): EventId {
  return `evt-${++eventCounter}` as EventId;
}

/** Create a unique order id hash. */
export function makeOrderId(label: string): OrderIdHash {
  return `order-${label}` as OrderIdHash;
}

/** Default symbol and venue for tests. */
export const TEST_SYMBOL = 1 as SymbolId;
export const TEST_VENUE = 1 as VenueId;

/** Helper to cast numbers to branded types. */
export function ts(ns: number | bigint): Timestamp {
  return BigInt(ns) as Timestamp;
}

export function price(val: number | bigint): PriceFp {
  return BigInt(val) as PriceFp;
}

export function qty(val: number | bigint): QtyFp {
  return BigInt(val) as QtyFp;
}

/** Create a synthetic NewOrder event. */
export function newOrderEvent(opts?: {
  symbolId?: SymbolId;
  venueId?: VenueId;
  side?: Side;
  priceFp?: PriceFp;
  qtyFp?: QtyFp;
  orderIdHash?: OrderIdHash;
  tsExchangeNs?: Timestamp;
}): MarketEvent {
  return {
    eventId: nextEventId(),
    tsExchangeNs: opts?.tsExchangeNs ?? ts(1_000_000_000),
    tsIngestNs: ts(1_000_000_100),
    venueId: opts?.venueId ?? TEST_VENUE,
    symbolId: opts?.symbolId ?? TEST_SYMBOL,
    eventType: EventType.NewOrder,
    side: opts?.side ?? Side.Bid,
    priceFp: opts?.priceFp ?? price(10000),
    qtyFp: opts?.qtyFp ?? qty(100),
    orderIdHash: opts?.orderIdHash ?? makeOrderId(`${eventCounter}`),
    flags: 0,
    seq: ++seqCounter,
  };
}

/** Create a synthetic ModifyOrder event. */
export function modifyOrderEvent(
  orderIdHash: OrderIdHash,
  newQty: QtyFp,
  opts?: {
    tsExchangeNs?: Timestamp;
    symbolId?: SymbolId;
    venueId?: VenueId;
  },
): MarketEvent {
  return {
    eventId: nextEventId(),
    tsExchangeNs: opts?.tsExchangeNs ?? ts(2_000_000_000),
    tsIngestNs: ts(2_000_000_100),
    venueId: opts?.venueId ?? TEST_VENUE,
    symbolId: opts?.symbolId ?? TEST_SYMBOL,
    eventType: EventType.ModifyOrder,
    side: Side.Bid,
    priceFp: price(10000),
    qtyFp: newQty,
    orderIdHash,
    flags: 0,
    seq: ++seqCounter,
  };
}

/** Create a synthetic CancelOrder event. */
export function cancelOrderEvent(
  orderIdHash: OrderIdHash,
  opts?: {
    tsExchangeNs?: Timestamp;
    symbolId?: SymbolId;
    venueId?: VenueId;
  },
): MarketEvent {
  return {
    eventId: nextEventId(),
    tsExchangeNs: opts?.tsExchangeNs ?? ts(3_000_000_000),
    tsIngestNs: ts(3_000_000_100),
    venueId: opts?.venueId ?? TEST_VENUE,
    symbolId: opts?.symbolId ?? TEST_SYMBOL,
    eventType: EventType.CancelOrder,
    side: Side.Bid,
    priceFp: price(10000),
    qtyFp: qty(0),
    orderIdHash,
    flags: 0,
    seq: ++seqCounter,
  };
}

/** Create a synthetic Trade event. */
export function tradeEvent(opts?: {
  symbolId?: SymbolId;
  venueId?: VenueId;
  side?: Side;
  priceFp?: PriceFp;
  qtyFp?: QtyFp;
  orderIdHash?: OrderIdHash;
  tsExchangeNs?: Timestamp;
}): MarketEvent {
  return {
    eventId: nextEventId(),
    tsExchangeNs: opts?.tsExchangeNs ?? ts(4_000_000_000),
    tsIngestNs: ts(4_000_000_100),
    venueId: opts?.venueId ?? TEST_VENUE,
    symbolId: opts?.symbolId ?? TEST_SYMBOL,
    eventType: EventType.Trade,
    side: opts?.side ?? Side.Bid,
    priceFp: opts?.priceFp ?? price(10000),
    qtyFp: opts?.qtyFp ?? qty(50),
    orderIdHash: opts?.orderIdHash,
    flags: 0,
    seq: ++seqCounter,
  };
}

/** Create a synthetic BookSnapshot event. */
export function bookSnapshotEvent(opts?: {
  symbolId?: SymbolId;
  venueId?: VenueId;
  side?: Side;
  priceFp?: PriceFp;
  qtyFp?: QtyFp;
  tsExchangeNs?: Timestamp;
}): MarketEvent {
  return {
    eventId: nextEventId(),
    tsExchangeNs: opts?.tsExchangeNs ?? ts(5_000_000_000),
    tsIngestNs: ts(5_000_000_100),
    venueId: opts?.venueId ?? TEST_VENUE,
    symbolId: opts?.symbolId ?? TEST_SYMBOL,
    eventType: EventType.BookSnapshot,
    side: opts?.side ?? Side.Bid,
    priceFp: opts?.priceFp ?? price(10000),
    qtyFp: opts?.qtyFp ?? qty(500),
    flags: 0,
    seq: ++seqCounter,
  };
}

/** Create a synthetic SessionMarker event. */
export function sessionMarkerEvent(opts?: {
  symbolId?: SymbolId;
  venueId?: VenueId;
  tsExchangeNs?: Timestamp;
}): MarketEvent {
  return {
    eventId: nextEventId(),
    tsExchangeNs: opts?.tsExchangeNs ?? ts(6_000_000_000),
    tsIngestNs: ts(6_000_000_100),
    venueId: opts?.venueId ?? TEST_VENUE,
    symbolId: opts?.symbolId ?? TEST_SYMBOL,
    eventType: EventType.SessionMarker,
    priceFp: price(0),
    qtyFp: qty(0),
    flags: 0,
    seq: ++seqCounter,
  };
}

/** Create a synthetic VenueStatus event. */
export function venueStatusEvent(opts?: {
  venueId?: VenueId;
  flags?: number;
  tsExchangeNs?: Timestamp;
}): MarketEvent {
  return {
    eventId: nextEventId(),
    tsExchangeNs: opts?.tsExchangeNs ?? ts(7_000_000_000),
    tsIngestNs: ts(7_000_000_100),
    venueId: opts?.venueId ?? TEST_VENUE,
    symbolId: TEST_SYMBOL,
    eventType: EventType.VenueStatus,
    priceFp: price(0),
    qtyFp: qty(0),
    flags: opts?.flags ?? 1,
    seq: ++seqCounter,
  };
}

/**
 * Generate a batch of N synthetic events with incrementing timestamps.
 * Mixes NewOrder, Trade, ModifyOrder, and CancelOrder events.
 */
export function generateEventBatch(
  n: number,
  opts?: {
    symbolId?: SymbolId;
    venueId?: VenueId;
    startNs?: bigint;
  },
): MarketEvent[] {
  const events: MarketEvent[] = [];
  const sym = opts?.symbolId ?? TEST_SYMBOL;
  const ven = opts?.venueId ?? TEST_VENUE;
  const startNs = opts?.startNs ?? 1_000_000_000n;

  const orderIds: OrderIdHash[] = [];

  for (let i = 0; i < n; i++) {
    const tsNs = ts(startNs + BigInt(i) * 1_000_000n);
    const roll = i % 10;

    if (roll < 5) {
      // 50% new orders
      const oid = makeOrderId(`batch-${i}`);
      orderIds.push(oid);
      events.push(
        newOrderEvent({
          symbolId: sym,
          venueId: ven,
          tsExchangeNs: tsNs,
          priceFp: price(10000 + (i % 20) * 10),
          qtyFp: qty(50 + (i % 5) * 10),
          orderIdHash: oid,
          side: i % 2 === 0 ? Side.Bid : Side.Ask,
        }),
      );
    } else if (roll < 7 && orderIds.length > 0) {
      // 20% trades
      const targetOrder = orderIds[Math.floor(orderIds.length / 2)];
      events.push(
        tradeEvent({
          symbolId: sym,
          venueId: ven,
          tsExchangeNs: tsNs,
          qtyFp: qty(20),
          orderIdHash: targetOrder,
        }),
      );
    } else if (roll < 9 && orderIds.length > 0) {
      // 20% modifies
      const targetOrder = orderIds[orderIds.length - 1];
      events.push(
        modifyOrderEvent(targetOrder, qty(30), {
          tsExchangeNs: tsNs,
          symbolId: sym,
          venueId: ven,
        }),
      );
    } else if (orderIds.length > 0) {
      // 10% cancels
      const targetOrder = orderIds.pop()!;
      events.push(
        cancelOrderEvent(targetOrder, {
          tsExchangeNs: tsNs,
          symbolId: sym,
          venueId: ven,
        }),
      );
    } else {
      // Fallback to new order
      const oid = makeOrderId(`batch-fallback-${i}`);
      orderIds.push(oid);
      events.push(
        newOrderEvent({
          symbolId: sym,
          venueId: ven,
          tsExchangeNs: tsNs,
          orderIdHash: oid,
        }),
      );
    }
  }

  return events;
}
