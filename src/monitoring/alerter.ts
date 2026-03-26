import type { Logger } from '../shared/logger.js';
import type { DomainEventBus } from '../shared/event-bus.js';

/**
 * Configuration for the alerting system.
 */
export interface AlertConfig {
  webhookUrl: string;
  cooldownMs: number; // default 300000 (5 min)
  enabled: boolean;
}

/**
 * Types of alerts the system can raise.
 */
export type AlertType =
  | 'circuit_breaker'
  | 'kill_switch'
  | 'feed_disconnect'
  | 'memory_threshold'
  | 'postgres_disconnect'
  | 'coherence_collapse'
  | 'high_latency';

/**
 * An alert record.
 */
export interface Alert {
  type: AlertType;
  severity: 'warning' | 'critical';
  message: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

const SEVERITY_COLORS: Record<Alert['severity'], string> = {
  warning: '#ffcc00',
  critical: '#ff0000',
};

/**
 * Sends alerts via webhook (Slack-compatible format) with per-type cooldowns.
 *
 * Integrates with the DomainEventBus to automatically alert on
 * circuit breaker triggers and kill switch activations.
 */
export class Alerter {
  private readonly config: AlertConfig;
  private readonly logger: Logger;
  private readonly cooldowns = new Map<AlertType, number>();
  private readonly history: Alert[] = [];
  private static readonly MAX_HISTORY = 1000;

  constructor(config: AlertConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Send an alert. Respects per-type cooldown to avoid alert storms.
   *
   * @param type - The alert category
   * @param severity - warning or critical
   * @param message - Human-readable description
   * @param metadata - Optional structured data
   */
  async alert(
    type: AlertType,
    severity: Alert['severity'],
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const alert: Alert = {
      type,
      severity,
      message,
      timestamp: new Date().toISOString(),
      metadata,
    };

    // Always record in history
    this.history.push(alert);
    if (this.history.length > Alerter.MAX_HISTORY) {
      this.history.splice(0, this.history.length - Alerter.MAX_HISTORY);
    }

    // Check if disabled
    if (!this.config.enabled) {
      this.logger.debug({ type, severity }, 'Alert suppressed (alerter disabled)');
      return;
    }

    // Check cooldown
    if (this.isInCooldown(type)) {
      this.logger.debug({ type }, 'Alert suppressed (in cooldown)');
      return;
    }

    // Set cooldown
    this.cooldowns.set(type, Date.now() + this.config.cooldownMs);

    // Send webhook
    await this.sendWebhook(alert);
  }

  /**
   * Check if an alert type is currently in cooldown.
   */
  isInCooldown(type: AlertType): boolean {
    const expiry = this.cooldowns.get(type);
    if (expiry === undefined) return false;
    if (Date.now() >= expiry) {
      this.cooldowns.delete(type);
      return false;
    }
    return true;
  }

  /**
   * Get alert history, most recent last.
   *
   * @param limit - Maximum number of alerts to return (default: 50)
   */
  getHistory(limit = 50): Alert[] {
    return this.history.slice(-limit);
  }

  /**
   * Subscribe to domain events for automatic alerting.
   *
   * Listens for:
   * - CircuitBreakerTriggered -> critical alert
   * - KillSwitchActivated -> critical alert
   */
  subscribe(eventBus: DomainEventBus): void {
    eventBus.subscribe('CircuitBreakerTriggered', (payload) => {
      void this.alert(
        'circuit_breaker',
        'critical',
        `Circuit breaker triggered: ${payload.reason}`,
        {
          reason: payload.reason,
          symbolId: payload.symbolId,
          tsNs: payload.tsNs.toString(),
        },
      );
    });

    eventBus.subscribe('KillSwitchActivated', (payload) => {
      void this.alert(
        'kill_switch',
        'critical',
        `Kill switch activated: ${payload.reason}`,
        {
          reason: payload.reason,
          operator: payload.operator,
          tsNs: payload.tsNs.toString(),
        },
      );
    });

    this.logger.info('Alerter subscribed to domain events');
  }

  /**
   * Send a Slack-compatible webhook POST.
   */
  private async sendWebhook(alert: Alert): Promise<void> {
    const severityLabel = alert.severity.toUpperCase();
    const color = SEVERITY_COLORS[alert.severity];

    const fields = [
      { title: 'Type', value: alert.type, short: true },
      { title: 'Severity', value: severityLabel, short: true },
      { title: 'Time', value: alert.timestamp, short: true },
    ];

    if (alert.metadata) {
      for (const [key, value] of Object.entries(alert.metadata)) {
        fields.push({
          title: key,
          value: String(value),
          short: true,
        });
      }
    }

    const body = {
      text: `[${severityLabel}] ${alert.message}`,
      attachments: [
        {
          color,
          fields,
        },
      ],
    };

    try {
      const response = await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        this.logger.error(
          { status: response.status, statusText: response.statusText },
          'Webhook request failed',
        );
      }
    } catch (err) {
      this.logger.error(
        { error: (err as Error).message, webhookUrl: this.config.webhookUrl },
        'Failed to send webhook alert',
      );
    }
  }
}
