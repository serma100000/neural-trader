/**
 * validate-data.ts — Data validation script for neural-trader.
 *
 * Connects to Postgres, queries event counts, detects gaps in sequences,
 * checks timestamp monotonicity, and reports coverage statistics.
 *
 * Usage: npx tsx scripts/validate-data.ts
 */

import pg from 'pg';
import { createLogger } from '../src/shared/logger.js';

const { Pool } = pg;

const POSTGRES_URL = process.env['NT_POSTGRES_URL']
  ?? 'postgresql://nt:dev_password@localhost:5432/neural_trader';

const logger = createLogger({ component: 'validate-data' });

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

interface ValidationReport {
  totalEvents: number;
  eventsBySymbol: Map<number, number>;
  eventsByType: Map<number, number>;
  eventsByHour: Map<string, number>;
  hoursOfCoverage: number;
  gapCount: number;
  gapDetails: GapDetail[];
  monotonicityViolations: number;
  monotonicityDetails: MonotonicityDetail[];
  criticalIssues: string[];
}

interface GapDetail {
  symbolId: number;
  expectedSeq: bigint;
  actualSeq: bigint;
  tsExchangeNs: bigint;
}

interface MonotonicityDetail {
  symbolId: number;
  prevTsNs: bigint;
  currTsNs: bigint;
  seq: bigint;
}

// ---------------------------------------------------------------------------
// Validation queries
// ---------------------------------------------------------------------------

async function getTotalEvents(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ count: string }>('SELECT count(*) AS count FROM nt_event_log');
  return parseInt(result.rows[0].count, 10);
}

async function getEventsBySymbol(pool: pg.Pool): Promise<Map<number, number>> {
  const result = await pool.query<{ symbol_id: number; count: string }>(
    'SELECT symbol_id, count(*) AS count FROM nt_event_log GROUP BY symbol_id ORDER BY symbol_id',
  );
  const map = new Map<number, number>();
  for (const row of result.rows) {
    map.set(row.symbol_id, parseInt(row.count, 10));
  }
  return map;
}

async function getEventsByType(pool: pg.Pool): Promise<Map<number, number>> {
  const result = await pool.query<{ event_type: number; count: string }>(
    'SELECT event_type, count(*) AS count FROM nt_event_log GROUP BY event_type ORDER BY event_type',
  );
  const map = new Map<number, number>();
  for (const row of result.rows) {
    map.set(row.event_type, parseInt(row.count, 10));
  }
  return map;
}

async function getEventsByHour(pool: pg.Pool): Promise<Map<string, number>> {
  const result = await pool.query<{ hour_bucket: string; count: string }>(`
    SELECT
      to_char(to_timestamp(ts_exchange_ns / 1000000000), 'YYYY-MM-DD HH24:00') AS hour_bucket,
      count(*) AS count
    FROM nt_event_log
    GROUP BY hour_bucket
    ORDER BY hour_bucket
  `);
  const map = new Map<string, number>();
  for (const row of result.rows) {
    map.set(row.hour_bucket, parseInt(row.count, 10));
  }
  return map;
}

async function detectSequenceGaps(pool: pg.Pool): Promise<GapDetail[]> {
  // Get distinct symbol IDs
  const symbolResult = await pool.query<{ symbol_id: number }>(
    'SELECT DISTINCT symbol_id FROM nt_event_log ORDER BY symbol_id',
  );

  const gaps: GapDetail[] = [];

  for (const { symbol_id } of symbolResult.rows) {
    // Fetch sequences ordered by seq for this symbol
    // Use a window function to detect gaps
    const gapResult = await pool.query<{
      seq: string;
      prev_seq: string | null;
      ts_exchange_ns: string;
    }>(`
      SELECT
        seq,
        LAG(seq) OVER (ORDER BY seq) AS prev_seq,
        ts_exchange_ns
      FROM nt_event_log
      WHERE symbol_id = $1
      ORDER BY seq
    `, [symbol_id]);

    for (const row of gapResult.rows) {
      if (row.prev_seq === null) continue;
      const prevSeq = BigInt(row.prev_seq);
      const currSeq = BigInt(row.seq);
      // A gap is when the difference between consecutive seqs is > 1
      if (currSeq - prevSeq > 1n) {
        gaps.push({
          symbolId: symbol_id,
          expectedSeq: prevSeq + 1n,
          actualSeq: currSeq,
          tsExchangeNs: BigInt(row.ts_exchange_ns),
        });
      }
    }
  }

  return gaps;
}

