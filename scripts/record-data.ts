/**
 * record-data.ts — Long-running data recorder for neural-trader.
 *
 * Connects to Binance WS for BTC/USDT and ETH/USDT, normalizes events
 * via the existing Normalizer, and batch-inserts to Postgres.
 *
 * Usage: npx tsx scripts/record-data.ts
 */

import pg from 'pg';
import { createHash } from 'node:crypto';
import { BinanceAdapter } from '../src/ingest/binance-adapter.js';
import { Normalizer, generateEventId, stringToFixedPoint } from '../src/ingest/normalizer.js';
import { createLogger } from '../src/shared/logger.js';
import type { MarketEvent, SymbolId, VenueId, Timestamp, EventId } from '../src/shared/types.js';
import { EventType, Side } from '../src/shared/types.js';
import type { RawFrame, FeedConfig } from '../src/ingest/types.js';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------

const POSTGRES_URL = process.env['NT_POSTGRES_URL']
  ?? 'postgresql://nt:dev_password@localhost:5432/neural_trader';
const WS_URL = process.env['NT_VENUE_1_WS_URL']
  ?? 'wss://stream.binance.com:9443/ws';
const LOG_LEVEL = process.env['NT_LOG_LEVEL'] ?? 'info';

const FLUSH_INTERVAL_MS = 1_000;
const FLUSH_BATCH_SIZE = 500;
const STATS_INTERVAL_MS = 60_000;

const logger = createLogger({ component: 'record-data' });

// ---------------------------------------------------------------------------
// Symbol configuration
// ---------------------------------------------------------------------------

const VENUE_ID = 1 as VenueId;
const SYMBOLS: Array<{ name: string; id: SymbolId }> = [
  { name: 'BTCUSDT', id: 1 as SymbolId },
  { name: 'ETHUSDT', id: 2 as SymbolId },
];

// ---------------------------------------------------------------------------
// Event buffer
// ---------------------------------------------------------------------------

export class EventBuffer {
  private buffer: MarketEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly onFlush: (events: MarketEvent[]) => Promise<void>,
    private readonly maxSize: number,
    private readonly intervalMs: number,
  ) {}

  add(events: MarketEvent[]): void {
    this.buffer.push(...events);
    if (this.buffer.length >= this.maxSize) {
      void this.flush();
    }
  }

  start(): void {
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.intervalMs);
  }

  async flush(): Promise<MarketEvent[]> {
    if (this.buffer.length === 0) return [];
    const batch = this.buffer.splice(0);
    try {
      await this.onFlush(batch);
    } catch (err) {
      logger.error({ err, batchSize: batch.length }, 'Failed to flush event buffer');
      // Re-add events to front of buffer so they are not lost
      this.buffer.unshift(...batch);
    }
    return batch;
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  get length(): number {
    return this.buffer.length;
  }
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

const INIT_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS nt_event_log (
    event_id       BYTEA NOT NULL,
    ts_exchange_ns BIGINT NOT NULL,
    ts_ingest_ns   BIGINT NOT NULL,
    venue_id       INT NOT NULL,
    symbol_id      INT NOT NULL,
    event_type     INT NOT NULL,
    side           INT,
    price_fp       BIGINT NOT NULL,
    qty_fp         BIGINT NOT NULL,
    order_id_hash  BYTEA,
    flags          INT NOT NULL DEFAULT 0,
    seq            BIGINT NOT NULL,
    witness_hash   BYTEA,
    PRIMARY KEY (ts_exchange_ns, event_id)
) PARTITION BY RANGE (ts_exchange_ns);

CREATE TABLE IF NOT EXISTS nt_partition_registry (
    table_name     TEXT NOT NULL,
    partition_name TEXT NOT NULL PRIMARY KEY,
    range_start_ns BIGINT NOT NULL,
    range_end_ns   BIGINT NOT NULL,
    tier           TEXT NOT NULL DEFAULT 'hot',
    created_at     TIMESTAMPTZ DEFAULT now(),
    archived_at    TIMESTAMPTZ,
    dropped_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS nt_schema_version (
    version    INT PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT now()
);
`;

const HOUR_NS = BigInt(3_600_000_000_000);
const createdPartitions = new Set<string>();

async function ensurePartition(pool: pg.Pool, tsNs: bigint): Promise<void> {
  const bucket = (tsNs / HOUR_NS) * HOUR_NS;
  const partitionName = `nt_event_log_${bucket}`;
  if (createdPartitions.has(partitionName)) return;

  const rangeEnd = bucket + HOUR_NS;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${partitionName}
      PARTITION OF nt_event_log
      FOR VALUES FROM ('${bucket}') TO ('${rangeEnd}')
    `);
    await pool.query(
      `INSERT INTO nt_partition_registry (table_name, partition_name, range_start_ns, range_end_ns, tier)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (partition_name) DO NOTHING`,
      ['nt_event_log', partitionName, bucket.toString(), rangeEnd.toString(), 'hot'],
    );
    createdPartitions.add(partitionName);
    logger.info({ partitionName }, 'Partition created');
  } catch (err) {
    if (String(err).includes('already exists')) {
      createdPartitions.add(partitionName);
    } else {
      throw err;
    }
  }
}

export function buildBatchInsertSql(events: MarketEvent[]): { sql: string; values: unknown[] } {
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
      null, // witness_hash
    );
  }

  const sql = `
    INSERT INTO nt_event_log (
      event_id, ts_exchange_ns, ts_ingest_ns, venue_id, symbol_id,
      event_type, side, price_fp, qty_fp, order_id_hash, flags, seq, witness_hash
    ) VALUES ${placeholders.join(', ')}
    ON CONFLICT (ts_exchange_ns, event_id) DO NOTHING
  `;

  return { sql, values };
}

