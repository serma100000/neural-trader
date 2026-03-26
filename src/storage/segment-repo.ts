import { createLogger, type Logger } from '../shared/logger.js';
import type { CoherenceDecision, SymbolId, Timestamp } from '../shared/types.js';
import type { PgClient } from './pg-client.js';
import type { ISegmentRepository, ReplaySegment } from './types.js';

/** One day in nanoseconds for segment partitioning */
const DAY_NS = BigInt(86_400_000_000_000);

/**
 * SegmentRepository: manages nt_segments with coherence-gated writes
 * and daily range partitions.
 */
export class SegmentRepository implements ISegmentRepository {
  private readonly log: Logger;
  private readonly createdPartitions = new Set<string>();

  constructor(private readonly pg: PgClient) {
    this.log = createLogger({ component: 'SegmentRepository' });
  }

  /**
   * Write a segment to storage, gated by coherence decision.
   * Returns true if the write was allowed and succeeded, false if blocked.
   */
  async write(
    segment: Omit<ReplaySegment, 'segmentId'>,
    coherenceDecision: CoherenceDecision,
  ): Promise<boolean> {
    if (!coherenceDecision.allowWrite) {
      this.log.warn(
        { reasons: coherenceDecision.reasons, symbolId: segment.symbolId },
        'Segment write blocked by coherence gate',
      );
      return false;
    }

    await this.ensurePartition(BigInt(segment.startTsNs));

    const result = await this.pg.query(
      `INSERT INTO nt_segments (
        symbol_id, start_ts_ns, end_ts_ns, segment_kind,
        data_blob, signature, witness_hash, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING segment_id`,
      [
        segment.symbolId,
        BigInt(segment.startTsNs).toString(),
        BigInt(segment.endTsNs).toString(),
        segment.segmentKind,
        segment.dataBlob,
        segment.signature,
        segment.witnessHash,
        segment.metadata ? JSON.stringify(segment.metadata) : null,
      ],
    );

    const segmentId = result.rows[0]?.segment_id;
    this.log.info({ segmentId, symbolId: segment.symbolId }, 'Segment written');
    return true;
  }

  /**
   * Retrieve segments for a given symbol, ordered by start time descending.
   */
  async retrieveBySymbol(symbolId: SymbolId, limit: number): Promise<ReplaySegment[]> {
    const result = await this.pg.query<SegmentRow>(
      `SELECT * FROM nt_segments
       WHERE symbol_id = $1
       ORDER BY start_ts_ns DESC
       LIMIT $2`,
      [symbolId, limit],
    );
    return result.rows.map(rowToSegment);
  }

  /**
   * Retrieve segments of a specific kind, ordered by start time descending.
   */
  async retrieveByKind(kind: string, limit: number): Promise<ReplaySegment[]> {
    const result = await this.pg.query<SegmentRow>(
      `SELECT * FROM nt_segments
       WHERE segment_kind = $1
       ORDER BY start_ts_ns DESC
       LIMIT $2`,
      [kind, limit],
    );
    return result.rows.map(rowToSegment);
  }

  /**
   * Ensure a daily partition exists for the given timestamp.
   */
  private async ensurePartition(tsNs: bigint): Promise<void> {
    const dayBucket = (tsNs / DAY_NS) * DAY_NS;
    const partitionName = `nt_segments_${dayBucket}`;

    if (this.createdPartitions.has(partitionName)) return;

    const rangeEnd = dayBucket + DAY_NS;

    try {
      await this.pg.query(`
        CREATE TABLE IF NOT EXISTS ${partitionName}
        PARTITION OF nt_segments
        FOR VALUES FROM ('${dayBucket}') TO ('${rangeEnd}')
      `);

      await this.pg.query(
        `INSERT INTO nt_partition_registry (table_name, partition_name, range_start_ns, range_end_ns, tier)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (partition_name) DO NOTHING`,
        ['nt_segments', partitionName, dayBucket.toString(), rangeEnd.toString(), 'hot'],
      );

      this.createdPartitions.add(partitionName);
      this.log.info({ partitionName }, 'Segment partition created');
    } catch (err) {
      if (String(err).includes('already exists')) {
        this.createdPartitions.add(partitionName);
      } else {
        throw err;
      }
    }
  }
}

/** Raw row from nt_segments */
interface SegmentRow {
  segment_id: string;
  symbol_id: number;
  start_ts_ns: string;
  end_ts_ns: string;
  segment_kind: string;
  data_blob: Buffer | null;
  signature: Buffer | null;
  witness_hash: Buffer | null;
  metadata: Record<string, unknown> | null;
}

/** Convert a database row to a ReplaySegment */
function rowToSegment(row: SegmentRow): ReplaySegment {
  return {
    segmentId: BigInt(row.segment_id),
    symbolId: row.symbol_id as SymbolId,
    startTsNs: BigInt(row.start_ts_ns) as Timestamp,
    endTsNs: BigInt(row.end_ts_ns) as Timestamp,
    segmentKind: row.segment_kind,
    dataBlob: row.data_blob,
    signature: row.signature,
    witnessHash: row.witness_hash,
    metadata: row.metadata,
  };
}

export { rowToSegment, type SegmentRow };
