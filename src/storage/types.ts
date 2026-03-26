import type { SymbolId, Timestamp } from '../shared/types.js';

/** Replay segment stored in nt_segments */
export interface ReplaySegment {
  segmentId: bigint;
  symbolId: SymbolId;
  startTsNs: Timestamp;
  endTsNs: Timestamp;
  segmentKind: string;
  dataBlob: Buffer | null;
  signature: Buffer | null;
  witnessHash: Buffer | null;
  metadata: Record<string, unknown> | null;
}

/** Model record from nt_model_registry */
export interface ModelRecord {
  modelId: string;
  modelName: string;
  version: number;
  artifactPath: string;
  trainingHash: string;
  metrics: Record<string, unknown>;
  promotedAt: Date | null;
  retiredAt: Date | null;
  createdAt: Date;
}

/** Partition metadata from nt_partition_registry */
export interface PartitionInfo {
  tableName: string;
  partitionName: string;
  rangeStartNs: bigint;
  rangeEndNs: bigint;
  tier: 'hot' | 'warm' | 'cold';
  createdAt: Date;
  archivedAt: Date | null;
  droppedAt: Date | null;
}

/** Configuration for PgClient connection pool */
export interface PgClientConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  minConnections: number;
  maxConnections: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  ssl?: boolean;
}

/** Result of a migration run */
export interface MigrationResult {
  version: number;
  name: string;
  appliedAt: Date;
}

/** Interface for event repository operations */
export interface IEventRepository {
  batchInsert(events: import('../shared/types.js').MarketEvent[]): Promise<number>;
  queryBySymbolAndTime(
    symbolId: SymbolId,
    startNs: Timestamp,
    endNs: Timestamp,
  ): Promise<import('../shared/types.js').MarketEvent[]>;
  queryByVenueAndTime(
    venueId: import('../shared/types.js').VenueId,
    startNs: Timestamp,
    endNs: Timestamp,
  ): Promise<import('../shared/types.js').MarketEvent[]>;
  count(): Promise<number>;
}

/** Interface for segment repository operations */
export interface ISegmentRepository {
  write(
    segment: Omit<ReplaySegment, 'segmentId'>,
    coherenceDecision: import('../shared/types.js').CoherenceDecision,
  ): Promise<boolean>;
  retrieveBySymbol(symbolId: SymbolId, limit: number): Promise<ReplaySegment[]>;
  retrieveByKind(kind: string, limit: number): Promise<ReplaySegment[]>;
}

/** Interface for receipt repository operations */
export interface IReceiptRepository {
  append(receipt: import('../shared/types.js').WitnessReceipt): Promise<void>;
  queryByTimeRange(
    startNs: Timestamp,
    endNs: Timestamp,
  ): Promise<import('../shared/types.js').WitnessReceipt[]>;
  queryByModelId(modelId: string): Promise<import('../shared/types.js').WitnessReceipt[]>;
  validateChain(startNs: Timestamp, endNs: Timestamp): Promise<boolean>;
}

/** Interface for model repository operations */
export interface IModelRepository {
  register(model: Omit<ModelRecord, 'promotedAt' | 'retiredAt' | 'createdAt'>): Promise<void>;
  promote(modelId: string): Promise<void>;
  retire(modelId: string): Promise<void>;
  getActive(modelName: string): Promise<ModelRecord | null>;
  getHistory(modelName: string): Promise<ModelRecord[]>;
}
