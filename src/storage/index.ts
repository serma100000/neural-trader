// Storage bounded context - public API

export { PgClient } from './pg-client.js';
export { EventRepository } from './event-repo.js';
export { SegmentRepository } from './segment-repo.js';
export { ReceiptRepository, validateReceiptChain, computeChainHash } from './receipt-repo.js';
export { ModelRepository } from './model-repo.js';

export type {
  ReplaySegment,
  ModelRecord,
  PartitionInfo,
  PgClientConfig,
  MigrationResult,
  IEventRepository,
  ISegmentRepository,
  IReceiptRepository,
  IModelRepository,
} from './types.js';
