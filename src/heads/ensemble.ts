import type { Prediction, ControlSignal, ModelOutput, Embedding, SymbolId } from '../gnn/types.js';
import type { CoherenceDecision } from '../shared/types.js';

/**
 * Weighted ensemble that combines predictions with coherence-gated confidence.
 *
 * The coherence decision modulates prediction confidence:
 * - High drift/CUSUM scores reduce confidence
 * - Disabled gates (allowRetrieve, allowAct) suppress predictions/controls
 */
export class PredictionEnsemble {
  /**
   * Combine predictions and controls with coherence gating.
   *
   * @param predictions Raw predictions from all heads.
   * @param controls Raw control signals from all heads.
   * @param coherence Current coherence decision for gating.
   * @param embeddings Optional embeddings to include in output.
   * @returns Gated model output.
   */
  combine(
    predictions: Prediction[],
    controls: ControlSignal[],
    coherence: CoherenceDecision,
    embeddings?: Embedding[],
  ): ModelOutput {
    const tsNs = BigInt(Date.now()) * 1_000_000n;

    // Compute coherence confidence multiplier
    const coherenceGate = this.computeCoherenceGate(coherence);

    // Gate predictions
    const gatedPredictions: Prediction[] = predictions.map((p) => ({
      ...p,
      confidence: coherence.allowRetrieve
        ? p.confidence * coherenceGate
        : 0,
      tsNs,
    }));

    // Gate controls
    const gatedControls: ControlSignal[] = controls.map((c) => ({
      ...c,
      confidence: coherence.allowAct
        ? c.confidence * coherenceGate
        : 0,
    }));

    return {
      embeddings: embeddings ?? [],
      predictions: gatedPredictions,
      controls: gatedControls,
      tsNs,
    };
  }

  /**
   * Compute a confidence multiplier [0, 1] from coherence signals.
   *
   * - driftScore in [0, 1]: higher = more drift = lower confidence
   * - cusumScore: higher = more regime change = lower confidence
   */
  private computeCoherenceGate(coherence: CoherenceDecision): number {
    // Base gate starts at 1.0
    let gate = 1.0;

    // Penalize drift: sigmoid decay around 0.5 drift threshold
    gate *= 1.0 / (1.0 + Math.exp(5 * (coherence.driftScore - 0.5)));

    // Penalize CUSUM: linear decay
    gate *= Math.max(0, 1.0 - coherence.cusumScore * 0.5);

    // If learning is disabled, reduce confidence slightly
    if (!coherence.allowLearn) {
      gate *= 0.8;
    }

    return Math.max(0, Math.min(1, gate));
  }

  /**
   * Select the highest-confidence prediction for a given head name.
   */
  selectBest(predictions: Prediction[], headName: string): Prediction | undefined {
    let best: Prediction | undefined;
    for (const p of predictions) {
      if (p.headName === headName) {
        if (!best || p.confidence > best.confidence) {
          best = p;
        }
      }
    }
    return best;
  }
}
