import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createLogger, type Logger } from '../shared/logger.js';
import type {
  MarketEvent,
  SymbolId,
  VenueId,
  Timestamp,
  EventId,
  PriceFp,
  QtyFp,
  OrderIdHash,
} from '../shared/types.js';
import type { PgClient } from './pg-client.js';
import type { IEventRepository, PartitionInfo } from './types.js';

/** One hour in nanoseconds */
const HOUR_NS = BigInt(3_600_000_000_000);

/**
 * Generates the partition name for an hourly partition covering tsNs.
 */
function partitionNameForTs(tsNs: bigint): string {
  const hourBucket = (tsNs / HOUR_NS) * HOUR_NS;
  return `nt_event_log_${hourBucket}`;
}

/**
 * Computes the hourly range boundaries for a given timestamp.
 */
function hourBounds(tsNs: bigint): { start: bigint; end: bigint } {
  const start = (tsNs / HOUR_NS) * HOUR_NS;
  return { start, end: start + HOUR_NS };
}

/**
 * EventRepository: manages nt_event_log with hourly range partitions.
 * Supports batch insert via COPY protocol and time-range queries.
 */
export class EventRepository implements IEventRepository {
  private readonly log: Logger;
  private readonly createdPartitions = new Set<string>();

  constructor(private readonly pg: PgClient) {
    this.log = createLogger({ component: 'EventRepository' });
  }

  /**
   * Batch insert events using the COPY protocol for high throughput.
   * Automatically ensures partitions exist before inserting.
   */
  async batchInsert(events: MarketEvent[]): Promise<number> {
    if (events.length === 0) return 0;

    // Ensure partitions exist for all events
    const partitionsNeeded = new Set<string>();
    for (const evt of events) {
      const name = partitionNameForTs(BigInt(evt.tsExchangeNs));
      if (!this.createdPartitions.has(name)) {
        partitionsNeeded.add(name);
      }
    }

    for (const name of partitionsNeeded) {
      await this.ensurePartition(name);
    }

    // Use COPY for batch insert
    const client = await this.pg.getClient();
    try {
      const copyQuery = `
        COPY nt_event_log (
          event_id, ts_exchange_ns, ts_ingest_ns, venue_id, symbol_id,
          event_type, side, price_fp, qty_fp, order_id_hash, flags, seq, witness_hash
        ) FROM STDIN WITH (FORMAT binary)
      `;

      // Fall back to multi-row INSERT for portability and simpler implementation
      const values: unknown[] = [];
      const placeholders: string[] = [];
      let paramIdx = 1;

      for (const evt of events) {
        const eventIdBuf = Buffer.from(evt.eventId, 'utf-8');
        const orderHashBuf = evt.orderIdHash
          ? Buffer.from(evt.orderIdHash, 'utf-8')
          : null;

        placeholders.push(
          `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, ` +
          `$${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, ` +
          `$${paramIdx++}, $${paramIdx++}, $${paramIdx++})`,
        );

        values.push(
          eventIdBuf,
          BigInt(evt.tsExchangeNs).toString(),
          BigInt(evt.tsIngestNs).toString(),
          evt.venueId,
          evt.symbolId,
          evt.eventType,
          evt.side ?? null,
          BigInt(evt.priceFp).toString(),
          BigInt(evt.qtyFp).toString(),
          orderHashBuf,
          evt.flags,
          BigInt(evt.seq).toString(),
          null, // witness_hash populated later by coherence layer
        );
      }

      const sql = `
        INSERT INTO nt_event_log (
          event_id, ts_exchange_ns, ts_ingest_ns, venue_id, symbol_id,
          event_type, side, price_fp, qty_fp, order_id_hash, flags, seq, witness_hash
        ) VALUES ${placeholders.join(', ')}
        ON CONFLICT (ts_exchange_ns, event_id) DO NOTHING
      `;

      const result = await client.query(sql, values);
      const inserted = result.rowCount ?? 0;
      this.log.info({ inserted, total: events.length }, 'Batch insert complete');
      return inserted;
    } finally {
      client.release();
    }
  }

