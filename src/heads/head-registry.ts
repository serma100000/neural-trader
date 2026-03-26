import type { Prediction, ControlSignal } from '../gnn/types.js';
import type { PredictionHead, ControlHead } from './types.js';

/**
 * Registry that manages prediction and control heads.
 *
 * Provides a central place to register heads and batch-evaluate
 * embeddings across all registered heads.
 */
export class HeadRegistry {
  private predictionHeads = new Map<string, PredictionHead>();
  private controlHeads = new Map<string, ControlHead>();

  /** Register a prediction head. Replaces any existing head with the same name. */
  registerPrediction(head: PredictionHead): void {
    this.predictionHeads.set(head.name, head);
  }

  /** Register a control head. Replaces any existing head with the same name. */
  registerControl(head: ControlHead): void {
    this.controlHeads.set(head.name, head);
  }

  /** Register any head (auto-detects type). */
  register(head: PredictionHead | ControlHead): void {
    if ('predict' in head) {
      this.registerPrediction(head as PredictionHead);
    } else {
      this.registerControl(head as ControlHead);
    }
  }

  /** Run all prediction heads on an embedding. */
  getPredictions(embedding: Float32Array): Prediction[] {
    const results: Prediction[] = [];
    for (const head of this.predictionHeads.values()) {
      results.push(head.predict(embedding));
    }
    return results;
  }

  /** Run all control heads on an embedding. */
  getControls(embedding: Float32Array): ControlSignal[] {
    const results: ControlSignal[] = [];
    for (const head of this.controlHeads.values()) {
      results.push(head.evaluate(embedding));
    }
    return results;
  }

  /** Get a specific prediction head by name. */
  getPredictionHead(name: string): PredictionHead | undefined {
    return this.predictionHeads.get(name);
  }

  /** Get a specific control head by name. */
  getControlHead(name: string): ControlHead | undefined {
    return this.controlHeads.get(name);
  }

  /** Get the count of registered prediction heads. */
  predictionHeadCount(): number {
    return this.predictionHeads.size;
  }

  /** Get the count of registered control heads. */
  controlHeadCount(): number {
    return this.controlHeads.size;
  }

  /** Get all registered prediction head names. */
  predictionHeadNames(): string[] {
    return Array.from(this.predictionHeads.keys());
  }

  /** Get all registered control head names. */
  controlHeadNames(): string[] {
    return Array.from(this.controlHeads.keys());
  }

  /** Remove all registered heads. */
  clear(): void {
    this.predictionHeads.clear();
    this.controlHeads.clear();
  }
}
