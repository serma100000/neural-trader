import { describe, it, expect } from 'vitest';
import { GnnEngine } from '../../src/gnn/gnn-engine.js';
import { HeadRegistry } from '../../src/heads/head-registry.js';
import {
  MidPriceHead,
  FillProbHead,
  CancelProbHead,
  SlippageHead,
  VolJumpHead,
  RegimeTransitionHead,
  createAllPredictionHeads,
} from '../../src/heads/prediction-heads.js';
import { MarketGraph } from '../../src/graph/market-graph.js';
import { DataLoader } from '../../src/training/data-loader.js';
import { Trainer } from '../../src/training/trainer.js';
import { generateSyntheticEvents } from '../../src/training/synthetic-data.js';
import { clipGradient } from '../../src/training/gradient.js';
import type { TrainingConfig } from '../../src/training/types.js';

/**
 * Small config for fast numerical gradient tests.
 * Short windows and few events keep the test under a few seconds.
 */
function smallConfig(): Partial<TrainingConfig> {
  return {
    epochs: 3,
    learningRate: 1e-3,
    batchSize: 4,
    windowSizeNs: 5_000_000_000n,
    strideNs: 3_000_000_000n,
    validationSplit: 0.3,
    gradientClipNorm: 1.0,
    lambdaFill: 1.0,
    lambdaRisk: 1.0,
  };
}

/**
 * Create a trainer with tiny heads (8-dim input) for fast numerical gradient tests.
 * The GNN output is 512d but we use a small inputDim to keep parameter counts low.
 * For training tests we feed the embedding directly so dimension mismatch is OK
 * as long as we use the same small inputDim consistently.
 */
function createSmallTrainer(config?: Partial<TrainingConfig>): {
  trainer: Trainer;
  gnnEngine: GnnEngine;
  headRegistry: HeadRegistry;
  graph: MarketGraph;
} {
  const smallDim = 8; // Tiny input dimension for fast numerical gradients
  const gnnEngine = new GnnEngine();
  const headRegistry = new HeadRegistry();

  // Register heads with small input dimension
  headRegistry.register(new MidPriceHead(smallDim));
  headRegistry.register(new FillProbHead(smallDim));
  headRegistry.register(new CancelProbHead(smallDim));
  headRegistry.register(new SlippageHead(smallDim));
  headRegistry.register(new VolJumpHead(smallDim));
  headRegistry.register(new RegimeTransitionHead(smallDim));

  const graph = new MarketGraph();
  const trainer = new Trainer(
    { ...smallConfig(), ...config },
    gnnEngine,
    headRegistry,
    graph,
  );
  return { trainer, gnnEngine, headRegistry, graph };
}

/** Create a trainer with full-size heads (for non-gradient tests). */
function createFullTrainer(config?: Partial<TrainingConfig>): {
  trainer: Trainer;
  gnnEngine: GnnEngine;
  headRegistry: HeadRegistry;
  graph: MarketGraph;
} {
  const gnnEngine = new GnnEngine();
  const headRegistry = new HeadRegistry();
  const heads = createAllPredictionHeads();
  for (const head of heads) {
    headRegistry.register(head);
  }
  const graph = new MarketGraph();
  const trainer = new Trainer(
    { ...smallConfig(), ...config },
    gnnEngine,
    headRegistry,
    graph,
  );
  return { trainer, gnnEngine, headRegistry, graph };
}

