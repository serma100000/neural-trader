import { promises as fs } from 'node:fs';
import { join, basename } from 'node:path';
import type { GnnEngine } from '../gnn/gnn-engine.js';
import type { HeadRegistry } from '../heads/head-registry.js';
import type { TrainablePredictionHead } from '../heads/types.js';
import type {
  Checkpoint,
  SerializedWeights,
  SerializedLayer,
  TrainingMetrics,
  TrainingConfig,
} from './types.js';

/**
 * Manages checkpoint persistence for the training pipeline.
 *
 * Checkpoints are saved as JSON files in the configured directory.
 * Format: checkpoint-{epoch}-{timestamp}.json
 */
export class CheckpointManager {
  private readonly checkpointDir: string;

  constructor(checkpointDir: string) {
    this.checkpointDir = checkpointDir;
  }

  /**
   * Save a checkpoint to disk.
   * @returns The file path of the saved checkpoint
   */
  async save(checkpoint: Checkpoint): Promise<string> {
    await fs.mkdir(this.checkpointDir, { recursive: true });

    const timestamp = Date.now();
    const filename = `checkpoint-${checkpoint.epoch}-${timestamp}.json`;
    const filepath = join(this.checkpointDir, filename);

    // Serialize the checkpoint to JSON-safe format
    const serializable = this.toJsonSafe(checkpoint);
    await fs.writeFile(filepath, JSON.stringify(serializable, null, 2), 'utf-8');

    return filepath;
  }

  /**
   * Load a checkpoint from a specific file path.
   */
  async load(path: string): Promise<Checkpoint> {
    const raw = await fs.readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return this.fromJsonSafe(parsed);
  }

  /**
   * Load the most recent checkpoint from the directory.
   * Returns null if no checkpoints exist.
   */
  async loadLatest(): Promise<Checkpoint | null> {
    const listing = await this.list();
    if (listing.length === 0) return null;

    // list() is sorted by epoch descending
    return this.load(listing[0].path);
  }

  /**
   * List all checkpoints in the directory, sorted by epoch descending.
   */
  async list(): Promise<
    { path: string; epoch: number; valLoss: number; createdAt: string }[]
  > {
    try {
      const files = await fs.readdir(this.checkpointDir);
      const checkpointFiles = files.filter(
        (f) => f.startsWith('checkpoint-') && f.endsWith('.json'),
      );

      const entries: {
        path: string;
        epoch: number;
        valLoss: number;
        createdAt: string;
      }[] = [];

      for (const file of checkpointFiles) {
        const filepath = join(this.checkpointDir, file);
        try {
          const raw = await fs.readFile(filepath, 'utf-8');
          const parsed = JSON.parse(raw);
          entries.push({
            path: filepath,
            epoch: parsed.epoch ?? 0,
            valLoss: parsed.metrics?.valLoss ?? Infinity,
            createdAt: parsed.createdAt ?? '',
          });
        } catch {
          // Skip corrupt files
        }
      }

      // Sort by epoch descending
      entries.sort((a, b) => b.epoch - a.epoch);
      return entries;
    } catch {
      return [];
    }
  }

  /**
   * Apply weights from a checkpoint to a live GNN engine and head registry.
   */
  applyWeights(
    checkpoint: Checkpoint,
    _gnnEngine: GnnEngine,
    headRegistry: HeadRegistry,
  ): void {
    const { heads } = checkpoint.weights;

    // Apply head weights
    for (const [headName, layers] of Object.entries(heads)) {
      const head = headRegistry.getPredictionHead(headName);
      if (!head || !('getMlp' in head)) continue;

      const trainable = head as TrainablePredictionHead;
      const mlp = trainable.getMlp();
      const paramArrays = mlp.getParameterArrays();

      // Each layer has weights and biases
      let paramIdx = 0;
      for (const layer of layers) {
        if (paramIdx < paramArrays.length) {
          // Apply weights
          const wArr = new Float32Array(layer.weights);
          paramArrays[paramIdx].set(wArr);
          paramIdx++;
        }
        if (paramIdx < paramArrays.length) {
          // Apply biases
          const bArr = new Float32Array(layer.biases);
          paramArrays[paramIdx].set(bArr);
          paramIdx++;
        }
      }
    }
  }

