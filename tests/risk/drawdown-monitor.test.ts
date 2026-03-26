import { describe, it, expect } from 'vitest';
import { DrawdownMonitor } from '../../src/risk/drawdown-monitor.js';

describe('DrawdownMonitor', () => {
  describe('recordPnl', () => {
    it('should track profits without triggering circuit breaker', () => {
      const monitor = new DrawdownMonitor(5, 10, 100_000);

      monitor.recordPnl(1000);
      monitor.recordPnl(2000);

      expect(monitor.getCurrentDrawdown()).toBe(0);
      expect(monitor.isCircuitBroken()).toBe(false);
    });

    it('should compute daily drawdown from high-water mark', () => {
      const monitor = new DrawdownMonitor(5, 10, 100_000);

      monitor.recordPnl(5000);  // Peak = 5000
      monitor.recordPnl(-3000); // Current = 2000, drawdown = 3000/100000 = 3%

      expect(monitor.getDailyDrawdown()).toBeCloseTo(3.0, 1);
      expect(monitor.isCircuitBroken()).toBe(false);
    });

    it('should trigger circuit breaker when daily threshold exceeded', () => {
      const monitor = new DrawdownMonitor(5, 10, 100_000);

      monitor.recordPnl(5000);  // Peak = 5000
      monitor.recordPnl(-6000); // Current = -1000, drawdown = 6000/100000 = 6% > 5%

      expect(monitor.isCircuitBroken()).toBe(true);
      expect(monitor.getBreakReason()).toContain('Daily drawdown');
    });

    it('should trigger circuit breaker when weekly threshold exceeded', () => {
      const monitor = new DrawdownMonitor(20, 5, 100_000);

      monitor.recordPnl(3000);  // Peak = 3000
      monitor.recordPnl(-9000); // Current = -6000, drawdown = 9000/100000 = 9% > 5% weekly

      expect(monitor.isCircuitBroken()).toBe(true);
      expect(monitor.getBreakReason()).toContain('Weekly drawdown');
    });

    it('should not update tracking after circuit is broken', () => {
      const monitor = new DrawdownMonitor(2, 10, 100_000);

      monitor.recordPnl(1000);
      monitor.recordPnl(-3000); // Drawdown = 3000/100000 = 3% > 2%

      expect(monitor.isCircuitBroken()).toBe(true);

      const drawdownAfterBreak = monitor.getCurrentDrawdown();
      monitor.recordPnl(100000); // This should be ignored
      expect(monitor.getCurrentDrawdown()).toBe(drawdownAfterBreak);
    });
  });

  describe('getCurrentDrawdown', () => {
    it('should return the max of daily and weekly drawdown', () => {
      const monitor = new DrawdownMonitor(10, 10, 100_000);

      monitor.recordPnl(2000);
      monitor.recordPnl(-3000);

      const daily = monitor.getDailyDrawdown();
      const weekly = monitor.getWeeklyDrawdown();
      const current = monitor.getCurrentDrawdown();

      expect(current).toBe(Math.max(daily, weekly));
    });

    it('should return 0 when no drawdown has occurred', () => {
      const monitor = new DrawdownMonitor(5, 10, 100_000);

      expect(monitor.getCurrentDrawdown()).toBe(0);
    });
  });

  describe('resetDaily', () => {
    it('should reset daily tracking but keep weekly', () => {
      const monitor = new DrawdownMonitor(10, 10, 100_000);

      monitor.recordPnl(5000);
      monitor.recordPnl(-3000); // drawdown from peak

      const weeklyBefore = monitor.getWeeklyDrawdown();

      monitor.resetDaily();

      expect(monitor.getDailyDrawdown()).toBe(0);
      expect(monitor.getWeeklyDrawdown()).toBe(weeklyBefore);
    });
  });

  describe('reset', () => {
    it('should reset all state including circuit breaker', () => {
      const monitor = new DrawdownMonitor(2, 10, 100_000);

      monitor.recordPnl(1000);
      monitor.recordPnl(-5000); // triggers circuit breaker

      expect(monitor.isCircuitBroken()).toBe(true);

      monitor.reset();

      expect(monitor.isCircuitBroken()).toBe(false);
      expect(monitor.getCurrentDrawdown()).toBe(0);
      expect(monitor.getDailyDrawdown()).toBe(0);
      expect(monitor.getWeeklyDrawdown()).toBe(0);
      expect(monitor.getBreakReason()).toBeNull();
    });
  });

  describe('rolling calculation over multiple days', () => {
    it('should correctly track drawdown across day boundaries', () => {
      const monitor = new DrawdownMonitor(5, 10, 100_000);

      // Day 1: profit
      monitor.recordPnl(3000);
      expect(monitor.getDailyDrawdown()).toBe(0);

      // Day 1: loss
      monitor.recordPnl(-2000); // peak=3000, current=1000, dd=2000/100000=2%
      expect(monitor.getDailyDrawdown()).toBeCloseTo(2.0, 1);

      // New day: reset daily but weekly accumulates
      monitor.resetDaily();
      expect(monitor.getDailyDrawdown()).toBe(0);
      expect(monitor.getWeeklyDrawdown()).toBeCloseTo(2.0, 1);

      // Day 2: more losses
      monitor.recordPnl(-4000); // weekly: peak=3000, current=-3000, dd=6000/100000=6%
      expect(monitor.getWeeklyDrawdown()).toBeCloseTo(6.0, 1);
    });
  });
});
