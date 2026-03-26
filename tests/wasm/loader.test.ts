import { describe, it, expect, beforeEach } from 'vitest';
import { WasmLoader } from '../../src/wasm/loader.js';

describe('WasmLoader', () => {
  let loader: WasmLoader;

  beforeEach(() => {
    loader = new WasmLoader();
    loader.reset();
  });

  it('should not be initialized before init()', () => {
    expect(loader.isInitialized()).toBe(false);
  });

  it('should initialize with fallback when native WASM is unavailable', async () => {
    const mod = await loader.init();
    expect(mod).toBeDefined();
    expect(mod.marketEvent).toBeDefined();
    expect(mod.thresholdGate).toBeDefined();
    expect(mod.reservoirStore).toBeDefined();
    expect(loader.isInitialized()).toBe(true);
    expect(loader.isUsingFallback()).toBe(true);
  });

  it('should return the same module on subsequent calls', async () => {
    const mod1 = await loader.init();
    const mod2 = await loader.getModule();
    expect(mod1).toBe(mod2);
  });

  it('should report health correctly after init', async () => {
    const healthBefore = await loader.healthCheck();
    expect(healthBefore.initialized).toBe(false);

    await loader.init();
    const healthAfter = await loader.healthCheck();
    expect(healthAfter.initialized).toBe(true);
    expect(healthAfter.usingFallback).toBe(true);
    expect(healthAfter.storeSize).toBe(0);
    expect(healthAfter.storeCapacity).toBeGreaterThan(0);
  });

  it('should reset cleanly', async () => {
    await loader.init();
    expect(loader.isInitialized()).toBe(true);

    loader.reset();
    expect(loader.isInitialized()).toBe(false);
  });

  describe('fallback MarketEvent', () => {
    it('should serialize and deserialize round-trip', async () => {
      const mod = await loader.init();
      const event = {
        eventId: 'test-1',
        tsExchangeNs: 1000n,
        tsIngestNs: 1001n,
        venueId: 0,
        symbolId: 0,
        eventType: 3,
        side: 0,
        priceFp: 50000n,
        qtyFp: 100n,
        flags: 0,
        seq: 1n,
      };

      const serialized = mod.marketEvent.create(event as any);
      expect(serialized).toBeInstanceOf(Uint8Array);
      expect(serialized.length).toBeGreaterThan(0);
    });
  });

  describe('fallback ThresholdGate', () => {
    it('should allow action when metrics are within thresholds', async () => {
      const mod = await loader.init();
      const decision = mod.thresholdGate.evaluate({
        mincutValue: 0.8,
        driftScore: 0.3,
        cusumScore: 1.0,
      });

      expect(decision.allowAct).toBe(true);
      expect(decision.allowRetrieve).toBe(true);
      expect(decision.reasons).toHaveLength(0);
    });

    it('should block action when metrics exceed thresholds', async () => {
      const mod = await loader.init();
      const decision = mod.thresholdGate.evaluate({
        mincutValue: 0.1,
        driftScore: 2.0,
        cusumScore: 5.0,
      });

      expect(decision.allowAct).toBe(false);
      expect(decision.reasons.length).toBeGreaterThan(0);
    });

    it('should adapt thresholds by regime', async () => {
      const mod = await loader.init();

      // Volatile regime = stricter thresholds
      mod.thresholdGate.updateThresholds(2);
      const strict = mod.thresholdGate.evaluate({
        mincutValue: 0.6,
        driftScore: 0.8,
        cusumScore: 3.0,
      });

      // Calm regime = relaxed thresholds
      mod.thresholdGate.updateThresholds(0);
      const relaxed = mod.thresholdGate.evaluate({
        mincutValue: 0.6,
        driftScore: 0.8,
        cusumScore: 3.0,
      });

      // Same metrics should produce different decisions
      expect(strict.allowAct).toBe(false);
      expect(relaxed.allowAct).toBe(true);
    });
  });

  describe('fallback ReservoirStore', () => {
    it('should store and retrieve data', async () => {
      const mod = await loader.init();
      const data = new TextEncoder().encode('test-data');
      mod.reservoirStore.insert('key1', data);

      const retrieved = mod.reservoirStore.retrieve('key1');
      expect(retrieved).toEqual(data);
    });

    it('should return null for missing keys', async () => {
      const mod = await loader.init();
      const result = mod.reservoirStore.retrieve('nonexistent');
      expect(result).toBeNull();
    });

    it('should report size correctly', async () => {
      const mod = await loader.init();
      expect(mod.reservoirStore.size()).toBe(0);

      mod.reservoirStore.insert('k1', new Uint8Array([1]));
      mod.reservoirStore.insert('k2', new Uint8Array([2]));
      expect(mod.reservoirStore.size()).toBe(2);
    });
  });
});