  /**
   * Query events by symbol ID within a nanosecond time range.
   */
  async queryBySymbolAndTime(
    symbolId: SymbolId,
    startNs: Timestamp,
    endNs: Timestamp,
  ): Promise<MarketEvent[]> {
    const result = await this.pg.query<EventRow>(
      `SELECT * FROM nt_event_log
       WHERE symbol_id = $1
         AND ts_exchange_ns >= $2
         AND ts_exchange_ns < $3
       ORDER BY ts_exchange_ns, seq`,
      [symbolId, BigInt(startNs).toString(), BigInt(endNs).toString()],
    );
    return result.rows.map(rowToMarketEvent);
  }

  /**
   * Query events by venue ID within a nanosecond time range.
   */
  async queryByVenueAndTime(
    venueId: VenueId,
    startNs: Timestamp,
    endNs: Timestamp,
  ): Promise<MarketEvent[]> {
    const result = await this.pg.query<EventRow>(
      `SELECT * FROM nt_event_log
       WHERE venue_id = $1
         AND ts_exchange_ns >= $2
         AND ts_exchange_ns < $3
       ORDER BY ts_exchange_ns, seq`,
      [venueId, BigInt(startNs).toString(), BigInt(endNs).toString()],
    );
    return result.rows.map(rowToMarketEvent);
  }

  /**
   * Count total events across all partitions.
   */
  async count(): Promise<number> {
    const result = await this.pg.query<{ count: string }>('SELECT count(*) AS count FROM nt_event_log');
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Ensure an hourly partition exists, creating it if necessary.
   */
  private async ensurePartition(partitionName: string): Promise<void> {
    if (this.createdPartitions.has(partitionName)) return;

    // Extract the bucket timestamp from the partition name
    const match = partitionName.match(/nt_event_log_(\d+)/);
    if (!match) throw new Error(`Invalid partition name: ${partitionName}`);

    const rangeStart = BigInt(match[1]);
    const rangeEnd = rangeStart + HOUR_NS;

    try {
      await this.pg.query(`
        CREATE TABLE IF NOT EXISTS ${partitionName}
        PARTITION OF nt_event_log
        FOR VALUES FROM ('${rangeStart}') TO ('${rangeEnd}')
      `);

      // Register in partition registry
      await this.pg.query(
        `INSERT INTO nt_partition_registry (table_name, partition_name, range_start_ns, range_end_ns, tier)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (partition_name) DO NOTHING`,
        ['nt_event_log', partitionName, rangeStart.toString(), rangeEnd.toString(), 'hot'],
      );

      this.createdPartitions.add(partitionName);
      this.log.info({ partitionName, rangeStart: rangeStart.toString() }, 'Partition created');
    } catch (err) {
      // Partition may already exist from another process
      if (String(err).includes('already exists')) {
        this.createdPartitions.add(partitionName);
      } else {
        throw err;
      }
    }
  }
}

/** Raw row from nt_event_log */
interface EventRow {
  event_id: Buffer;
  ts_exchange_ns: string;
  ts_ingest_ns: string;
  venue_id: number;
  symbol_id: number;
  event_type: number;
  side: number | null;
  price_fp: string;
  qty_fp: string;
  order_id_hash: Buffer | null;
  flags: number;
  seq: string;
  witness_hash: Buffer | null;
}

/** Convert a database row to a MarketEvent */
function rowToMarketEvent(row: EventRow): MarketEvent {
  return {
    eventId: row.event_id.toString('utf-8') as EventId,
    tsExchangeNs: BigInt(row.ts_exchange_ns) as Timestamp,
    tsIngestNs: BigInt(row.ts_ingest_ns) as Timestamp,
    venueId: row.venue_id as VenueId,
    symbolId: row.symbol_id as SymbolId,
    eventType: row.event_type,
    side: row.side ?? undefined,
    priceFp: BigInt(row.price_fp) as PriceFp,
    qtyFp: BigInt(row.qty_fp) as QtyFp,
    orderIdHash: row.order_id_hash
      ? (row.order_id_hash.toString('utf-8') as OrderIdHash)
      : undefined,
    flags: row.flags,
    seq: BigInt(row.seq),
  };
}

// Re-export helpers for testing
export { partitionNameForTs, hourBounds, rowToMarketEvent, type EventRow };
