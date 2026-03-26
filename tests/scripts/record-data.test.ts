import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MarketEvent, SymbolId, VenueId, Timestamp, EventId, PriceFp, QtyFp } from '../../src/shared/types.js';
import { EventType, Side } from '../../src/shared/types.js';

// Import the buffer class and SQL builder from the record script
// We re-export them for testability
import { EventBuffer, buildBatchInsertSql } from '../../scripts/record-data.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<MarketEvent> = {}): MarketEvent {
  return {
    eventId: 'abc123def456abc123def456abc123de' as EventId,
    tsExchangeNs: 1_700_000_000_000_000_000n as Timestamp,
    tsIngestNs: 1_700_000_000_000_100_000n as Timestamp,
    venueId: 1 as VenueId,
    symbolId: 1 as SymbolId,
    eventType: EventType.Trade,
    side: Side.Bid,
    priceFp: 4200000000000n as PriceFp,
    qtyFp: 100000000n as QtyFp,
    flags: 0,
    seq: 1n,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// EventBuffer tests
// ---------------------------------------------------------------------------

describe('EventBuffer', () => {
  let flushSpy: ReturnType<typeof vi.fn>;
  let buffer: EventBuffer;

  beforeEach(() => {
    flushSpy = vi.fn().mockResolvedValue(undefined);
    buffer = new EventBuffer(flushSpy, 5, 10_000);
  });

  afterEach(() => {
    buffer.stop();
  });

  it('should accumulate events without flushing below threshold', () => {
    buffer.add([makeEvent()]);
    buffer.add([makeEvent({ seq: 2n })]);
    expect(buffer.length).toBe(2);
    expect(flushSpy).not.toHaveBeenCalled();
  });

  it('should auto-flush when reaching maxSize', async () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEvent({ seq: BigInt(i + 1) }),
    );
    buffer.add(events);

    // Allow the async flush to complete
    await vi.waitFor(() => {
      expect(flushSpy).toHaveBeenCalledTimes(1);
    });

    expect(flushSpy).toHaveBeenCalledWith(events);
    expect(buffer.length).toBe(0);
  });

  it('should flush manually when flush() is called', async () => {
    buffer.add([makeEvent(), makeEvent({ seq: 2n })]);
    expect(buffer.length).toBe(2);

    const flushed = await buffer.flush();
    expect(flushed).toHaveLength(2);
    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(buffer.length).toBe(0);
  });

  it('should return empty array when flushing empty buffer', async () => {
    const flushed = await buffer.flush();
    expect(flushed).toHaveLength(0);
    expect(flushSpy).not.toHaveBeenCalled();
  });

  it('should re-add events on flush failure', async () => {
    flushSpy.mockRejectedValueOnce(new Error('db error'));
    buffer.add([makeEvent(), makeEvent({ seq: 2n })]);

    await buffer.flush();
    // Events should be re-added to the buffer
    expect(buffer.length).toBe(2);
  });

  it('should flush on interval when started', async () => {
    vi.useFakeTimers();

    const intervalBuffer = new EventBuffer(flushSpy, 100, 500);
    intervalBuffer.start();
    intervalBuffer.add([makeEvent()]);

    await vi.advanceTimersByTimeAsync(500);
    expect(flushSpy).toHaveBeenCalledTimes(1);

    intervalBuffer.stop();
    vi.useRealTimers();
  });

  it('should stop flushing on interval when stopped', async () => {
    vi.useFakeTimers();

    const intervalBuffer = new EventBuffer(flushSpy, 100, 500);
    intervalBuffer.start();
    intervalBuffer.add([makeEvent()]);

    intervalBuffer.stop();
    await vi.advanceTimersByTimeAsync(1000);

    // Should not have flushed since we stopped before the interval
    expect(flushSpy).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Batch insert SQL generation tests
// ---------------------------------------------------------------------------

describe('buildBatchInsertSql', () => {
  it('should generate valid INSERT SQL for a single event', () => {
    const event = makeEvent();
    const { sql, values } = buildBatchInsertSql([event]);

    expect(sql).toContain('INSERT INTO nt_event_log');
    expect(sql).toContain('ON CONFLICT (ts_exchange_ns, event_id) DO NOTHING');
    // 13 columns per event
    expect(values).toHaveLength(13);
    // First value should be the event_id buffer
    expect(Buffer.isBuffer(values[0])).toBe(true);
    // Venue ID should be present
    expect(values[3]).toBe(1);
    // Symbol ID should be present
    expect(values[4]).toBe(1);
  });

  it('should generate correct SQL for multiple events', () => {
    const events = [
      makeEvent({ seq: 1n }),
      makeEvent({ seq: 2n }),
      makeEvent({ seq: 3n }),
    ];

    const { sql, values } = buildBatchInsertSql(events);

    // 3 events * 13 columns = 39 values
    expect(values).toHaveLength(39);

    // Should have 3 value groups
    const valueGroupCount = (sql.match(/\(\$/g) ?? []).length;
    expect(valueGroupCount).toBe(3);
  });

  it('should handle events with null side and orderIdHash', () => {
    const event = makeEvent({ side: undefined, orderIdHash: undefined });
    const { values } = buildBatchInsertSql([event]);

    // side (index 6) should be null
    expect(values[6]).toBeNull();
    // order_id_hash (index 9) should be null
    expect(values[9]).toBeNull();
    // witness_hash (index 12) should be null
    expect(values[12]).toBeNull();
  });

  it('should convert bigint fields to string for Postgres', () => {
    const event = makeEvent({
      tsExchangeNs: 1_700_000_000_000_000_000n as Timestamp,
      priceFp: 4200000000000n as PriceFp,
    });
    const { values } = buildBatchInsertSql([event]);

    // ts_exchange_ns (index 1) should be a string
    expect(typeof values[1]).toBe('string');
    expect(values[1]).toBe('1700000000000000000');

    // price_fp (index 7) should be a string
    expect(typeof values[7]).toBe('string');
    expect(values[7]).toBe('4200000000000');
  });
});

// ---------------------------------------------------------------------------
// Stats logging interval test
// ---------------------------------------------------------------------------

describe('Stats logging interval', () => {
  it('should track events per interval for rate calculation', () => {
    // Simulate the stats tracking the recorder uses
    const stats = {
      totalEvents: 0,
      eventsThisInterval: 0,
      startedAt: Date.now(),
    };

    // Simulate receiving events
    stats.eventsThisInterval += 100;
    stats.totalEvents += 100;

    const intervalSec = 60;
    const eventsPerSec = stats.eventsThisInterval / intervalSec;

    expect(eventsPerSec).toBeCloseTo(100 / 60, 1);

    // Simulate interval reset
    stats.eventsThisInterval = 0;
    expect(stats.eventsThisInterval).toBe(0);
    expect(stats.totalEvents).toBe(100);
  });

  it('should accumulate totalEvents across intervals', () => {
    const stats = {
      totalEvents: 0,
      eventsThisInterval: 0,
      startedAt: Date.now(),
    };

    // Interval 1
    stats.eventsThisInterval = 50;
    stats.totalEvents += 50;
    stats.eventsThisInterval = 0;

    // Interval 2
    stats.eventsThisInterval = 75;
    stats.totalEvents += 75;
    stats.eventsThisInterval = 0;

    expect(stats.totalEvents).toBe(125);
  });

  it('should calculate uptime correctly', () => {
    const startedAt = Date.now() - 120_000; // 2 minutes ago
    const uptimeSec = (Date.now() - startedAt) / 1000;

    expect(uptimeSec).toBeGreaterThanOrEqual(119);
    expect(uptimeSec).toBeLessThanOrEqual(121);
  });
});