  /**
   * Extract current weights from a live model into a serializable format.
   */
  extractWeights(
    _gnnEngine: GnnEngine,
    headRegistry: HeadRegistry,
  ): SerializedWeights {
    const heads: Record<string, SerializedLayer[]> = {};

    for (const headName of headRegistry.predictionHeadNames()) {
      const head = headRegistry.getPredictionHead(headName);
      if (!head || !('getMlp' in head)) continue;

      const trainable = head as TrainablePredictionHead;
      const mlp = trainable.getMlp();
      const dims = mlp.getLayerDims();
      const layers: SerializedLayer[] = [];

      for (let i = 0; i < dims.length - 1; i++) {
        layers.push({
          weights: Array.from(mlp.getWeights(i)),
          biases: Array.from(mlp.getBiases(i)),
        });
      }

      heads[headName] = layers;
    }

    // Placeholder for GNN weights (not trained yet)
    return {
      gnnMessagePassing: [],
      gnnAttention: [],
      gnnProjection: { weights: [], biases: [] },
      heads,
    };
  }

  /**
   * Create a full checkpoint from current model state and metrics.
   */
  createCheckpoint(
    epoch: number,
    metrics: TrainingMetrics,
    gnnEngine: GnnEngine,
    headRegistry: HeadRegistry,
    config: TrainingConfig,
  ): Checkpoint {
    return {
      version: '1.0.0',
      epoch,
      metrics,
      weights: this.extractWeights(gnnEngine, headRegistry),
      config,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Convert a checkpoint to a JSON-safe representation.
   * Maps and bigints are not natively serializable.
   */
  private toJsonSafe(checkpoint: Checkpoint): Record<string, unknown> {
    return {
      version: checkpoint.version,
      epoch: checkpoint.epoch,
      metrics: {
        epoch: checkpoint.metrics.epoch,
        trainLoss: checkpoint.metrics.trainLoss,
        valLoss: checkpoint.metrics.valLoss,
        perHeadLoss: Object.fromEntries(checkpoint.metrics.perHeadLoss),
        learningRate: checkpoint.metrics.learningRate,
        durationMs: checkpoint.metrics.durationMs,
      },
      weights: checkpoint.weights,
      config: {
        ...checkpoint.config,
        windowSizeNs: checkpoint.config.windowSizeNs.toString(),
        strideNs: checkpoint.config.strideNs.toString(),
      },
      createdAt: checkpoint.createdAt,
    };
  }

  /**
   * Reconstruct a checkpoint from its JSON-safe representation.
   */
  private fromJsonSafe(raw: Record<string, unknown>): Checkpoint {
    const rawMetrics = raw.metrics as Record<string, unknown>;
    const rawConfig = raw.config as Record<string, unknown>;

    const perHeadLoss = new Map<string, number>();
    const rawPerHead = rawMetrics.perHeadLoss as Record<string, number>;
    if (rawPerHead) {
      for (const [k, v] of Object.entries(rawPerHead)) {
        perHeadLoss.set(k, v);
      }
    }

    return {
      version: raw.version as string,
      epoch: raw.epoch as number,
      metrics: {
        epoch: rawMetrics.epoch as number,
        trainLoss: rawMetrics.trainLoss as number,
        valLoss: rawMetrics.valLoss as number,
        perHeadLoss,
        learningRate: rawMetrics.learningRate as number,
        durationMs: rawMetrics.durationMs as number,
      },
      weights: raw.weights as SerializedWeights,
      config: {
        ...(rawConfig as TrainingConfig),
        windowSizeNs: BigInt(rawConfig.windowSizeNs as string),
        strideNs: BigInt(rawConfig.strideNs as string),
      },
      createdAt: raw.createdAt as string,
    };
  }
}
