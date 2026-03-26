import type { LivePipeline } from './live-pipeline.js';
import type { OrderManager } from '../execution/order-manager.js';
import type { KillSwitch } from '../risk/kill-switch.js';
import type { Logger } from '../shared/logger.js';
import type { VerifiedToken, Timestamp } from '../shared/types.js';

const GRACEFUL_TIMEOUT_MS = 30_000;
const FILL_WAIT_MS = 5_000;
const FILL_POLL_INTERVAL_MS = 250;

/**
 * Creates a dummy VerifiedToken for emergency shutdown operations.
 * Shutdown is a system-level action that bypasses normal proof gates.
 */
function makeShutdownToken(): VerifiedToken {
  return {
    tokenId: 'shutdown-emergency',
    tsNs: (BigInt(Date.now()) * 1_000_000n) as Timestamp,
    coherenceHash: 'shutdown',
    policyHash: 'shutdown',
    actionIntent: 'emergency_flatten',
  };
}

/**
 * Handles graceful shutdown of the neural trader system.
 *
 * Shutdown sequence:
 * 1. Set shutting-down flag (reject new events)
 * 2. Activate kill switch with reason
 * 3. Cancel all open orders via OrderManager
 * 4. Wait up to 5s for pending fills
 * 5. Stop the pipeline (flushes internal state)
 * 6. Log final position state
 * 7. Exit with code 0
 *
 * Force exit after 30s if graceful shutdown stalls.
 */
export class ShutdownHandler {
  private readonly pipeline: LivePipeline;
  private readonly orderManager: OrderManager;
  private readonly killSwitch: KillSwitch;
  private readonly logger: Logger;
  private shuttingDown = false;
  private forceExitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    pipeline: LivePipeline,
    orderManager: OrderManager,
    killSwitch: KillSwitch,
    logger: Logger,
  ) {
    this.pipeline = pipeline;
    this.orderManager = orderManager;
    this.killSwitch = killSwitch;
    this.logger = logger;
  }

  /**
   * Register SIGTERM and SIGINT handlers for graceful shutdown.
   */
  register(): void {
    const handler = (signal: string): void => {
      this.logger.info({ signal }, 'Received shutdown signal');
      void this.shutdown(`Signal: ${signal}`);
    };

    process.on('SIGTERM', () => handler('SIGTERM'));
    process.on('SIGINT', () => handler('SIGINT'));

    this.logger.info('Shutdown handlers registered');
  }

  /**
   * Perform the graceful shutdown sequence.
   */
  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) {
      this.logger.warn('Shutdown already in progress, ignoring');
      return;
    }

    this.shuttingDown = true;
    this.logger.info({ reason }, 'Starting graceful shutdown');

    // Set force exit timer
    this.forceExitTimer = setTimeout(() => {
      this.logger.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, GRACEFUL_TIMEOUT_MS);

    // Prevent timer from keeping the process alive if everything else completes
    if (this.forceExitTimer.unref) {
      this.forceExitTimer.unref();
    }

    try {
      // Step 1: Already set shuttingDown flag above

      // Step 2: Activate kill switch
      this.killSwitch.activate(`Shutdown: ${reason}`);
      this.logger.info('Kill switch activated');

      // Step 3: Cancel all open orders
      const token = makeShutdownToken();
      await this.orderManager.cancelAll(reason, token);
      this.logger.info('All orders cancelled');

      // Step 4: Wait up to 5s for pending fills
      await this.waitForPendingFills();

      // Step 5: Stop the pipeline
      await this.pipeline.stop();
      this.logger.info('Pipeline stopped');

      // Step 6: Log final position state
      const positionTracker = this.pipeline.getPositionTracker();
      const allPositions = positionTracker.getAllPositions();
      for (const [symbolId, pos] of allPositions) {
        this.logger.info(
          {
            symbolId,
            netQty: pos.netQtyFp.toString(),
            realizedPnl: pos.realizedPnlFp.toString(),
          },
          'Final position state',
        );
      }

      this.logger.info('Graceful shutdown complete');
    } catch (err) {
      this.logger.error(
        { error: (err as Error).message },
        'Error during shutdown',
      );
    } finally {
      // Clear the force exit timer
      if (this.forceExitTimer !== null) {
        clearTimeout(this.forceExitTimer);
        this.forceExitTimer = null;
      }

      // Step 7: Exit
      process.exit(0);
    }
  }

  /**
   * Check if shutdown is in progress.
   */
  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /**
   * Wait up to FILL_WAIT_MS for pending fills to arrive.
   */
  private async waitForPendingFills(): Promise<void> {
    const deadline = Date.now() + FILL_WAIT_MS;
    let fillCount = 0;

    while (Date.now() < deadline) {
      const fills = await this.orderManager.processFills();
      fillCount += fills.length;

      if (fills.length === 0) {
        // No more fills arriving, we can stop waiting
        break;
      }

      await new Promise<void>((resolve) =>
        setTimeout(resolve, FILL_POLL_INTERVAL_MS),
      );
    }

    if (fillCount > 0) {
      this.logger.info({ fillCount }, 'Processed remaining fills during shutdown');
    }
  }
}
