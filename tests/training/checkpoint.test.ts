import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CheckpointManager } from '../../src/training/checkpoint.js';
import { GnnEngine } from '../../src/gnn/gnn-engine.js';
import { HeadRegistry } from '../../src/heads/head-registry.js';
import { createAllPredictionHeads } from '../../src/heads/prediction-heads.js';
import type {
  Checkpoint,
  TrainingMetrics,
  TrainingConfig,
} from '../../src/training/types.js';
import { DEFAULT_TRAINING_CONFIG } from '../../src/training/types.js';

let testDir: string;

function makeMetrics(epoch: number, valLoss: number): TrainingMetrics {
  return {
    epoch,
    trainLoss: valLoss + 0.1,
    valLoss,
    perHeadLoss: new Map([
      ['mid_price', 0.5],
      ['fill_prob', 0.3],
    ]),
    learningRate: 1e-4,
    durationMs: 100,
  };
}

function makeCheckpoint(epoch: number, valLoss: number): Checkpoint {
  return {
    version: '1.0.0',
    epoch,
    metrics: makeMetrics(epoch, valLoss),
    weights: {
      gnnMessagePassing: [],
      gnnAttention: [],
      gnnProjection: { weights: [], biases: [] },
      heads: {
        mid_price: [
          { weights: [1, 2, 3], biases: [0.1] },
          { weights: [4, 5], biases: [0.2, 0.3] },
        ],
      },
    },
    config: DEFAULT_TRAINING_CONFIG,
    createdAt: new Date().toISOString(),
  };
}

beforeEach(async () => {
  testDir = join(tmpdir(), `neural-trader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe('CheckpointManager', () => {
  it('should save and load a checkpoint with exact weight preservation', async () => {
    const mgr = new CheckpointManager(testDir);
    const original = makeCheckpoint(5, 0.42);

    const path = await mgr.save(original);
    const loaded = await mgr.load(path);

    expect(loaded.version).toBe(original.version);
    expect(loaded.epoch).toBe(original.epoch);
    expect(loaded.metrics.trainLoss).toBeCloseTo(original.metrics.trainLoss);
    expect(loaded.metrics.valLoss).toBeCloseTo(original.metrics.valLoss);
    expect(loaded.createdAt).toBe(original.createdAt);

    // Verify weights are preserved exactly
    const origWeights = original.weights.heads['mid_price']![0].weights;
    const loadedWeights = loaded.weights.heads['mid_price']![0].weights;
    expect(loadedWeights).toEqual(origWeights);

    const origBiases = original.weights.heads['mid_price']![0].biases;
    const loadedBiases = loaded.weights.heads['mid_price']![0].biases;
    expect(loadedBiases).toEqual(origBiases);
  });

  it('should preserve config with bigint values through round-trip', async () => {
    const mgr = new CheckpointManager(testDir);
    const original = makeCheckpoint(1, 0.5);
    original.config.windowSizeNs = 60_000_000_000n;
    original.config.strideNs = 10_000_000_000n;

    const path = await mgr.save(original);
    const loaded = await mgr.load(path);

    expect(loaded.config.windowSizeNs).toBe(60_000_000_000n);
    expect(loaded.config.strideNs).toBe(10_000_000_000n);
  });

  it('should preserve perHeadLoss map through round-trip', async () => {
    const mgr = new CheckpointManager(testDir);
    const original = makeCheckpoint(1, 0.3);

    const path = await mgr.save(original);
    const loaded = await mgr.load(path);

    expect(loaded.metrics.perHeadLoss.get('mid_price')).toBeCloseTo(0.5);
    expect(loaded.metrics.perHeadLoss.get('fill_prob')).toBeCloseTo(0.3);
  });

  it('should return most recent checkpoint from loadLatest', async () => {
    const mgr = new CheckpointManager(testDir);

    await mgr.save(makeCheckpoint(1, 0.8));
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));
    await mgr.save(makeCheckpoint(5, 0.3));
    await new Promise((r) => setTimeout(r, 10));
    await mgr.save(makeCheckpoint(3, 0.5));

    const latest = await mgr.loadLatest();
    expect(latest).not.toBeNull();
    // Sorted by epoch descending, so epoch 5 is first
    expect(latest!.epoch).toBe(5);
  });

  it('should return null from loadLatest when no checkpoints exist', async () => {
    const emptyDir = join(testDir, 'empty');
    await fs.mkdir(emptyDir, { recursive: true });
    const mgr = new CheckpointManager(emptyDir);

    const latest = await mgr.loadLatest();
    expect(latest).toBeNull();
  });

  it('should list checkpoints sorted by epoch descending', async () => {
    const mgr = new CheckpointManager(testDir);

    await mgr.save(makeCheckpoint(1, 0.8));
    await new Promise((r) => setTimeout(r, 10));
    await mgr.save(makeCheckpoint(3, 0.5));
    await new Promise((r) => setTimeout(r, 10));
    await mgr.save(makeCheckpoint(2, 0.6));

    const listing = await mgr.list();
    expect(listing.length).toBe(3);
    expect(listing[0].epoch).toBe(3);
    expect(listing[1].epoch).toBe(2);
    expect(listing[2].epoch).toBe(1);
  });

  it('should extract and apply weights to a live model', () => {
    const gnnEngine = new GnnEngine();
    const headRegistry = new HeadRegistry();
    const heads = createAllPredictionHeads();
    for (const head of heads) {
      headRegistry.register(head);
    }

    const mgr = new CheckpointManager(testDir);

    // Extract current weights
    const weights = mgr.extractWeights(gnnEngine, headRegistry);

    // Verify heads were extracted
    expect(Object.keys(weights.heads).length).toBeGreaterThan(0);
    expect(weights.heads['mid_price']).toBeDefined();
    expect(weights.heads['fill_prob']).toBeDefined();

    // Each head should have layer weights/biases
    for (const [, layers] of Object.entries(weights.heads)) {
      expect(layers.length).toBeGreaterThan(0);
      for (const layer of layers) {
        expect(layer.weights.length).toBeGreaterThan(0);
        expect(layer.biases.length).toBeGreaterThan(0);
      }
    }
  });

  it('should correctly apply loaded weights to model', () => {
    const gnnEngine = new GnnEngine();
    const headRegistry = new HeadRegistry();
    const heads = createAllPredictionHeads();
    for (const head of heads) {
      headRegistry.register(head);
    }

    const mgr = new CheckpointManager(testDir);

    // Extract weights, modify them, and apply back
    const weights = mgr.extractWeights(gnnEngine, headRegistry);

    // Set all mid_price weights to a known value
    for (const layer of weights.heads['mid_price']!) {
      layer.weights = layer.weights.map(() => 0.42);
      layer.biases = layer.biases.map(() => 0.01);
    }

    const checkpoint: Checkpoint = {
      version: '1.0.0',
      epoch: 0,
      metrics: makeMetrics(0, 0),
      weights,
      config: DEFAULT_TRAINING_CONFIG,
      createdAt: new Date().toISOString(),
    };

    mgr.applyWeights(checkpoint, gnnEngine, headRegistry);

    // Verify the weights were applied
    const midHead = headRegistry.getPredictionHead('mid_price') as any;
    const mlp = midHead.getMlp();
    const w0 = mlp.getWeights(0);
    // All weights should be 0.42
    for (let i = 0; i < w0.length; i++) {
      expect(w0[i]).toBeCloseTo(0.42);
    }
  });
});
