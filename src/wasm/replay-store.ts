import { getWasmLoader } from './loader.js';
import { getCoherenceGate, type CoherenceMetrics } from './coherence-gate.js';
import { createLogger } from '../shared/logger.js';
import { CoherenceBlockedError } from '../shared/errors.js';

const logger = createLogger({ component: 'replay-store' });

export class ReplayStore {
  private gatedWrites: boolean;

  constructor(gatedWrites = true) {
    this.gatedWrites = gatedWrites;
  }

  async insert(
    key: string,
    data: Uint8Array,
    coherenceMetrics?: CoherenceMetrics,
  ): Promise<boolean> {
    if (this.gatedWrites && coherenceMetrics) {
      const gate = getCoherenceGate();
      const decision = await gate.evaluate(coherenceMetrics);
      if (!decision.allowWrite) {
        throw new CoherenceBlockedError(
          'Write blocked by coherence gate',
          { key, reasons: decision.reasons },
        );
      }
    }

    const loader = getWasmLoader();
    const mod = await loader.getModule();
    const success = mod.reservoirStore.insert(key, data);

    if (success) {
      logger.debug({ key, size: data.length }, 'Stored replay entry');
    }

    return success;
  }

  async retrieve(key: string): Promise<Uint8Array | null> {
    const loader = getWasmLoader();
    const mod = await loader.getModule();
    return mod.reservoirStore.retrieve(key);
  }

  async size(): Promise<number> {
    const loader = getWasmLoader();
    const mod = await loader.getModule();
    return mod.reservoirStore.size();
  }

  async capacity(): Promise<number> {
    const loader = getWasmLoader();
    const mod = await loader.getModule();
    return mod.reservoirStore.capacity();
  }
}

let defaultStore: ReplayStore | undefined;

export function getReplayStore(): ReplayStore {
  if (!defaultStore) {
    defaultStore = new ReplayStore();
  }
  return defaultStore;
}
