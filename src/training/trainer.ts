import type { GnnEngine } from '../gnn/gnn-engine.js';
import type { HeadRegistry } from '../heads/head-registry.js';
import type { MarketGraph } from '../graph/market-graph.js';
import type { TrainablePredictionHead } from '../heads/types.js';
import type { RegimeTransitionHead } from '../heads/prediction-heads.js';
import type { TrainingConfig, TrainingWindow, TrainingMetrics } from './types.js';
import { DEFAULT_TRAINING_CONFIG } from './types.js';
import { compositeLoss } from './loss.js';
import { NumericalGradient, clipGradient, applyGradient } from './gradient.js';

interface TrainableParam {
  name: string;
  weights: Float32Array;
}

/**
 * Main training loop for prediction head MLPs.
 *
 * Only trains head weights (not GNN weights) using numerical gradients.
 * This keeps parameter count manageable for finite-difference optimization.
 */
export class Trainer {
  private readonly config: TrainingConfig;
  private readonly gnnEngine: GnnEngine;
  private readonly headRegistry: HeadRegistry;
  private readonly graph: MarketGraph;
  private readonly gradientComputer: NumericalGradient;

  constructor(
    config: Partial<TrainingConfig>,
    gnnEngine: GnnEngine,
    headRegistry: HeadRegistry,
    graph: MarketGraph,
  ) {
    this.config = { ...DEFAULT_TRAINING_CONFIG, ...config };
    this.gnnEngine = gnnEngine;
    this.headRegistry = headRegistry;
    this.graph = graph;
    this.gradientComputer = new NumericalGradient();
  }

  /**
   * Train for the configured number of epochs.
   *
   * @returns Array of per-epoch metrics
   */
  train(
    trainWindows: TrainingWindow[],
    valWindows: TrainingWindow[],
  ): TrainingMetrics[] {
    const metrics: TrainingMetrics[] = [];

    for (let epoch = 0; epoch < this.config.epochs; epoch++) {
      const epochStart = Date.now();

      const trainResult = this.trainEpoch(trainWindows);
      const valResult = this.evaluate(valWindows);

      const epochMetrics: TrainingMetrics = {
        epoch,
        trainLoss: trainResult.loss,
        valLoss: valResult.loss,
        perHeadLoss: valResult.perHead,
        learningRate: this.config.learningRate,
        durationMs: Date.now() - epochStart,
      };

      metrics.push(epochMetrics);
    }

    return metrics;
  }

  /**
   * Run a single training epoch over all windows.
   * Computes gradients and updates weights for each window.
   */
  trainEpoch(
    windows: TrainingWindow[],
  ): { loss: number; perHead: Map<string, number> } {
    let totalLoss = 0;
    const perHeadAccum = new Map<string, number>();
    let count = 0;

    for (const window of windows) {
      const { embedding, predictions, regimeProbs } =
        this.forwardPass(window);

      const { total, perHead } = compositeLoss(
        predictions,
        window.labels,
        { fill: this.config.lambdaFill, risk: this.config.lambdaRisk },
        regimeProbs,
      );

      totalLoss += total;
      count++;

      // Accumulate per-head losses
      for (const [name, loss] of perHead) {
        perHeadAccum.set(name, (perHeadAccum.get(name) ?? 0) + loss);
      }

      // Compute and apply gradients for each head's parameters
      this.updateHeadWeights(window, embedding);
    }

    // Average losses
    if (count > 0) {
      totalLoss /= count;
      for (const [name, loss] of perHeadAccum) {
        perHeadAccum.set(name, loss / count);
      }
    }

    return { loss: totalLoss, perHead: perHeadAccum };
  }

  /**
   * Evaluate on a set of windows without updating weights.
   */
  evaluate(
    windows: TrainingWindow[],
  ): { loss: number; perHead: Map<string, number> } {
    let totalLoss = 0;
    const perHeadAccum = new Map<string, number>();
    let count = 0;

    for (const window of windows) {
      const { predictions, regimeProbs } = this.forwardPass(window);

      const { total, perHead } = compositeLoss(
        predictions,
        window.labels,
        { fill: this.config.lambdaFill, risk: this.config.lambdaRisk },
        regimeProbs,
      );

      totalLoss += total;
      count++;

      for (const [name, loss] of perHead) {
        perHeadAccum.set(name, (perHeadAccum.get(name) ?? 0) + loss);
      }
    }

    if (count > 0) {
      totalLoss /= count;
      for (const [name, loss] of perHeadAccum) {
        perHeadAccum.set(name, loss / count);
      }
    }

    return { loss: totalLoss, perHead: perHeadAccum };
  }

