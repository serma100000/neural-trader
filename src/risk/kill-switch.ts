/**
 * Kill switch per ADR-004 section 7.
 *
 * A latching safety mechanism that halts all trading activity.
 * Can be activated:
 *   - Manually via API
 *   - Automatically on drawdown threshold breach
 *   - Automatically on venue health failure
 *   - Automatically on market halt
 *
 * Deactivation requires explicit human action only.
 */
export class KillSwitch {
  private active = false;
  private reason: string | null = null;
  private activatedAtNs: bigint | null = null;

  /**
   * Activate the kill switch. Latches until explicit deactivation.
   */
  activate(reason: string): void {
    if (this.active) return; // Already active, don't overwrite reason
    this.active = true;
    this.reason = reason;
    this.activatedAtNs = process.hrtime.bigint();
  }

  /**
   * Deactivate the kill switch.
   * This must only be called as a result of explicit human action.
   */
  deactivate(): void {
    this.active = false;
    this.reason = null;
    this.activatedAtNs = null;
  }

  /**
   * Check if the kill switch is currently active.
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Get the reason the kill switch was activated, or null if inactive.
   */
  getActivationReason(): string | null {
    return this.reason;
  }

  /**
   * Get the nanosecond timestamp of activation, or null if inactive.
   */
  getActivatedAt(): bigint | null {
    return this.activatedAtNs;
  }
}
