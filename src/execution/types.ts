import type { SymbolId, VenueId, Side } from '../shared/types.js';

// --- Fill Reports ---

export type FillReport =
  | { type: 'filled'; fillPriceFp: bigint; fillQtyFp: bigint; tsNs: bigint }
  | {
      type: 'partial_fill';
      fillPriceFp: bigint;
      fillQtyFp: bigint;
      remainingQtyFp: bigint;
      tsNs: bigint;
    }
  | { type: 'rejected'; reason: string; tsNs: bigint }
  | { type: 'cancelled'; tsNs: bigint };

// --- Open Order ---

export interface OpenOrder {
  orderId: string;
  symbolId: SymbolId;
  venueId: VenueId;
  side: Side;
  priceFp: bigint;
  qtyFp: bigint;
  filledQtyFp: bigint;
  status: 'pending' | 'open' | 'partial' | 'filled' | 'cancelled';
  createdAtNs: bigint;
  tokenId: string;
}

// --- Execution Statistics ---

export interface ExecutionStats {
  totalOrders: number;
  totalFills: number;
  totalCancels: number;
  avgFillLatencyMs: number;
  totalSlippageBp: number;
}

// --- Paper Adapter Configuration ---

export interface PaperAdapterConfig {
  /** Simulated fill latency in milliseconds (default: 50) */
  fillLatencyMs: number;
  /** Probability of a partial fill between 0 and 1 (default: 0.2) */
  partialFillProbability: number;
  /** Slippage standard deviation in basis points (default: 0.5) */
  slippageStdBp: number;
  /** Slippage mean in basis points (default: 0) */
  slippageMeanBp: number;
  /** Random seed for deterministic testing (optional) */
  seed?: number;
}

export const DEFAULT_PAPER_CONFIG: PaperAdapterConfig = {
  fillLatencyMs: 50,
  partialFillProbability: 0.2,
  slippageStdBp: 0.5,
  slippageMeanBp: 0,
};
