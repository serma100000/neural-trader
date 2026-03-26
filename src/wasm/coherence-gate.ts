import type { CoherenceDecision } from '../shared/types.js';
import { RegimeLabel } from '../shared/types.js';
import { getWasmLoader } from './loader.js';
import { createLogger } from '../shared/logger.js';

const logger = createLogger({ component: 'coherence-gate' });

export interface CoherenceMetrics {
  mincutValue: number;
  driftScore: number;
  cusumScore: number;
}

export class CoherenceGate {
  private currentRegime: RegimeLabel = RegimeLabel.Normal;

  async evaluate(metrics: CoherenceMetrics): Promise<CoherenceDecision> {
    const loader = getWasmLoader();
    const mod = await loader.getModule();
    const decision = mod.thresholdGate.evaluate(metrics);

    if (!decision.allowAct) {
      logger.warn(
        { reasons: decision.reasons, regime: this.currentRegime },
        'Coherence gate blocked action',
      );
    }

    return decision;
  }

  async setRegime(regime: RegimeLabel): Promise<void> {
    this.currentRegime = regime;
    const loader = getWasmLoader();
    const mod = await loader.getModule();
    mod.thresholdGate.updateThresholds(regime);
    logger.info({ regime: RegimeLabel[regime] }, 'Coherence regime updated');
  }

  getRegime(): RegimeLabel {
    return this.currentRegime;
  }
}

let defaultGate: CoherenceGate | undefined;

export function getCoherenceGate(): CoherenceGate {
  if (!defaultGate) {
    defaultGate = new CoherenceGate();
  }
  return defaultGate;
}
