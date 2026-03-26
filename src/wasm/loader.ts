import { WasmInitError } from '../shared/errors.js';
import { createLogger } from '../shared/logger.js';
import type { MarketEvent, CoherenceDecision } from '../shared/types.js';

const logger = createLogger({ component: 'wasm-loader' });

export interface WasmMarketEvent {
  create(event: MarketEvent): Uint8Array;
  deserialize(data: Uint8Array): MarketEvent;
}

export interface WasmThresholdGate {
  evaluate(metrics: {
    mincutValue: number;
    driftScore: number;
    cusumScore: number;
  }): CoherenceDecision;
  updateThresholds(regime: number): void;
}

export interface WasmReservoirStore {
  insert(key: string, data: Uint8Array): boolean;
  retrieve(key: string): Uint8Array | null;
  size(): number;
  capacity(): number;
}

export interface WasmModule {
  marketEvent: WasmMarketEvent;
  thresholdGate: WasmThresholdGate;
  reservoirStore: WasmReservoirStore;
}

let wasmInstance: WasmModule | null = null;
let initPromise: Promise<WasmModule> | null = null;
let usingFallback = false;

async function tryLoadNativeWasm(): Promise<WasmModule | null> {
  try {
    const wasmPkg = await import('@ruvector/neural-trader-wasm' as string);
    logger.info('Native WASM module loaded successfully');
    return wasmPkg as unknown as WasmModule;
  } catch {
    logger.warn('Native WASM module not available, will use pure-TS fallback');
    return null;
  }
}

function createFallbackModule(): WasmModule {
  return {
    marketEvent: new FallbackMarketEventImpl(),
    thresholdGate: new FallbackThresholdGateImpl(),
    reservoirStore: new FallbackReservoirStoreImpl(10000),
  };
}

// Pure-TS fallback implementations
class FallbackMarketEventImpl implements WasmMarketEvent {
  create(event: MarketEvent): Uint8Array {
    const json = JSON.stringify(event, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    return new TextEncoder().encode(json);
  }

  deserialize(data: Uint8Array): MarketEvent {
    const json = new TextDecoder().decode(data);
    return JSON.parse(json) as MarketEvent;
  }
}

class FallbackThresholdGateImpl implements WasmThresholdGate {
  private thresholds = { mincut: 0.5, drift: 1.0, cusum: 4.0 };

  evaluate(metrics: {
    mincutValue: number;
    driftScore: number;
    cusumScore: number;
  }): CoherenceDecision {
    const reasons: string[] = [];
    let allowAct = true;

    if (metrics.mincutValue < this.thresholds.mincut) {
      reasons.push(`mincut ${metrics.mincutValue} < threshold ${this.thresholds.mincut}`);
      allowAct = false;
    }
    if (metrics.driftScore > this.thresholds.drift) {
      reasons.push(`drift ${metrics.driftScore} > threshold ${this.thresholds.drift}`);
      allowAct = false;
    }
    if (metrics.cusumScore > this.thresholds.cusum) {
      reasons.push(`cusum ${metrics.cusumScore} > threshold ${this.thresholds.cusum}`);
      allowAct = false;
    }

    return {
      allowRetrieve: true,
      allowWrite: allowAct,
      allowLearn: true,
      allowAct,
      mincutValue: BigInt(Math.floor(metrics.mincutValue * 1000)),
      partitionHash: 'fallback-no-hash',
      driftScore: metrics.driftScore,
      cusumScore: metrics.cusumScore,
      reasons,
    };
  }

  updateThresholds(regime: number): void {
    switch (regime) {
      case 0: // Calm
        this.thresholds = { mincut: 0.3, drift: 1.5, cusum: 5.0 };
        break;
      case 1: // Normal
        this.thresholds = { mincut: 0.5, drift: 1.0, cusum: 4.0 };
        break;
      case 2: // Volatile
        this.thresholds = { mincut: 0.8, drift: 0.5, cusum: 2.0 };
        break;
    }
  }
}

class FallbackReservoirStoreImpl implements WasmReservoirStore {
  private store = new Map<string, Uint8Array>();
  private _capacity: number;

  constructor(capacity: number) {
    this._capacity = capacity;
  }

  insert(key: string, data: Uint8Array): boolean {
    if (this.store.size >= this._capacity) {
      // Reservoir sampling: replace a random existing entry
      const keys = Array.from(this.store.keys());
      const randomIdx = Math.floor(Math.random() * keys.length);
      const removeKey = keys[randomIdx];
      if (removeKey !== undefined) {
        this.store.delete(removeKey);
      }
    }
    this.store.set(key, data);
    return true;
  }

  retrieve(key: string): Uint8Array | null {
    return this.store.get(key) ?? null;
  }

  size(): number {
    return this.store.size;
  }

  capacity(): number {
    return this._capacity;
  }
}

export class WasmLoader {
  async init(): Promise<WasmModule> {
    if (wasmInstance) return wasmInstance;

    if (initPromise) return initPromise;

    initPromise = (async () => {
      const native = await tryLoadNativeWasm();
      if (native) {
        wasmInstance = native;
        usingFallback = false;
      } else {
        wasmInstance = createFallbackModule();
        usingFallback = true;
      }
      return wasmInstance;
    })();

    try {
      return await initPromise;
    } catch (err) {
      initPromise = null;
      throw new WasmInitError(
        `Failed to initialize WASM module: ${String(err)}`,
        { error: String(err) },
      );
    }
  }

  async getModule(): Promise<WasmModule> {
    if (wasmInstance) return wasmInstance;
    return this.init();
  }

  isInitialized(): boolean {
    return wasmInstance !== null;
  }

  isUsingFallback(): boolean {
    return usingFallback;
  }

  async healthCheck(): Promise<{
    initialized: boolean;
    usingFallback: boolean;
    storeSize: number;
    storeCapacity: number;
  }> {
    if (!wasmInstance) {
      return {
        initialized: false,
        usingFallback: false,
        storeSize: 0,
        storeCapacity: 0,
      };
    }
    return {
      initialized: true,
      usingFallback,
      storeSize: wasmInstance.reservoirStore.size(),
      storeCapacity: wasmInstance.reservoirStore.capacity(),
    };
  }

  reset(): void {
    wasmInstance = null;
    initPromise = null;
    usingFallback = false;
  }
}

// Singleton
let defaultLoader: WasmLoader | undefined;

export function getWasmLoader(): WasmLoader {
  if (!defaultLoader) {
    defaultLoader = new WasmLoader();
  }
  return defaultLoader;
}
