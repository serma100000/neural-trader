import { describe, it, expect, beforeEach } from 'vitest';
import type {
  MarketEvent,
  SymbolId,
  VenueId,
  Timestamp,
  EventId,
  PriceFp,
  QtyFp,
} from '../../src/shared/types.js';
import { EventType, Side } from '../../src/shared/types.js';
import type { IEventRepository } from '../../src/storage/types.js';
import { partitionNameForTs, hourBounds } from '../../src/storage/event-repo.js';

// ---------------------------------------------------------------------------
// In-memory implementation for unit tests
// ---------------------------------------------------------------------------

class InMemoryEventRepository implements IEventRepository {
  private events: MarketEvent[] = [];

  async batchInsert(events: MarketEvent[]): Promise<number> {
    // Deduplicate by (tsExchangeNs, eventId)
    let inserted = 0;
    for (const evt of events) {
      const exists = this.events.some(
        (e) =>
          BigInt(e.tsExchangeNs) === BigInt(evt.tsExchangeNs) &&
          e.eventId === evt.eventId,
      );
      if (!exists) {
        this.events.push({ ...evt });
        inserted++;
      }
    }
    return inserted;
  }

  async queryBySymbolAndTime(
    symbolId: SymbolId,
    startNs: Timestamp,
    endNs: Timestamp,
  ): Promise<MarketEvent[]> {
    return this.events
      .filter(
        (e) =>
          e.symbolId === symbolId &&
          BigInt(e.tsExchangeNs) >= BigInt(startNs) &&
          BigInt(e.tsExchangeNs) < BigInt(endNs),
      )
      .sort((a, b) => {
        const tsDiff = BigInt(a.tsExchangeNs) - BigInt(b.tsExchangeNs);
        if (tsDiff !== 0n) return tsDiff < 0n ? -1 : 1;
        return a.seq < b.seq ? -1 : 1;
      });
  }

  async queryByVenueAndTime(
    venueId: VenueId,
    startNs: Timestamp,
    endNs: Timestamp,
  ): Promise<MarketEvent[]> {
    return this.events
      .filter(
        (e) =>
          e.venueId === venueId &&
          BigInt(e.tsExchangeNs) >= BigInt(startNs) &&
          BigInt(e.tsExchangeNs) < BigInt(endNs),
      )
      .sort((a, b) => {
        const tsDiff = BigInt(a.tsExchangeNs) - BigInt(b.tsExchangeNs);
        if (tsDiff !== 0n) return tsDiff < 0n ? -1 : 1;
        return a.seq < b.seq ? -1 : 1;
      });
  }

