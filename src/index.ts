// Domain primitives
export {
  type SymbolId,
  type VenueId,
  type Timestamp,
  type PriceFp,
  type QtyFp,
  type EventId,
  type OrderIdHash,
  EventType,
  Side,
  NodeKind,
  EdgeKind,
  PropertyKey,
  RegimeLabel,
  type MarketEvent,
  type GraphDelta,
  type CoherenceDecision,
  type VerifiedToken,
  type WitnessReceipt,
} from './shared/types.js';

// Error hierarchy
export {
  NeuralTraderError,
  CoherenceBlockedError,
  RiskBudgetExceededError,
  WasmInitError,
  FeedDisconnectedError,
  ValidationError,
  StorageError,
} from './shared/errors.js';

// Event bus
export {
  DomainEventBus,
  getEventBus,
  createEventBus,
  type DomainEvents,
  type DomainEventName,
  type MarketDataReceivedPayload,
  type GraphUpdatedPayload,
  type EmbeddingComputedPayload,
  type PredictionGeneratedPayload,
  type CoherenceEvaluatedPayload,
  type ActionDecidedPayload,
  type OrderFilledPayload,
  type PositionChangedPayload,
  type CircuitBreakerTriggeredPayload,
  type KillSwitchActivatedPayload,
} from './shared/event-bus.js';

// Logger
export { createLogger, setLogLevel, type Logger, type LoggerContext } from './shared/logger.js';

// Config
export { appConfigSchema, type AppConfig } from './config/schema.js';
export { loadConfig, loadConfigFromEnv } from './config/app-config.js';

// WASM
export { WasmLoader, getWasmLoader } from './wasm/loader.js';
export { createMarketEvent, serializeMarketEvent, deserializeMarketEvent } from './wasm/market-event.js';
export { CoherenceGate, getCoherenceGate } from './wasm/coherence-gate.js';
export { ReplayStore, getReplayStore } from './wasm/replay-store.js';

// Bootstrap
import { loadConfig } from './config/app-config.js';
import { getWasmLoader } from './wasm/loader.js';
import { createLogger } from './shared/logger.js';
import type { AppConfig } from './config/schema.js';

const logger = createLogger({ component: 'bootstrap' });

export async function startNeuralTrader(configPath: string): Promise<{
  config: AppConfig;
  shutdown: () => Promise<void>;
}> {
  logger.info({ configPath }, 'Starting Neural Trader');

  const config = loadConfig(configPath);
  logger.info({ environment: config.environment, version: config.version }, 'Config loaded');

  const wasmLoader = getWasmLoader();
  await wasmLoader.init();
  const health = await wasmLoader.healthCheck();
  logger.info(health, 'WASM module initialized');

  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down Neural Trader');
    wasmLoader.reset();
  };

  logger.info('Neural Trader started successfully');
  return { config, shutdown };
}
