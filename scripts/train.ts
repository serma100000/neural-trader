/**
 * Training CLI entry point.
 *
 * Usage: npx tsx scripts/train.ts --epochs 50 --lr 0.0001 --checkpoint-dir data/checkpoints
 */

import { GnnEngine } from '../src/gnn/gnn-engine.js';
import { HeadRegistry } from '../src/heads/head-registry.js';
import { createAllPredictionHeads } from '../src/heads/prediction-heads.js';
import { MarketGraph } from '../src/graph/market-graph.js';
import { DataLoader } from '../src/training/data-loader.js';
import { Trainer } from '../src/training/trainer.js';
import { CheckpointManager } from '../src/training/checkpoint.js';
import type { TrainingConfig } from '../src/training/types.js';
import { DEFAULT_TRAINING_CONFIG } from '../src/training/types.js';
import { generateSyntheticEvents } from '../src/training/synthetic-data.js';

function parseArgs(): Partial<TrainingConfig> {
  const args = process.argv.slice(2);
  const config: Partial<TrainingConfig> = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--epochs':
        config.epochs = parseInt(args[++i], 10);
        break;
      case '--lr':
        config.learningRate = parseFloat(args[++i]);
        break;
      case '--batch-size':
        config.batchSize = parseInt(args[++i], 10);
        break;
      case '--checkpoint-dir':
        config.checkpointDir = args[++i];
        break;
      case '--validation-split':
        config.validationSplit = parseFloat(args[++i]);
        break;
      case '--help':
        console.log(`
Usage: npx tsx scripts/train.ts [options]

Options:
  --epochs <n>            Number of training epochs (default: ${DEFAULT_TRAINING_CONFIG.epochs})
  --lr <rate>             Learning rate (default: ${DEFAULT_TRAINING_CONFIG.learningRate})
  --batch-size <n>        Mini-batch size (default: ${DEFAULT_TRAINING_CONFIG.batchSize})
  --checkpoint-dir <dir>  Checkpoint directory (default: ${DEFAULT_TRAINING_CONFIG.checkpointDir})
  --validation-split <f>  Validation fraction (default: ${DEFAULT_TRAINING_CONFIG.validationSplit})
  --help                  Show this help message
`);
        process.exit(0);
    }
  }

  return config;
}

async function main(): Promise<void> {
  const configOverrides = parseArgs();
  const config: TrainingConfig = { ...DEFAULT_TRAINING_CONFIG, ...configOverrides };

  console.log('=== Neural Trader Training Pipeline ===');
  console.log(`Epochs: ${config.epochs}`);
  console.log(`Learning rate: ${config.learningRate}`);
  console.log(`Batch size: ${config.batchSize}`);
  console.log(`Checkpoint dir: ${config.checkpointDir}`);
  console.log('');

  // Generate synthetic training data
  console.log('Generating synthetic training data (1000 events)...');
  const events = generateSyntheticEvents(1000);
  console.log(`Generated ${events.length} events`);

  // Create training windows
  const dataLoader = new DataLoader(config);
  const windows = dataLoader.createWindows(events);
  console.log(`Created ${windows.length} training windows`);

  if (windows.length === 0) {
    console.error('No training windows created. Check event data.');
    process.exit(1);
  }

  const { train, val } = dataLoader.splitTrainVal(windows);
  console.log(`Train: ${train.length} windows, Val: ${val.length} windows`);
  console.log('');

  // Initialize model components
  const gnnEngine = new GnnEngine();
  const headRegistry = new HeadRegistry();
  const heads = createAllPredictionHeads();
  for (const head of heads) {
    headRegistry.register(head);
  }
  const graph = new MarketGraph();

  // Create trainer
  const trainer = new Trainer(config, gnnEngine, headRegistry, graph);

  const trainableParams = trainer.getTrainableWeights();
  let totalParams = 0;
  for (const p of trainableParams) {
    totalParams += p.weights.length;
  }
  console.log(`Trainable parameters: ${totalParams} across ${trainableParams.length} arrays`);
  console.log('');

  // Train
  console.log('Starting training...');
  const metrics = trainer.train(train, val);

  // Print results
  console.log('');
  console.log('=== Training Results ===');
  for (const m of metrics) {
    console.log(
      `Epoch ${m.epoch}: train_loss=${m.trainLoss.toFixed(4)} val_loss=${m.valLoss.toFixed(4)} (${m.durationMs}ms)`,
    );
  }

  // Save best checkpoint (lowest validation loss)
  const checkpointMgr = new CheckpointManager(config.checkpointDir);
  let bestMetrics = metrics[0];
  for (const m of metrics) {
    if (m.valLoss < bestMetrics.valLoss) {
      bestMetrics = m;
    }
  }

  const checkpoint = checkpointMgr.createCheckpoint(
    bestMetrics.epoch,
    bestMetrics,
    gnnEngine,
    headRegistry,
    config,
  );
  const savePath = await checkpointMgr.save(checkpoint);
  console.log('');
  console.log(`Best checkpoint saved: ${savePath}`);
  console.log(`Best epoch: ${bestMetrics.epoch}, val_loss: ${bestMetrics.valLoss.toFixed(4)}`);
}

main().catch((err) => {
  console.error('Training failed:', err);
  process.exit(1);
});
