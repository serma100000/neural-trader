import type { CircuitBreakerConfig, VenueState } from '../policy/types.js';
import type { DrawdownMonitor } from './drawdown-monitor.js';

/**
 * Circuit breaker that evaluates multiple conditions and latches
 * into an active state when triggered.
 *
 * Once activated, the circuit breaker can only be deactivated by
 * explicit human action (never automatically).
 */
export class CircuitBreaker {
  private readonly config: CircuitBreakerConfig;
  private active = false;
  private activationReason: string | null = null;
  private activatedAtNs: bigint | null = null;
  private consecutiveErrors = 0;

  constructor(config: CircuitBreakerConfig) {
    this.config = config;
  }

  /**
   * Evaluate whether the circuit breaker should trigger based on
   * drawdown state and venue health.
   */
  evaluate(
    drawdown: DrawdownMonitor,
    venueState: VenueState,
  ): { triggered: boolean; reason?: string } {
    if (this.active) {
      return { triggered: true, reason: this.activationReason ?? 'Previously activated' };
    }

    // Check drawdown thresholds
    if (drawdown.isCircuitBroken()) {
      const reason = drawdown.getBreakReason() ?? 'Drawdown threshold exceeded';
      this.activate(reason);
      return { triggered: true, reason };
    }

    // Check venue health
    if (!venueState.isHealthy) {
      const reason = `Venue ${venueState.venueId} is unhealthy`;
      this.activate(reason);
      return { triggered: true, reason };
    }

    if (venueState.isHalted) {
      const reason = `Venue ${venueState.venueId} is halted`;
      this.activate(reason);
      return { triggered: true, reason };
    }

    return { triggered: false };
  }

  /**
   * Manually activate the circuit breaker.
   */
  activate(reason: string): void {
    if (this.active) return;
    this.active = true;
    this.activationReason = reason;
    this.activatedAtNs = process.hrtime.bigint();
  }

  /**
   * Check if the circuit breaker is currently active.
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Get the activation reason.
   */
  getActivationReason(): string | null {
    return this.activationReason;
  }

  /**
   * Deactivate the circuit breaker. Requires explicit human action.
   */
  deactivate(): void {
    this.active = false;
    this.activationReason = null;
    this.activatedAtNs = null;
    this.consecutiveErrors = 0;
  }

  /**
   * Record a consecutive error. Triggers circuit breaker if threshold reached.
   */
  recordError(): { triggered: boolean; reason?: string } {
    this.consecutiveErrors += 1;
    if (this.consecutiveErrors >= this.config.maxConsecutiveErrors) {
      const reason = `${this.consecutiveErrors} consecutive errors >= max ${this.config.maxConsecutiveErrors}`;
      this.activate(reason);
      return { triggered: true, reason };
    }
    return { triggered: false };
  }

  /**
   * Reset the consecutive error counter (call on successful operation).
   */
  clearErrors(): void {
    this.consecutiveErrors = 0;
  }
}
