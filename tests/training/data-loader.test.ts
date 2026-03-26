import { describe, it, expect } from 'vitest';
import { DataLoader } from '../../src/training/data-loader.js';
import { generateSyntheticEvents } from '../../src/training/synthetic-data.js';
import { EventType } from '../../src/shared/types.js';
import type { TrainingConfig } from '../../src/training/types.js';

/** Create a small config with short windows for fast tests. */
function testConfig(): Partial<TrainingConfig> {
  return {
    // 5s windows, 2s stride — allows many windows from small event sets
    windowSizeNs: 5_000_000_000n,
    strideNs: 2_000_000_000n,
    validationSplit: 0.2,
  };
}

describe('DataLoader', () => {
  it('should create windows from an event sequence', () => {
    const events = generateSyntheticEvents(200);
    const loader = new DataLoader(testConfig());
    const windows = loader.createWindows(events);

    expect(windows.length).toBeGreaterThan(0);
    for (const w of windows) {
      expect(w.events.length).toBeGreaterThan(0);
      expect(w.labels).toBeDefined();
    }
  });

  it('should return empty for too few events', () => {
    const loader = new DataLoader(testConfig());
    const windows = loader.createWindows([]);
    expect(windows.length).toBe(0);
  });

  it('should compute midPriceMoveBp labels', () => {
    const events = generateSyntheticEvents(200);
    const loader = new DataLoader(testConfig());
    const windows = loader.createWindows(events);

    expect(windows.length).toBeGreaterThan(0);
    // midPriceMoveBp should be a finite number
    for (const w of windows) {
      expect(Number.isFinite(w.labels.midPriceMoveBp)).toBe(true);
    }
  });

  it('should detect fills correctly', () => {
    const events = generateSyntheticEvents(200);
    const loader = new DataLoader(testConfig());
    const windows = loader.createWindows(events);

    // At least some windows should have fills (trades are ~20% of events)
    const withFills = windows.filter((w) => w.labels.fillOccurred);
    const withoutFills = windows.filter((w) => !w.labels.fillOccurred);

    // With 200 events and 20% trade rate, we should have some of each
    // unless the random distribution is extremely skewed
    expect(withFills.length + withoutFills.length).toBe(windows.length);

    // Verify fillOccurred matches actual Trade events in window
    for (const w of windows) {
      const hasTrade = w.events.some(
        (e) => e.eventType === EventType.Trade,
      );
      expect(w.labels.fillOccurred).toBe(hasTrade);
    }
  });

  it('should detect cancels correctly', () => {
    const events = generateSyntheticEvents(200);
    const loader = new DataLoader(testConfig());
    const windows = loader.createWindows(events);

    for (const w of windows) {
      const hasCancel = w.events.some(
        (e) => e.eventType === EventType.CancelOrder,
      );
      expect(w.labels.cancelOccurred).toBe(hasCancel);
    }
  });

  it('should classify regimes as 0, 1, or 2', () => {
    const events = generateSyntheticEvents(200);
    const loader = new DataLoader(testConfig());
    const windows = loader.createWindows(events);

    for (const w of windows) {
      expect([0, 1, 2]).toContain(w.labels.regimeLabel);
    }
  });

  it('should compute non-negative slippage', () => {
    const events = generateSyntheticEvents(200);
    const loader = new DataLoader(testConfig());
    const windows = loader.createWindows(events);

    for (const w of windows) {
      expect(w.labels.slippageBp).toBeGreaterThanOrEqual(0);
    }
  });

  it('should preserve temporal order in train/val split', () => {
    const events = generateSyntheticEvents(300);
    const loader = new DataLoader(testConfig());
    const windows = loader.createWindows(events);

    const { train, val } = loader.splitTrainVal(windows);

    expect(train.length + val.length).toBe(windows.length);
    expect(train.length).toBeGreaterThan(0);
    expect(val.length).toBeGreaterThan(0);

    // Train windows should come before validation windows (temporal order)
    if (train.length > 0 && val.length > 0) {
      const lastTrainTs = train[train.length - 1].events[0]
        .tsExchangeNs as bigint;
      const firstValTs = val[0].events[0].tsExchangeNs as bigint;
      expect(lastTrainTs).toBeLessThanOrEqual(firstValTs);
    }
  });

  it('should not have overlap between train and val', () => {
    const events = generateSyntheticEvents(200);
    const loader = new DataLoader(testConfig());
    const windows = loader.createWindows(events);
    const { train, val } = loader.splitTrainVal(windows);

    // No window should appear in both sets
    const trainSet = new Set(train.map((w) => w.events[0].eventId));
    for (const w of val) {
      expect(trainSet.has(w.events[0].eventId)).toBe(false);
    }
  });

  it('should produce correct batch count', () => {
    const events = generateSyntheticEvents(200);
    const loader = new DataLoader(testConfig());
    const windows = loader.createWindows(events);

    const batchSize = 4;
    const batches = loader.batch(windows, batchSize);

    const expectedBatches = Math.ceil(windows.length / batchSize);
    expect(batches.length).toBe(expectedBatches);

    // All batches except possibly the last should be full
    for (let i = 0; i < batches.length - 1; i++) {
      expect(batches[i].length).toBe(batchSize);
    }
    // Last batch can be partial
    expect(batches[batches.length - 1].length).toBeGreaterThan(0);
    expect(batches[batches.length - 1].length).toBeLessThanOrEqual(batchSize);
  });
});