async function checkTimestampMonotonicity(pool: pg.Pool): Promise<MonotonicityDetail[]> {
  const symbolResult = await pool.query<{ symbol_id: number }>(
    'SELECT DISTINCT symbol_id FROM nt_event_log ORDER BY symbol_id',
  );

  const violations: MonotonicityDetail[] = [];

  for (const { symbol_id } of symbolResult.rows) {
    const result = await pool.query<{
      ts_exchange_ns: string;
      prev_ts: string | null;
      seq: string;
    }>(`
      SELECT
        ts_exchange_ns,
        LAG(ts_exchange_ns) OVER (ORDER BY seq) AS prev_ts,
        seq
      FROM nt_event_log
      WHERE symbol_id = $1
      ORDER BY seq
    `, [symbol_id]);

    for (const row of result.rows) {
      if (row.prev_ts === null) continue;
      const prevTs = BigInt(row.prev_ts);
      const currTs = BigInt(row.ts_exchange_ns);
      // Timestamps should be non-decreasing within a symbol when ordered by seq
      if (currTs < prevTs) {
        violations.push({
          symbolId: symbol_id,
          prevTsNs: prevTs,
          currTsNs: currTs,
          seq: BigInt(row.seq),
        });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

const EVENT_TYPE_NAMES: Record<number, string> = {
  0: 'NewOrder',
  1: 'ModifyOrder',
  2: 'CancelOrder',
  3: 'Trade',
  4: 'BookSnapshot',
  5: 'SessionMarker',
  6: 'VenueStatus',
};

function printReport(report: ValidationReport): void {
  console.log('\n========================================');
  console.log('  Neural Trader Data Validation Report');
  console.log('========================================\n');

  console.log(`Total events: ${report.totalEvents.toLocaleString()}`);
  console.log(`Hours of coverage: ${report.hoursOfCoverage}`);
  console.log('');

  console.log('Events by symbol:');
  for (const [symbolId, count] of report.eventsBySymbol) {
    console.log(`  Symbol ${symbolId}: ${count.toLocaleString()}`);
  }
  console.log('');

  console.log('Events by type:');
  for (const [eventType, count] of report.eventsByType) {
    const name = EVENT_TYPE_NAMES[eventType] ?? `Unknown(${eventType})`;
    console.log(`  ${name}: ${count.toLocaleString()}`);
  }
  console.log('');

  console.log('Events by hour:');
  for (const [hour, count] of report.eventsByHour) {
    console.log(`  ${hour}: ${count.toLocaleString()}`);
  }
  console.log('');

  console.log(`Sequence gaps: ${report.gapCount}`);
  if (report.gapDetails.length > 0) {
    const maxShow = Math.min(report.gapDetails.length, 10);
    for (let i = 0; i < maxShow; i++) {
      const g = report.gapDetails[i];
      console.log(`  Symbol ${g.symbolId}: expected seq ${g.expectedSeq}, got ${g.actualSeq}`);
    }
    if (report.gapDetails.length > maxShow) {
      console.log(`  ... and ${report.gapDetails.length - maxShow} more`);
    }
  }
  console.log('');

  console.log(`Timestamp monotonicity violations: ${report.monotonicityViolations}`);
  if (report.monotonicityDetails.length > 0) {
    const maxShow = Math.min(report.monotonicityDetails.length, 10);
    for (let i = 0; i < maxShow; i++) {
      const v = report.monotonicityDetails[i];
      console.log(`  Symbol ${v.symbolId}: ts went from ${v.prevTsNs} to ${v.currTsNs} at seq ${v.seq}`);
    }
    if (report.monotonicityDetails.length > maxShow) {
      console.log(`  ... and ${report.monotonicityDetails.length - maxShow} more`);
    }
  }
  console.log('');

  if (report.criticalIssues.length > 0) {
    console.log('CRITICAL ISSUES:');
    for (const issue of report.criticalIssues) {
      console.log(`  [FAIL] ${issue}`);
    }
  } else {
    console.log('No critical issues found.');
  }

  console.log('\n========================================\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info({ postgresUrl: POSTGRES_URL.replace(/:[^:@]+@/, ':***@') }, 'Starting data validation');

  const pool = new Pool({ connectionString: POSTGRES_URL });
  pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected Postgres pool error');
  });

  try {
    // Check connectivity
    await pool.query('SELECT 1');
    logger.info('Connected to Postgres');

    // Run all validation queries
    logger.info('Querying event counts...');
    const [totalEvents, eventsBySymbol, eventsByType, eventsByHour] = await Promise.all([
      getTotalEvents(pool),
      getEventsBySymbol(pool),
      getEventsByType(pool),
      getEventsByHour(pool),
    ]);

    logger.info('Detecting sequence gaps...');
    const gapDetails = await detectSequenceGaps(pool);

    logger.info('Checking timestamp monotonicity...');
    const monotonicityDetails = await checkTimestampMonotonicity(pool);

    // Build report
    const criticalIssues: string[] = [];

    // Check gap rate
    if (totalEvents > 0) {
      const gapRate = gapDetails.length / totalEvents;
      if (gapRate > 0.01) {
        criticalIssues.push(
          `Gap rate is ${(gapRate * 100).toFixed(2)}% (${gapDetails.length} gaps in ${totalEvents} events) — exceeds 1% threshold`,
        );
      }
    }

    // Check for zero events
    if (totalEvents === 0) {
      criticalIssues.push('No events found in database');
    }

    // Check monotonicity violations
    if (monotonicityDetails.length > 0 && totalEvents > 0) {
      const violationRate = monotonicityDetails.length / totalEvents;
      if (violationRate > 0.01) {
        criticalIssues.push(
          `Timestamp monotonicity violation rate is ${(violationRate * 100).toFixed(2)}% — exceeds 1% threshold`,
        );
      }
    }

    const report: ValidationReport = {
      totalEvents,
      eventsBySymbol,
      eventsByType,
      eventsByHour,
      hoursOfCoverage: eventsByHour.size,
      gapCount: gapDetails.length,
      gapDetails,
      monotonicityViolations: monotonicityDetails.length,
      monotonicityDetails,
      criticalIssues,
    };

    printReport(report);

    if (criticalIssues.length > 0) {
      logger.error({ issueCount: criticalIssues.length }, 'Validation failed with critical issues');
      process.exit(1);
    }

    logger.info('Validation passed');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error in data validation');
  process.exit(1);
});
