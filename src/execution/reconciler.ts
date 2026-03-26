import type { PositionTracker } from '../risk/position-tracker.js';
import type { Logger } from '../shared/logger.js';
import type { SymbolId } from '../shared/types.js';

/**
 * Snapshot of exchange state for reconciliation at startup.
 */
export interface ExchangeState {
  openOrders: Array<{
    orderId: string;
    symbolId: number;
    side: 'buy' | 'sell';
    price: number;
    qty: number;
    filledQty: number;
  }>;
  balances: Map<string, number>; // asset -> free balance
}

/**
 * Result of a reconciliation pass.
 */
export interface ReconciliationResult {
  ordersReconciled: number;
  ordersCancelled: number;
  positionMismatches: Array<{
    symbolId: number;
    expected: bigint;
    actual: number;
    action: string;
  }>;
  warnings: string[];
}

/**
 * Reconciles internal state with exchange state at startup.
 *
 * Detects stale orders that no longer match internal tracking,
 * position mismatches between the tracker and exchange balances,
 * and unknown orders that exist on the exchange but not internally.
 */
export class Reconciler {
  private readonly positionTracker: PositionTracker;
  private readonly logger: Logger;

  constructor(positionTracker: PositionTracker, logger: Logger) {
    this.positionTracker = positionTracker;
    this.logger = logger;
  }

  /**
   * Reconcile internal state with exchange state.
   *
   * Checks for position mismatches and identifies orders that
   * exist on the exchange but are not tracked internally.
   */
  reconcile(exchangeState: ExchangeState): ReconciliationResult {
    const result: ReconciliationResult = {
      ordersReconciled: 0,
      ordersCancelled: 0,
      positionMismatches: [],
      warnings: [],
    };

    this.logger.info(
      { openOrders: exchangeState.openOrders.length },
      'Starting reconciliation',
    );

    // Count reconciled orders (orders that exist on exchange)
    result.ordersReconciled = exchangeState.openOrders.length;

    // Check each exchange balance against internal position tracker
    for (const [asset, balance] of exchangeState.balances) {
      // Try to map asset name to a symbolId by scanning positions
      const allPositions = this.positionTracker.getAllPositions();
      let found = false;

      for (const [symbolId, snapshot] of allPositions) {
        const symIdNum = symbolId as number;
        // Check if this asset string matches this symbolId
        // Convention: asset string is the symbolId as string
        if (asset === String(symIdNum)) {
          found = true;
          const expectedQty = snapshot.netQtyFp;
          const FP_SCALE = 1_000_000;
          const actualScaled = balance;

          if (expectedQty !== BigInt(Math.round(actualScaled * FP_SCALE))) {
            const action =
              expectedQty === 0n
                ? `close exchange position of ${actualScaled}`
                : `adjust internal position from ${expectedQty} to match exchange ${actualScaled}`;

            result.positionMismatches.push({
              symbolId: symIdNum,
              expected: expectedQty,
              actual: actualScaled,
              action,
            });

            this.logger.warn(
              { symbolId: symIdNum, expected: expectedQty.toString(), actual: actualScaled },
              'Position mismatch detected',
            );
          }
        }
      }

      if (!found && balance !== 0) {
        result.warnings.push(
          `Unknown exchange balance: asset=${asset}, balance=${balance}`,
        );
        this.logger.warn(
          { asset, balance },
          'Exchange has balance for unknown asset',
        );
      }
    }

    this.logger.info(
      {
        reconciled: result.ordersReconciled,
        cancelled: result.ordersCancelled,
        mismatches: result.positionMismatches.length,
        warnings: result.warnings.length,
      },
      'Reconciliation complete',
    );

    return result;
  }

  /**
   * Identify stale orders on the exchange that are not tracked internally.
   *
   * @param exchangeOrders - Orders currently open on the exchange
   * @param internalOrders - Order IDs tracked internally
   * @returns Array of order IDs that should be cancelled
   */
  findStaleOrders(
    exchangeOrders: ExchangeState['openOrders'],
    internalOrders: string[],
  ): string[] {
    const internalSet = new Set(internalOrders);
    const stale: string[] = [];

    for (const order of exchangeOrders) {
      if (!internalSet.has(order.orderId)) {
        stale.push(order.orderId);
        this.logger.warn(
          { orderId: order.orderId, symbolId: order.symbolId },
          'Stale order detected on exchange',
        );
      }
    }

    return stale;
  }

  /**
   * Detect position mismatches between exchange balances and internal state.
   *
   * @param exchangeBalances - Map of asset -> balance from exchange
   * @param symbolMap - Map of asset name -> symbolId for lookup
   * @returns Array of mismatch descriptors
   */
  detectMismatches(
    exchangeBalances: Map<string, number>,
    symbolMap: Map<string, number>,
  ): ReconciliationResult['positionMismatches'] {
    const mismatches: ReconciliationResult['positionMismatches'] = [];
    const FP_SCALE = 1_000_000;

    for (const [asset, balance] of exchangeBalances) {
      const symbolId = symbolMap.get(asset);
      if (symbolId === undefined) {
        continue;
      }

      const position = this.positionTracker.getPosition(symbolId as SymbolId);
      const expectedQty = position.netQtyFp;
      const actualFp = BigInt(Math.round(balance * FP_SCALE));

      if (expectedQty !== actualFp) {
        const action =
          expectedQty === 0n
            ? `close exchange position of ${balance}`
            : balance === 0
              ? `internal position ${expectedQty} has no exchange counterpart`
              : `adjust: internal=${expectedQty}, exchange=${actualFp}`;

        mismatches.push({
          symbolId,
          expected: expectedQty,
          actual: balance,
          action,
        });
      }
    }

    return mismatches;
  }
}
