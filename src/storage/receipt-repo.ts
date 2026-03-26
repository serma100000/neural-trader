import { createHash } from 'node:crypto';
import { createLogger, type Logger } from '../shared/logger.js';
import type { Timestamp, WitnessReceipt } from '../shared/types.js';
import type { PgClient } from './pg-client.js';
import type { IReceiptRepository } from './types.js';

/**
 * ReceiptRepository: manages nt_policy_receipts for audit trail
 * with hash chain validation.
 */
export class ReceiptRepository implements IReceiptRepository {
  private readonly log: Logger;

  constructor(private readonly pg: PgClient) {
    this.log = createLogger({ component: 'ReceiptRepository' });
  }

  /**
   * Append a witness receipt to the policy receipts table.
   */
  async append(receipt: WitnessReceipt): Promise<void> {
    await this.pg.query(
      `INSERT INTO nt_policy_receipts (
        ts_ns, model_id, action_type, input_hash,
        coherence_hash, policy_hash, token_id, result_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        BigInt(receipt.tsNs).toString(),
        receipt.modelId,
        receipt.actionIntent,
        receipt.inputSegmentHash,
        receipt.coherenceWitnessHash,
        receipt.policyHash,
        receipt.verifiedTokenId,
        receipt.resultingStateHash,
      ],
    );
    this.log.debug({ modelId: receipt.modelId }, 'Receipt appended');
  }

  /**
   * Query receipts within a nanosecond time range, ordered by timestamp.
   */
  async queryByTimeRange(startNs: Timestamp, endNs: Timestamp): Promise<WitnessReceipt[]> {
    const result = await this.pg.query<ReceiptRow>(
      `SELECT * FROM nt_policy_receipts
       WHERE ts_ns >= $1 AND ts_ns < $2
       ORDER BY ts_ns, receipt_id`,
      [BigInt(startNs).toString(), BigInt(endNs).toString()],
    );
    return result.rows.map(rowToReceipt);
  }

  /**
   * Query all receipts for a given model, ordered by timestamp.
   */
  async queryByModelId(modelId: string): Promise<WitnessReceipt[]> {
    const result = await this.pg.query<ReceiptRow>(
      `SELECT * FROM nt_policy_receipts
       WHERE model_id = $1
       ORDER BY ts_ns, receipt_id`,
      [modelId],
    );
    return result.rows.map(rowToReceipt);
  }

  /**
   * Validate the hash chain integrity for receipts in a time range.
   * Each receipt's result_hash should chain into the next receipt's input_hash.
   * Returns true if the chain is valid (or empty).
   */
  async validateChain(startNs: Timestamp, endNs: Timestamp): Promise<boolean> {
    const receipts = await this.queryByTimeRange(startNs, endNs);
    return validateReceiptChain(receipts);
  }
}

/**
 * Validate that a sequence of receipts forms a valid hash chain.
 * Each receipt's resultingStateHash should match the next receipt's inputSegmentHash.
 */
export function validateReceiptChain(receipts: WitnessReceipt[]): boolean {
  if (receipts.length <= 1) return true;

  for (let i = 0; i < receipts.length - 1; i++) {
    const current = receipts[i];
    const next = receipts[i + 1];

    // Chain: current result hash should be the basis for next input hash
    const expectedInputHash = computeChainHash(
      current.resultingStateHash,
      current.coherenceWitnessHash,
    );

    if (next.inputSegmentHash !== expectedInputHash) {
      return false;
    }
  }
  return true;
}

/**
 * Compute a chain hash from the previous result and coherence hashes.
 */
export function computeChainHash(resultHash: string, coherenceHash: string): string {
  return createHash('sha256')
    .update(resultHash)
    .update(coherenceHash)
    .digest('hex');
}

/** Raw row from nt_policy_receipts */
interface ReceiptRow {
  receipt_id: string;
  ts_ns: string;
  model_id: string;
  action_type: string;
  input_hash: string;
  coherence_hash: string;
  policy_hash: string;
  token_id: string;
  result_hash: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/** Convert a database row to a WitnessReceipt */
function rowToReceipt(row: ReceiptRow): WitnessReceipt {
  return {
    tsNs: BigInt(row.ts_ns) as Timestamp,
    modelId: row.model_id,
    inputSegmentHash: row.input_hash,
    coherenceWitnessHash: row.coherence_hash,
    policyHash: row.policy_hash,
    actionIntent: row.action_type,
    verifiedTokenId: row.token_id,
    resultingStateHash: row.result_hash,
  };
}

export { rowToReceipt, type ReceiptRow };