  /**
   * Get all trainable weight arrays from the prediction heads.
   */
  getTrainableWeights(): TrainableParam[] {
    const params: TrainableParam[] = [];
    const headNames = this.headRegistry.predictionHeadNames();

    for (const headName of headNames) {
      const head = this.headRegistry.getPredictionHead(headName);
      if (!head || !('getMlp' in head)) continue;

      const trainable = head as TrainablePredictionHead;
      const mlp = trainable.getMlp();
      const arrays = mlp.getParameterArrays();

      for (let i = 0; i < arrays.length; i++) {
        const kind = i % 2 === 0 ? 'weights' : 'biases';
        const layerIdx = Math.floor(i / 2);
        params.push({
          name: `${headName}.layer${layerIdx}.${kind}`,
          weights: arrays[i],
        });
      }
    }

    return params;
  }

  /**
   * Run a forward pass for a training window.
   * Replays events into graph, extracts neighborhood, runs GNN, gets predictions.
   */
  private forwardPass(window: TrainingWindow): {
    embedding: Float32Array;
    predictions: Map<string, number>;
    regimeProbs?: Float32Array;
  } {
    // Replay events into graph
    for (const event of window.events) {
      this.graph.applyEvent(event);
    }

    // Extract neighborhood from the most recent event node
    // Use the graph's node count as a proxy for finding a node to extract from
    const nodeCount = this.graph.nodeCount();
    let embedding: Float32Array;

    if (nodeCount > 0) {
      // Extract neighborhood from the last added node
      const lastNodeId = BigInt(nodeCount - 1);
      const neighborhood = this.graph.extractNeighborhood(lastNodeId, 2);
      embedding = this.gnnEngine.forward(neighborhood);
    } else {
      embedding = new Float32Array(512);
    }

    // Get predictions from all heads
    const preds = this.headRegistry.getPredictions(embedding);
    const predictions = new Map<string, number>();
    for (const pred of preds) {
      predictions.set(pred.headName, pred.value);
    }

    // Get raw regime probabilities for cross-entropy
    let regimeProbs: Float32Array | undefined;
    const regimeHead = this.headRegistry.getPredictionHead('regime_transition');
    if (regimeHead && 'predictRaw' in regimeHead) {
      regimeProbs = (regimeHead as RegimeTransitionHead).predictRaw(embedding);
    }

    return { embedding, predictions, regimeProbs };
  }

  /**
   * Compute numerical gradients and update weights for each head.
   */
  private updateHeadWeights(
    window: TrainingWindow,
    embedding: Float32Array,
  ): void {
    const headNames = this.headRegistry.predictionHeadNames();

    for (const headName of headNames) {
      const head = this.headRegistry.getPredictionHead(headName);
      if (!head || !('getMlp' in head)) continue;

      const trainable = head as TrainablePredictionHead;
      const mlp = trainable.getMlp();
      const paramArrays = mlp.getParameterArrays();

      for (const paramArray of paramArrays) {
        // Define loss function that evaluates the full composite loss
        // when this particular weight array is perturbed
        const lossFn = (_weights: Float32Array): number => {
          // The weights array is the same reference as in the MLP,
          // so the MLP uses the perturbed values automatically
          const preds = this.headRegistry.getPredictions(embedding);
          const predMap = new Map<string, number>();
          for (const pred of preds) {
            predMap.set(pred.headName, pred.value);
          }

          let regimeP: Float32Array | undefined;
          const rHead = this.headRegistry.getPredictionHead('regime_transition');
          if (rHead && 'predictRaw' in rHead) {
            regimeP = (rHead as RegimeTransitionHead).predictRaw(embedding);
          }

          const { total } = compositeLoss(
            predMap,
            window.labels,
            { fill: this.config.lambdaFill, risk: this.config.lambdaRisk },
            regimeP,
          );
          return total;
        };

        const gradient = this.gradientComputer.computeGradient(
          paramArray,
          lossFn,
        );
        const clipped = clipGradient(gradient, this.config.gradientClipNorm);
        applyGradient(paramArray, clipped, this.config.learningRate);
      }
    }
  }
}