describe('Trainer', () => {
  it('should list trainable weights from all heads', () => {
    const { trainer } = createFullTrainer();
    const params = trainer.getTrainableWeights();

    // 6 heads, each with 2 layers (weights + biases per layer = 4 arrays per head)
    // Total: 6 * 4 = 24 parameter arrays
    expect(params.length).toBe(24);

    // Verify naming convention
    for (const p of params) {
      expect(p.name).toMatch(/\.(weights|biases)$/);
      expect(p.weights.length).toBeGreaterThan(0);
    }
  });

  it('should evaluate without modifying weights', () => {
    const { trainer, headRegistry } = createFullTrainer();
    const events = generateSyntheticEvents(100);
    const loader = new DataLoader(smallConfig());
    const windows = loader.createWindows(events);

    if (windows.length === 0) return;

    // Capture weights before evaluation
    const midHead = headRegistry.getPredictionHead('mid_price') as any;
    const mlp = midHead.getMlp();
    const weightsBefore = new Float32Array(mlp.getWeights(0));

    const result = trainer.evaluate(windows.slice(0, 3));

    // Weights should not change during evaluation
    const weightsAfter = mlp.getWeights(0);
    for (let i = 0; i < weightsBefore.length; i++) {
      expect(weightsAfter[i]).toBe(weightsBefore[i]);
    }

    expect(result.loss).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.loss)).toBe(true);
  });

  it('should track per-head metrics', () => {
    const { trainer } = createFullTrainer();
    const events = generateSyntheticEvents(100);
    const loader = new DataLoader(smallConfig());
    const windows = loader.createWindows(events);

    if (windows.length === 0) return;

    const result = trainer.evaluate(windows.slice(0, 3));

    expect(result.perHead.size).toBeGreaterThan(0);
    for (const [name, loss] of result.perHead) {
      expect(typeof name).toBe('string');
      expect(Number.isFinite(loss)).toBe(true);
      expect(loss).toBeGreaterThanOrEqual(0);
    }
  });

  it('should complete a training epoch without errors on small heads', () => {
    const { trainer } = createSmallTrainer();
    const events = generateSyntheticEvents(80);
    const loader = new DataLoader(smallConfig());
    const windows = loader.createWindows(events);

    if (windows.length < 1) return;

    // Use just 1 window to keep numerical gradients fast with small heads
    const result = trainer.trainEpoch(windows.slice(0, 1));

    expect(Number.isFinite(result.loss)).toBe(true);
    expect(result.perHead.size).toBeGreaterThan(0);
  }, 60_000); // 60s timeout for numerical gradients

  it('should produce finite losses over multiple epochs on small heads', () => {
    const { trainer } = createSmallTrainer({ epochs: 2 });
    const events = generateSyntheticEvents(80);
    const loader = new DataLoader(smallConfig());
    const windows = loader.createWindows(events);

    if (windows.length < 2) return;

    const train = windows.slice(0, 1);
    const val = windows.slice(1, 2);

    const metrics = trainer.train(train, val);

    expect(metrics.length).toBe(2);
    for (const m of metrics) {
      expect(Number.isFinite(m.trainLoss)).toBe(true);
      expect(Number.isFinite(m.valLoss)).toBe(true);
      expect(m.durationMs).toBeGreaterThanOrEqual(0);
    }
  }, 120_000); // 120s timeout for 2 epochs of numerical gradients
});

describe('clipGradient', () => {
  it('should not modify gradients within norm', () => {
    const grad = new Float32Array([0.1, 0.2, 0.3]);
    const clipped = clipGradient(grad, 10.0);
    expect(clipped[0]).toBeCloseTo(0.1);
    expect(clipped[1]).toBeCloseTo(0.2);
    expect(clipped[2]).toBeCloseTo(0.3);
  });

  it('should clip gradients exceeding max norm', () => {
    const grad = new Float32Array([3.0, 4.0]); // norm = 5
    const clipped = clipGradient(grad, 1.0);

    // Verify new norm is maxNorm
    let normSq = 0;
    for (let i = 0; i < clipped.length; i++) {
      normSq += clipped[i] * clipped[i];
    }
    expect(Math.sqrt(normSq)).toBeCloseTo(1.0, 4);
  });

  it('should preserve gradient direction after clipping', () => {
    const grad = new Float32Array([3.0, 4.0]);
    const clipped = clipGradient(grad, 1.0);

    // Direction should be preserved (ratio should be the same)
    const ratio = clipped[0] / clipped[1];
    expect(ratio).toBeCloseTo(3.0 / 4.0, 4);
  });

  it('should handle zero gradient', () => {
    const grad = new Float32Array([0, 0, 0]);
    const clipped = clipGradient(grad, 1.0);
    for (let i = 0; i < clipped.length; i++) {
      expect(clipped[i]).toBe(0);
    }
  });
});
