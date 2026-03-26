import type {
  CoherenceDecision,
  SymbolId,
  VenueId,
  Side,
  Timestamp,
} from '../shared/types.js';
import type { ModelOutput } from '../gnn/types.js';

// --- Policy Input ---

export interface PolicyInput {
  coherence: CoherenceDecision;
  modelOutput: ModelOutput;
  position: PositionSnapshot;
  riskBudget: RiskBudgetSnapshot;
  venueState: VenueState;
  tsNs: bigint;
}

// --- Action Decisions ---

export type ActionDecision =
  | { type: 'place'; intent: OrderIntent }
  | { type: 'modify'; intent: ModifyIntent }
  | { type: 'cancel'; intent: CancelIntent }
  | { type: 'hold'; reason: HoldReason }
  | { type: 'throttle'; resumeAfterNs: bigint; reason: string }
  | { type: 'emergency_flatten'; reason: string };

export interface OrderIntent {
  symbolId: SymbolId;
  venueId: VenueId;
  side: Side;
  priceFp: bigint;
  qtyFp: bigint;
  orderType: 'limit' | 'marketable_limit' | 'ioc';
  timeInForce: 'day' | 'gtc' | 'fok';
}

export interface ModifyIntent {
  orderIdHash: string;
  newPriceFp?: bigint;
  newQtyFp?: bigint;
}

export interface CancelIntent {
  orderIdHash: string;
  reason: string;
}

export interface HoldReason {
  ruleName: string;
  detail: string;
}

// --- Venue State ---

export interface VenueState {
  venueId: VenueId;
  isHalted: boolean;
  isHealthy: boolean;
  lastHeartbeatNs: bigint;
}

// --- Position Snapshot ---

export interface PositionSnapshot {
  symbolId: SymbolId;
  netQtyFp: bigint;
  avgEntryPriceFp: bigint;
  realizedPnlFp: bigint;
  unrealizedPnlFp: bigint;
  openOrderCount: number;
  lastFillTsNs: bigint;
}

// --- Risk Budget ---

export interface RiskBudgetSnapshot {
  totalNotionalUsed: number;
  perSymbolNotional: Map<SymbolId, number>;
  rollingOrderRate: number;
  rollingCancelRate: number;
  cumulativeSlippageBp: number;
  sessionDrawdownPct: number;
}

export interface RiskBudgetConfig {
  maxNotionalUsd: number;
  maxSymbolNotionalUsd: number;
  maxSectorCorrelation: number;
  maxOrderRatePerSec: number;
  maxCancelRatePerSec: number;
  maxSlippageBp: number;
  rateThrottleFraction: number;
  maxDrawdownPct: number;
  maxWeeklyDrawdownPct: number;
}

// --- Circuit Breaker ---

export interface CircuitBreakerConfig {
  dailyDrawdownPct: number;
  weeklyDrawdownPct: number;
  venueHeartbeatTimeoutNs: bigint;
  maxConsecutiveErrors: number;
}

// --- Control Head Names (convention) ---

export const CONTROL_HEADS = {
  PLACE_SIGNAL: 'place_signal',
  MODIFY_SIGNAL: 'modify_signal',
  CANCEL_SIGNAL: 'cancel_signal',
  SIDE_SIGNAL: 'side_signal',
  SIZE_SIGNAL: 'size_signal',
  URGENCY_SIGNAL: 'urgency_signal',
  REGIME_UNCERTAINTY: 'regime_uncertainty',
  ADVERSARIAL_DRIFT: 'adversarial_drift',
} as const;