async function batchInsertEvents(pool: pg.Pool, events: MarketEvent[]): Promise<number> {
  if (events.length === 0) return 0;

  // Ensure all needed partitions exist
  const partitionBuckets = new Set<bigint>();
  for (const evt of events) {
    partitionBuckets.add(BigInt(evt.tsExchangeNs));
  }
  for (const tsNs of partitionBuckets) {
    await ensurePartition(pool, tsNs);
  }

  const { sql, values } = buildBatchInsertSql(events);
  const result = await pool.query(sql, values);
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Stats reporter
// ---------------------------------------------------------------------------

interface RecorderStats {
  totalEvents: number;
  eventsThisInterval: number;
  startedAt: number;
}

function logStats(stats: RecorderStats, pool: pg.Pool): void {
  const uptimeSec = (Date.now() - stats.startedAt) / 1000;
  const eventsPerSec = stats.eventsThisInterval / (STATS_INTERVAL_MS / 1000);
  const memUsage = process.memoryUsage();

  logger.info({
    eventsPerSec: eventsPerSec.toFixed(1),
    totalEvents: stats.totalEvents,
    uptimeSec: uptimeSec.toFixed(0),
    heapUsedMb: (memUsage.heapUsed / 1024 / 1024).toFixed(1),
    rssMb: (memUsage.rss / 1024 / 1024).toFixed(1),
    poolTotal: pool.totalCount,
    poolIdle: pool.idleCount,
    poolWaiting: pool.waitingCount,
  }, 'Recorder stats');

  // Query async row count for next interval
  pool.query('SELECT count(*) AS count FROM nt_event_log')
    .then((res) => {
      logger.info({ pgRowCount: res.rows[0].count }, 'Postgres row count');
    })
    .catch((err) => {
      logger.warn({ err }, 'Failed to query row count');
    });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info({ wsUrl: WS_URL, postgresUrl: POSTGRES_URL.replace(/:[^:@]+@/, ':***@') }, 'Starting data recorder');

  // 1. Connect to Postgres
  const pool = new Pool({ connectionString: POSTGRES_URL });
  pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected Postgres pool error');
  });

  // 2. Run inline migrations
  logger.info('Running inline schema migration');
  const statements = INIT_SQL
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    await pool.query(stmt);
  }
  logger.info('Schema migration complete');

  // 3. Set up stats
  const stats: RecorderStats = {
    totalEvents: 0,
    eventsThisInterval: 0,
    startedAt: Date.now(),
  };

  // 4. Set up event buffer with Postgres batch insert
  const eventBuffer = new EventBuffer(
    async (events) => {
      const inserted = await batchInsertEvents(pool, events);
      stats.totalEvents += inserted;
      logger.debug({ inserted, batchSize: events.length }, 'Batch inserted');
    },
    FLUSH_BATCH_SIZE,
    FLUSH_INTERVAL_MS,
  );

  // 5. Set up Normalizer
  const symbolMap = new Map<string, SymbolId>();
  for (const sym of SYMBOLS) {
    symbolMap.set(`${VENUE_ID}:${sym.name}`, sym.id);
  }

  const normalizer = new Normalizer(
    (venue: string, symbol: string) => symbolMap.get(`${venue}:${symbol}`),
    logger,
  );

  // 6. Set up Binance WS adapter
  const feedConfig: FeedConfig = {
    venueId: VENUE_ID,
    venueName: 'binance',
    wsUrl: WS_URL,
    feedType: 'l2_delta',
    symbols: SYMBOLS.map((s) => s.id),
    reconnectBaseMs: 1_000,
    reconnectMaxMs: 30_000,
  };

  const adapter = new BinanceAdapter(feedConfig, logger);

  // Set symbol map on adapter
  const adapterSymbolMap = new Map<string, SymbolId>();
  for (const sym of SYMBOLS) {
    adapterSymbolMap.set(sym.name, sym.id);
  }
  adapter.setSymbolMap(adapterSymbolMap);

  // Wire frames -> normalize -> buffer
  adapter.onFrame((frame: RawFrame) => {
    const events = normalizer.normalize(frame);
    if (events.length > 0) {
      stats.eventsThisInterval += events.length;
      eventBuffer.add(events);
    }
  });

  adapter.onError((err: Error) => {
    logger.error({ err: err.message }, 'WS feed error');
  });

  adapter.onDisconnect(() => {
    logger.warn('WS feed disconnected, adapter will auto-reconnect');
    normalizer.resetSequence();
  });

  // 7. Start stats reporter
  const statsTimer = setInterval(() => {
    logStats(stats, pool);
    stats.eventsThisInterval = 0;
  }, STATS_INTERVAL_MS);

  // 8. Start the buffer flush timer
  eventBuffer.start();

  // 9. Connect WS
  logger.info('Connecting to Binance WebSocket');
  await adapter.connect();
  logger.info('Connected. Recording data...');

  // 10. Graceful shutdown
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down gracefully');

    clearInterval(statsTimer);
    eventBuffer.stop();

    // Flush remaining events
    logger.info({ buffered: eventBuffer.length }, 'Flushing remaining events');
    await eventBuffer.flush();

    // Disconnect WS
    await adapter.disconnect();

    // Close Postgres pool
    await pool.end();

    logger.info({
      totalEvents: stats.totalEvents,
      uptimeMs: Date.now() - stats.startedAt,
    }, 'Recorder stopped');

    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Only run main when executed directly (not when imported for testing)
const isDirectExecution = process.argv[1]?.endsWith('record-data.ts')
  || process.argv[1]?.endsWith('record-data.js');

if (isDirectExecution) {
  main().catch((err) => {
    logger.error({ err }, 'Fatal error in data recorder');
    process.exit(1);
  });
}

export { main };
