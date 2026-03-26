import { z } from 'zod';

const venueSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string(),
  adapter: z.string(),
  ws_url: z.string().url().optional(),
  rest_url: z.string().url().optional(),
  rate_limit_rps: z.number().positive().optional(),
  reconnect_delay_ms: z.number().int().positive().default(1000),
  max_reconnect_attempts: z.number().int().positive().default(10),
});

const symbolSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string(),
  venue_id: z.number().int().nonnegative(),
  base: z.string(),
  quote: z.string(),
  tick_size: z.string(),
  lot_size: z.string(),
  min_notional: z.string().optional(),
});

const graphSchema = z.object({
  max_nodes: z.number().int().positive().default(1_000_000),
  max_edges: z.number().int().positive().default(5_000_000),
  gc_interval_s: z.number().positive().default(60),
  gc_ttl_s: z.number().positive().default(300),
  property_keys: z.array(z.string()).optional(),
});

const embeddingSchema = z.object({
  dimensions: z.number().int().positive().default(64),
  window_ticks: z.number().int().positive().default(100),
  update_interval_ms: z.number().int().positive().default(50),
  model: z.enum(['reservoir', 'gnn', 'hybrid']).default('reservoir'),
});

const coherenceSchema = z.object({
  mincut_threshold: z.number().positive().default(0.5),
  drift_window: z.number().int().positive().default(1000),
  cusum_h: z.number().positive().default(4.0),
  cusum_k: z.number().positive().default(0.5),
  regime_thresholds: z.object({
    calm: z.number().positive().default(0.3),
    normal: z.number().positive().default(0.5),
    volatile: z.number().positive().default(0.8),
  }).default({}),
  evaluation_interval_ms: z.number().int().positive().default(100),
});

const riskSchema = z.object({
  max_position_usd: z.number().positive().default(10000),
  max_daily_loss_usd: z.number().positive().default(1000),
  max_order_size_usd: z.number().positive().default(1000),
  max_open_orders: z.number().int().positive().default(10),
  kill_switch_loss_usd: z.number().positive().default(5000),
  circuit_breaker_drawdown_pct: z.number().positive().max(100).default(5),
});

const strategySchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  symbols: z.array(z.number().int().nonnegative()),
  params: z.record(z.unknown()).default({}),
});

const storageSchema = z.object({
  postgres: z.object({
    host: z.string().default('localhost'),
    port: z.number().int().positive().default(5432),
    database: z.string().default('neural_trader'),
    user: z.string().default('neural_trader'),
    password: z.string().default(''),
    max_connections: z.number().int().positive().default(10),
  }).default({}),
  event_retention_days: z.number().int().positive().default(30),
  snapshot_interval_s: z.number().int().positive().default(300),
});

const serverSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().int().positive().default(8080),
  ws_path: z.string().default('/ws'),
  api_prefix: z.string().default('/api/v1'),
});

const telemetrySchema = z.object({
  enabled: z.boolean().default(true),
  metrics_port: z.number().int().positive().default(9090),
  log_level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export const appConfigSchema = z.object({
  version: z.string().default('0.1.0'),
  environment: z.enum(['development', 'staging', 'production']).default('development'),
  venues: z.array(venueSchema).default([]),
  symbols: z.array(symbolSchema).default([]),
  graph: graphSchema.default({}),
  embedding: embeddingSchema.default({}),
  coherence: coherenceSchema.default({}),
  risk: riskSchema.default({}),
  strategies: z.array(strategySchema).default([]),
  storage: storageSchema.default({}),
  server: serverSchema.default({}),
  telemetry: telemetrySchema.default({}),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type VenueConfig = z.infer<typeof venueSchema>;
export type SymbolConfig = z.infer<typeof symbolSchema>;
export type GraphConfig = z.infer<typeof graphSchema>;
export type EmbeddingConfig = z.infer<typeof embeddingSchema>;
export type CoherenceConfig = z.infer<typeof coherenceSchema>;
export type RiskConfig = z.infer<typeof riskSchema>;
export type StrategyConfig = z.infer<typeof strategySchema>;
export type StorageConfig = z.infer<typeof storageSchema>;
export type ServerConfig = z.infer<typeof serverSchema>;
export type TelemetryConfig = z.infer<typeof telemetrySchema>;