  async count(): Promise<number> {
    return this.events.length;
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<MarketEvent> = {}): MarketEvent {
  return {
    eventId: 'evt-001' as EventId,
    tsExchangeNs: BigInt(1_000_000_000_000) as Timestamp,
    tsIngestNs: BigInt(1_000_000_001_000) as Timestamp,
    venueId: 1 as VenueId,
    symbolId: 100 as SymbolId,
    eventType: EventType.Trade,
    side: Side.Bid,
    priceFp: BigInt(50000_00000000) as PriceFp,
    qtyFp: BigInt(1_00000000) as QtyFp,
    flags: 0,
    seq: 1n,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InMemoryEventRepository', () => {
  let repo: InMemoryEventRepository;

  beforeEach(() => {
    repo = new InMemoryEventRepository();
  });

  describe('batchInsert', () => {
    it('should insert events and return count', async () => {
      const events = [
        makeEvent({ eventId: 'e1' as EventId, seq: 1n }),
        makeEvent({ eventId: 'e2' as EventId, seq: 2n }),
        makeEvent({ eventId: 'e3' as EventId, seq: 3n }),
      ];

      const inserted = await repo.batchInsert(events);
      expect(inserted).toBe(3);

      const total = await repo.count();
      expect(total).toBe(3);
    });

    it('should deduplicate on (tsExchangeNs, eventId)', async () => {
      const evt = makeEvent({ eventId: 'dup' as EventId });
      await repo.batchInsert([evt, evt]);
      expect(await repo.count()).toBe(1);
    });

    it('should return 0 for empty array', async () => {
      const inserted = await repo.batchInsert([]);
      expect(inserted).toBe(0);
    });
  });

  describe('queryBySymbolAndTime', () => {
    it('should return events within the time range for a symbol', async () => {
      const base = BigInt(1_000_000_000_000);
      const events = [
        makeEvent({
          eventId: 'e1' as EventId,
          symbolId: 100 as SymbolId,
          tsExchangeNs: base as Timestamp,
          seq: 1n,
        }),
        makeEvent({
          eventId: 'e2' as EventId,
          symbolId: 100 as SymbolId,
          tsExchangeNs: (base + 500n) as Timestamp,
          seq: 2n,
        }),
        makeEvent({
          eventId: 'e3' as EventId,
          symbolId: 100 as SymbolId,
          tsExchangeNs: (base + 2000n) as Timestamp,
          seq: 3n,
        }),
        makeEvent({
          eventId: 'e4' as EventId,
          symbolId: 200 as SymbolId,
          tsExchangeNs: (base + 100n) as Timestamp,
          seq: 4n,
        }),
      ];

      await repo.batchInsert(events);

      const result = await repo.queryBySymbolAndTime(
        100 as SymbolId,
        base as Timestamp,
        (base + 1000n) as Timestamp,
      );

      expect(result).toHaveLength(2);
      expect(result[0].eventId).toBe('e1');
      expect(result[1].eventId).toBe('e2');
    });

    it('should return empty for non-matching symbol', async () => {
      await repo.batchInsert([makeEvent({ symbolId: 100 as SymbolId })]);

      const result = await repo.queryBySymbolAndTime(
        999 as SymbolId,
        BigInt(0) as Timestamp,
        BigInt(Number.MAX_SAFE_INTEGER) as Timestamp,
      );
      expect(result).toHaveLength(0);
    });

    it('should use exclusive end bound', async () => {
      const ts = BigInt(5000) as Timestamp;
      await repo.batchInsert([
        makeEvent({ eventId: 'boundary' as EventId, tsExchangeNs: ts }),
      ]);

      // endNs is exclusive, so querying [5000, 5000) returns nothing
      const result = await repo.queryBySymbolAndTime(
        100 as SymbolId,
        ts,
        ts,
      );
      expect(result).toHaveLength(0);

      // [5000, 5001) returns the event
      const result2 = await repo.queryBySymbolAndTime(
        100 as SymbolId,
        ts,
        (BigInt(ts) + 1n) as Timestamp,
      );
      expect(result2).toHaveLength(1);
    });
  });

  describe('queryByVenueAndTime', () => {
    it('should filter by venue', async () => {
      const base = BigInt(1_000_000_000_000);
      await repo.batchInsert([
        makeEvent({
          eventId: 'v1' as EventId,
          venueId: 1 as VenueId,
          tsExchangeNs: base as Timestamp,
          seq: 1n,
        }),
        makeEvent({
          eventId: 'v2' as EventId,
          venueId: 2 as VenueId,
          tsExchangeNs: base as Timestamp,
          seq: 2n,
        }),
      ]);

      const result = await repo.queryByVenueAndTime(
        1 as VenueId,
        base as Timestamp,
        (base + 1n) as Timestamp,
      );
      expect(result).toHaveLength(1);
      expect(result[0].eventId).toBe('v1');
    });
  });

  describe('count', () => {
    it('should return 0 for empty repo', async () => {
      expect(await repo.count()).toBe(0);
    });

    it('should track total events', async () => {
      await repo.batchInsert([
        makeEvent({ eventId: 'a' as EventId }),
        makeEvent({ eventId: 'b' as EventId }),
      ]);
      expect(await repo.count()).toBe(2);
    });
  });
});

describe('partitionNameForTs', () => {
  it('should generate deterministic hourly partition names', () => {
    const hourNs = BigInt(3_600_000_000_000);
    const ts = hourNs * 2n + 500n; // midway through hour 2
    const name = partitionNameForTs(ts);
    expect(name).toBe(`nt_event_log_${hourNs * 2n}`);
  });

  it('should return hour boundary for exact hour timestamps', () => {
    const hourNs = BigInt(3_600_000_000_000);
    const name = partitionNameForTs(hourNs * 5n);
    expect(name).toBe(`nt_event_log_${hourNs * 5n}`);
  });
});

describe('hourBounds', () => {
  it('should return correct start and end for a timestamp', () => {
    const hourNs = BigInt(3_600_000_000_000);
    const ts = hourNs * 3n + 1000n;
    const bounds = hourBounds(ts);
    expect(bounds.start).toBe(hourNs * 3n);
    expect(bounds.end).toBe(hourNs * 4n);
  });
});
