import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Normalizer, stringToFixedPoint, generateEventId } from '../../src/ingest/normalizer.js';
import { EventType, Side } from '../../src/shared/types.js';
import type { SymbolId, VenueId, Timestamp } from '../../src/shared/types.js';
import type { RawFrame, BinanceDepthUpdate, BinanceTrade } from '../../src/ingest/types.js';
import { PRICE_SCALE, QTY_SCALE } from '../../src/ingest/types.js';

function makeVenueId(n: number): VenueId {
  return n as VenueId;
}

function makeSymbolId(n: number): SymbolId {
  return n as SymbolId;
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
  } as unknown as import('../../src/shared/logger.js').Logger;
}

function makeFrame(data: unknown, venueId = 1): RawFrame {
  return {
    venueId: makeVenueId(venueId),
    data,
    receivedAtNs: 1000000000n,
  };
}

describe('Normalizer', () => {
  let normalizer: Normalizer;
  let logger: ReturnType<typeof createLogger>;

  const resolver = (venue: string, symbol: string): SymbolId | undefined => {
    if (venue === '1' && symbol === 'BTCUSDT') return makeSymbolId(100);
    if (venue === '1' && symbol === 'ETHUSDT') return makeSymbolId(101);
    return undefined;
  };

  beforeEach(() => {
    logger = createLogger();
    normalizer = new Normalizer(resolver, logger);
  });

  describe('depth update normalization', () => {
    it('should normalize a valid depth update into MarketEvents', () => {
      const depthUpdate: BinanceDepthUpdate = {
        e: 'depthUpdate',
        E: 1700000001000,
        s: 'BTCUSDT',
        U: 100,
        u: 102,
        b: [['42000.10', '1.500']],
        a: [['42000.50', '0.800']],
      };

      const events = normalizer.normalize(makeFrame(depthUpdate));

      expect(events).toHaveLength(2);

      // Bid event
      const bid = events[0]!;
      expect(bid.venueId).toBe(makeVenueId(1));
      expect(bid.symbolId).toBe(makeSymbolId(100));
      expect(bid.eventType).toBe(EventType.ModifyOrder);
      expect(bid.side).toBe(Side.Bid);
      expect(bid.priceFp).toBe(stringToFixedPoint('42000.10', PRICE_SCALE));
      expect(bid.qtyFp).toBe(stringToFixedPoint('1.500', QTY_SCALE));
      expect(bid.tsExchangeNs).toBe(BigInt(1700000001000) * 1_000_000n);

      // Ask event
      const ask = events[1]!;
      expect(ask.side).toBe(Side.Ask);
      expect(ask.priceFp).toBe(stringToFixedPoint('42000.50', PRICE_SCALE));
    });

    it('should emit CancelOrder when qty is zero', () => {
      const depthUpdate: BinanceDepthUpdate = {
        e: 'depthUpdate',
        E: 1700000001000,
        s: 'BTCUSDT',
        U: 100,
        u: 101,
        b: [['42000.10', '0.000']],
        a: [],
      };

      const events = normalizer.normalize(makeFrame(depthUpdate));

      expect(events).toHaveLength(1);
      expect(events[0]!.eventType).toBe(EventType.CancelOrder);
      expect(events[0]!.qtyFp).toBe(0n);
    });
  });

  describe('trade normalization', () => {
    it('should normalize a valid trade into a MarketEvent', () => {
      const trade: BinanceTrade = {
        e: 'trade',
        E: 1700000001050,
        s: 'BTCUSDT',
        t: 1001,
        p: '42000.30',
        q: '0.150',
        b: 5001,
        a: 5002,
        T: 1700000001050,
        m: false,
        M: true,
      };

      const events = normalizer.normalize(makeFrame(trade));

      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.eventType).toBe(EventType.Trade);
      expect(event.side).toBe(Side.Bid); // m=false means buyer is taker
      expect(event.priceFp).toBe(stringToFixedPoint('42000.30', PRICE_SCALE));
      expect(event.qtyFp).toBe(stringToFixedPoint('0.150', QTY_SCALE));
      expect(event.tsExchangeNs).toBe(BigInt(1700000001050) * 1_000_000n);
    });

    it('should set side to Ask when m=true (buyer is maker)', () => {
      const trade: BinanceTrade = {
        e: 'trade',
        E: 1700000001050,
        s: 'BTCUSDT',
        t: 1001,
        p: '42000.30',
        q: '0.150',
        b: 5001,
        a: 5002,
        T: 1700000001050,
        m: true,
        M: true,
      };

      const events = normalizer.normalize(makeFrame(trade));
      expect(events[0]!.side).toBe(Side.Ask);
    });
  });

  describe('invalid payloads', () => {
    it('should reject non-object data', () => {
      const events = normalizer.normalize(makeFrame('not an object'));
      expect(events).toHaveLength(0);
    });

    it('should reject depth update with missing symbol', () => {
      const events = normalizer.normalize(makeFrame({
        e: 'depthUpdate',
        E: 1700000001000,
        s: '',
        U: 100,
        u: 101,
        b: [],
        a: [],
      }));
      expect(events).toHaveLength(0);
    });

    it('should reject trade with missing price', () => {
      const events = normalizer.normalize(makeFrame({
        e: 'trade',
        E: 1700000001050,
        s: 'BTCUSDT',
        t: 1001,
        q: '0.150',
        b: 5001,
        a: 5002,
        T: 1700000001050,
        m: false,
        M: true,
      }));
      expect(events).toHaveLength(0);
    });

    it('should skip unknown event types silently', () => {
      const events = normalizer.normalize(makeFrame({
        e: 'kline',
        E: 1700000001000,
        s: 'BTCUSDT',
      }));
      expect(events).toHaveLength(0);
    });

    it('should skip events for unknown symbols', () => {
      const trade: BinanceTrade = {
        e: 'trade',
        E: 1700000001050,
        s: 'UNKNOWN',
        t: 1001,
        p: '100.00',
        q: '1.000',
        b: 5001,
        a: 5002,
        T: 1700000001050,
        m: false,
        M: true,
      };
      const events = normalizer.normalize(makeFrame(trade));
      expect(events).toHaveLength(0);
    });
  });

  describe('stringToFixedPoint', () => {
    it('should convert integer strings', () => {
      expect(stringToFixedPoint('42000', PRICE_SCALE)).toBe(4200000000000n);
    });

    it('should convert decimal strings', () => {
      expect(stringToFixedPoint('42000.10', PRICE_SCALE)).toBe(4200010000000n);
    });

    it('should handle zero', () => {
      expect(stringToFixedPoint('0.000', PRICE_SCALE)).toBe(0n);
    });

    it('should handle small decimals', () => {
      expect(stringToFixedPoint('0.00000001', PRICE_SCALE)).toBe(1n);
    });

    it('should truncate excess precision', () => {
      // 9 decimal places, but scale is 1e8 (8 decimals)
      expect(stringToFixedPoint('1.123456789', PRICE_SCALE)).toBe(112345678n);
    });

    it('should return null for empty string', () => {
      expect(stringToFixedPoint('', PRICE_SCALE)).toBeNull();
    });

    it('should return null for invalid string', () => {
      expect(stringToFixedPoint('abc', PRICE_SCALE)).toBeNull();
    });

    it('should round-trip correctly for typical prices', () => {
      const price = '42000.12345678';
      const fp = stringToFixedPoint(price, PRICE_SCALE);
      expect(fp).not.toBeNull();
      // Convert back: fp / scale
      const backInt = fp! / PRICE_SCALE;
      const backFrac = fp! % PRICE_SCALE;
      const backStr = `${backInt}.${backFrac.toString().padStart(8, '0')}`;
      expect(backStr).toBe(price);
    });
  });

  describe('generateEventId', () => {
    it('should produce a 32-char hex string', () => {
      const id = generateEventId(
        makeVenueId(1),
        makeSymbolId(100),
        1n,
        BigInt(1700000001000) * 1_000_000n as Timestamp,
      );
      expect(id).toHaveLength(32);
      expect(/^[0-9a-f]{32}$/.test(id)).toBe(true);
    });

    it('should be deterministic', () => {
      const args = [makeVenueId(1), makeSymbolId(100), 1n, BigInt(1700000001000) * 1_000_000n as Timestamp] as const;
      const id1 = generateEventId(...args);
      const id2 = generateEventId(...args);
      expect(id1).toBe(id2);
    });

    it('should differ for different inputs', () => {
      const id1 = generateEventId(makeVenueId(1), makeSymbolId(100), 1n, 1000n as Timestamp);
      const id2 = generateEventId(makeVenueId(1), makeSymbolId(100), 2n, 1000n as Timestamp);
      expect(id1).not.toBe(id2);
    });
  });
});
