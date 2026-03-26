import type { VerifiedToken } from '../shared/types.js';
import type { OrderIntent, ModifyIntent, CancelIntent } from '../policy/types.js';
import type { FillReport, OpenOrder } from './types.js';

/**
 * Abstract broker adapter interface per ADR-004 section 5.
 * All execution adapters (paper, live, replay) must implement this.
 * Methods are proof-gated via VerifiedToken.
 */
export interface BrokerAdapter {
  /** Submit a new order. Returns the assigned orderId. */
  submitOrder(intent: OrderIntent, token: VerifiedToken): Promise<string>;

  /** Modify an existing open order's price and/or quantity. */
  modifyOrder(intent: ModifyIntent, token: VerifiedToken): Promise<void>;

  /** Cancel an existing open order. */
  cancelOrder(intent: CancelIntent, token: VerifiedToken): Promise<void>;

  /** Cancel all orders and close all positions. Emergency use. */
  flattenAll(reason: string, token: VerifiedToken): Promise<void>;

  /** Poll for new fill reports since last poll. */
  pollFills(): Promise<FillReport[]>;

  /** Return snapshot of all currently open orders. */
  getOpenOrders(): OpenOrder[];
}
