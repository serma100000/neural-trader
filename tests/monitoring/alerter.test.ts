import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Alerter, type AlertConfig } from '../../src/monitoring/alerter.js';
import { createEventBus, type DomainEventBus } from '../../src/shared/event-bus.js';
import type { Logger } from '../../src/shared/logger.js';

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
  } as unknown as Logger;
}

describe('Alerter', () => {
  let alerter: Alerter;
  let logger: Logger;
  let config: AlertConfig;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });

    logger = createMockLogger();
    config = {
      webhookUrl: 'https://hooks.slack.com/test',
      cooldownMs: 300_000, // 5 minutes
      enabled: true,
    };

    alerter = new Alerter(config, logger);

    // Mock global fetch
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should send webhook on alert', async () => {
    await alerter.alert('circuit_breaker', 'critical', 'Drawdown exceeded 2%');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://hooks.slack.com/test',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(body.text).toContain('[CRITICAL]');
    expect(body.text).toContain('Drawdown exceeded 2%');
    expect(body.attachments[0].color).toBe('#ff0000');
  });

  it('should respect cooldown (second alert within cooldown is suppressed)', async () => {
    await alerter.alert('circuit_breaker', 'critical', 'First alert');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second alert of same type within cooldown
    await alerter.alert('circuit_breaker', 'critical', 'Second alert');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // Still 1, suppressed

    // Advance past cooldown
    vi.advanceTimersByTime(300_001);

    await alerter.alert('circuit_breaker', 'critical', 'Third alert');
    expect(fetchSpy).toHaveBeenCalledTimes(2); // Now 2
  });

  it('should track alert history', async () => {
    await alerter.alert('circuit_breaker', 'critical', 'Alert 1');
    await alerter.alert('kill_switch', 'critical', 'Alert 2');

    const history = alerter.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0]!.type).toBe('circuit_breaker');
    expect(history[1]!.type).toBe('kill_switch');
  });

  it('should have independent cooldowns per alert type', async () => {
    await alerter.alert('circuit_breaker', 'critical', 'CB alert');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Different type should not be affected by circuit_breaker cooldown
    await alerter.alert('kill_switch', 'critical', 'KS alert');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('should not send when disabled', async () => {
    const disabledConfig: AlertConfig = {
      webhookUrl: 'https://hooks.slack.com/test',
      cooldownMs: 300_000,
      enabled: false,
    };
    const disabledAlerter = new Alerter(disabledConfig, logger);

    await disabledAlerter.alert('circuit_breaker', 'critical', 'Should not send');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should still record history when disabled', async () => {
    const disabledConfig: AlertConfig = {
      webhookUrl: 'https://hooks.slack.com/test',
      cooldownMs: 300_000,
      enabled: false,
    };
    const disabledAlerter = new Alerter(disabledConfig, logger);

    await disabledAlerter.alert('circuit_breaker', 'critical', 'Recorded but not sent');

    const history = disabledAlerter.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.message).toBe('Recorded but not sent');
  });

  it('should include metadata in webhook payload', async () => {
    await alerter.alert('high_latency', 'warning', 'Latency spike', {
      latencyMs: 500,
      threshold: 100,
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    const fields = body.attachments[0].fields;
    const latencyField = fields.find(
      (f: { title: string }) => f.title === 'latencyMs',
    );
    expect(latencyField).toBeDefined();
    expect(latencyField.value).toBe('500');
  });

  describe('subscribe', () => {
    let eventBus: DomainEventBus;

    beforeEach(() => {
      eventBus = createEventBus();
      alerter.subscribe(eventBus);
    });

    it('should alert on CircuitBreakerTriggered event', async () => {
      eventBus.publish('CircuitBreakerTriggered', {
        reason: 'daily drawdown exceeded 2%',
        tsNs: 1000n,
      });

      // Let microtask queue flush
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
      expect(body.text).toContain('Circuit breaker triggered');
    });

    it('should alert on KillSwitchActivated event', async () => {
      eventBus.publish('KillSwitchActivated', {
        reason: 'manual activation',
        operator: 'admin',
        tsNs: 2000n,
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
      expect(body.text).toContain('Kill switch activated');
    });
  });
});
