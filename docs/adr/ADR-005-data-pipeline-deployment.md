# ADR-005: Data Pipeline, Storage, and Deployment Topology

## Status

Proposed

## Date

2026-03-26

## Deciders

mschiaramonte

## Related

- RuVector ADR-085: Neural Trader RuVector architecture (schema, coherence, collections)
- RuVector ADR-086: Neural Trader WASM bindings
- ADR-004 (project-level): KV cache management patterns

## Context

ADR-085 defines the logical schema, collection layout, and coherence-gated architecture for neural-trader. This ADR specifies the concrete data pipeline from exchange WebSocket feeds through normalization, storage tiers, and deployment topology for both development and production environments. It also covers backtesting infrastructure, configuration management, and observability.

## Decision

### 1. Market Data Ingestion Pipeline

```
WS Feeds -> Ingest Workers -> Reorder Buffer -> Normalizer -> Event Bus
                                                                  |
                                              +--------+----------+----------+
                                              |        |          |          |
                                          GraphUpd  Postgres  Embedder  WitnessLog
```

**Ingest workers** maintain one persistent WebSocket connection per venue. Each worker:
1. Connects to the venue-specific feed (L2/L3 deltas, trades, session markers)
2. Stamps `ts_ingest_ns` on arrival using monotonic clock
3. Pushes raw frames into a per-venue reorder buffer (capacity: `reorder_buffer_events`, default 2048)
4. The reorder buffer sorts by `ts_exchange_ns` within `venue_clock_tolerance_ns` (default 500us)
5. Emits canonical `MarketEvent` envelopes to the internal event bus

**Normalization:** Prices and quantities use fixed-point `i64` with per-symbol multipliers. Event IDs are 128-bit hashes of `(venue_id, symbol_id, seq, ts_exchange_ns)`. Enums from `neural-trader-core`.

**Reconnection:** Exponential backoff (100ms base, 30s max) with jitter. Sequence gap detection triggers snapshot resync if supported by the venue.

### 2. Postgres Schema

We extend the ADR-085 schema (`nt_event_log`, `nt_embeddings` with HNSW, `nt_segments`) with operational tables:

```sql
CREATE TABLE nt_partition_registry (
    table_name     TEXT NOT NULL,
    partition_name TEXT NOT NULL PRIMARY KEY,
    range_start_ns BIGINT NOT NULL,
    range_end_ns   BIGINT NOT NULL,
    tier           TEXT NOT NULL DEFAULT 'hot',
    created_at     TIMESTAMPTZ DEFAULT now(),
    archived_at    TIMESTAMPTZ,
    dropped_at     TIMESTAMPTZ
);
CREATE INDEX idx_partition_tier ON nt_partition_registry (tier, range_start_ns);

CREATE TABLE nt_model_registry (
    model_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_name     TEXT NOT NULL,
    version        INT NOT NULL,
    artifact_path  TEXT NOT NULL,
    training_hash  BYTEA NOT NULL,
    metrics        JSONB NOT NULL,
    promoted_at    TIMESTAMPTZ,
    retired_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ DEFAULT now(),
    UNIQUE (model_name, version)
);

CREATE TABLE nt_policy_receipts (
    receipt_id     BIGSERIAL PRIMARY KEY,
    ts_ns          BIGINT NOT NULL,
    model_id       UUID REFERENCES nt_model_registry(model_id),
    action_type    TEXT NOT NULL,
    input_hash     BYTEA NOT NULL,
    coherence_hash BYTEA NOT NULL,
    policy_hash    BYTEA NOT NULL,
    token_id       BYTEA NOT NULL,
    result_hash    BYTEA NOT NULL,
    metadata       JSONB,
    created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_receipts_ts ON nt_policy_receipts (ts_ns DESC);
CREATE INDEX idx_receipts_model ON nt_policy_receipts (model_id, ts_ns DESC);
```

### 3. Three-Tier Data Retention

| Tier | Contents | Retention | Storage |
|------|----------|-----------|---------|
| Hot  | Recent graph state, live embeddings, active witness chain | 4 hours | Postgres (uncompressed), Redis graph cache |
| Warm | Signed replay segments, compressed embeddings, daily stats | 30 days | Postgres (TOAST-compressed), S3 for blobs |
| Cold | Training corpora, promoted model lineage, audit snapshots | 365 days | S3 Glacier / GCS Archive |

**Lifecycle automation** (cron every 6 hours, `vacuum_schedule_cron`):
1. **Hot to Warm:** Detach partitions older than 4h. Compress embeddings into quantized form, move to `nt_embeddings_archive`. Update `nt_partition_registry.tier`.
2. **Warm to Cold:** Export partitions older than 30d to Parquet on object storage. Drop Postgres partition after checksum confirmation.
3. **Cold purge:** Delete archives older than 365d.

Partition creation is pre-allocated 24 hours ahead at startup and extended on each cron run.

### 4. WASM Deployment Topology

**Node.js server (primary):** The WASM module (`@ruvector/neural-trader-wasm`) handles coherence evaluation, gate decisions, and replay segment construction in-process. Heavy I/O (Postgres, WebSocket) stays in Node.js native code. The WASM boundary uses JSON serialization for complex types and hex strings for `[u8; 16]` fields per ADR-086.

**Browser dashboard (optional):** The same WASM package runs in the browser for real-time coherence visualization (via SSE), client-side segment replay, and what-if gate evaluations. The browser receives pre-computed embeddings and graph snapshots; it never connects to exchanges or Postgres directly.

### 5. Configuration Management

Single YAML file extending the ADR-085 schema. Secrets use `${ENV_VAR}` substitution resolved at startup:

```yaml
neural_trader:
  symbol_universe: [ES, NQ, CL]
  ingest:
    venue_clock_tolerance_ns: 500000
    reorder_buffer_events: 2048
    reconnect_base_ms: 100
    reconnect_max_ms: 30000
  venues:
    - id: 1
      name: "exchange-a"
      ws_url: "${NT_VENUE_1_WS_URL}"
      feed_type: "l2_delta"
      symbols: [ES, NQ]
    - id: 2
      name: "exchange-b"
      ws_url: "${NT_VENUE_2_WS_URL}"
      feed_type: "l3_full"
      symbols: [CL]
  graph:
    max_local_levels_per_side: 32
    max_orders_per_window: 5000
    neighborhood_hops: 2
  embeddings: { dim: 256, quantized_dim: 256, similarity_metric: cosine }
  memory:
    stage_a: { count_min_width: 4096, count_min_depth: 4, topk: 256 }
    stage_b: { reservoir_size: 50000, min_uncertainty: 0.18, min_realized_impact_bp: 1.5 }
  coherence:
    mincut_floor_by_regime: { calm: 12, normal: 9, volatile: 6 }
    cusum_threshold: 4.5
    boundary_stability_windows: 8
  policy:
    max_notional_usd: 250000
    max_symbol_notional_usd: 50000
    max_order_rate_per_sec: 10
    max_cancel_rate_per_sec: 15
    max_slippage_bp: 2.0
    require_verified_token: true
  learning: { online_mode: bounded, allow_calibration_updates: true, allow_memory_write: true, allow_weight_updates: false }
  retention:
    hot_window_hours: 4
    warm_retention_days: 30
    cold_archive_days: 365
    partition_interval_ns: 3600000000000
    vacuum_schedule_cron: "0 */6 * * *"
  retrieval: { alpha: 0.4, beta: 0.25, gamma: 0.2, delta: 0.15 }
  postgres: { url: "${NT_POSTGRES_URL}", pool_min: 5, pool_max: 50, statement_timeout_ms: 5000 }
  redis: { url: "${NT_REDIS_URL}", graph_cache_ttl_sec: 300 }
  observability: { metrics_port: 9090, log_level: info, trace_sample_rate: 0.01 }
```

### 6. Monitoring and Observability

**Latency metrics** (Prometheus histograms, microseconds):

| Metric | Description | Alert |
|--------|-------------|-------|
| `nt_ingest_latency_us` | WS frame to event bus | p99 > 500us |
| `nt_gate_latency_us` | Coherence gate eval | p99 > 1ms |
| `nt_embedding_latency_us` | Single embedding | p99 > 2ms |
| `nt_retrieval_latency_us` | Hybrid retrieval | p99 > 5ms |
| `nt_e2e_latency_us` | Ingest to action decision | p99 > 10ms |

**Throughput counters:** `nt_events_ingested_total` (by venue/symbol), `nt_gate_decisions_total` (by outcome/type), `nt_memory_writes_total`, `nt_policy_receipts_total`.

**Coherence gauges:** `nt_mincut_value` (by symbol), `nt_cusum_score` (by symbol), `nt_drift_score`, `nt_regime_current`.

**Health:** `/health` (process alive), `/ready` (Postgres reachable, venues connected, WASM `healthCheck()` passes).

### 7. Development vs Production Topology

**Development:** Single Node.js process with WASM in-process. Postgres and Redis via Docker Compose (`docker-compose.dev.yml`). Market data replayed from local Parquet/CSV files via the backtesting harness. No broker connections. Metrics on localhost only.

**Production:** Containers on Kubernetes or Cloud Run. Per-venue ingest workers (2-4). In-process event bus (or NATS if horizontally scaled). Postgres primary + 1 read replica with pgvector and hourly partitions. Redis cluster for graph cache. S3/GCS for warm and cold tiers. Secrets from Kubernetes Secrets or GCP Secret Manager. Prometheus + Grafana for metrics; structured JSON logs to stdout.

### 8. Backtesting Infrastructure

Backtesting replays historical data through the identical pipeline used in production, ensuring no train/serve skew.

**Replay harness:**
1. Reads historical events from Parquet (cold tier) or Postgres (warm tier)
2. Emits events to the event bus at configurable speed
3. Replaces live WS ingest; all downstream components are identical
4. Time is virtualized: `ts_exchange_ns` from replay data drives all time-dependent logic

**Replay modes:**

| Mode | Speed | Use Case |
|------|-------|----------|
| `realtime` | 1x wall clock | Latency-realistic simulation |
| `accelerated` | 10x-100x | Rapid strategy iteration |
| `burst` | Max throughput | Training data generation |

**Walk-forward validation:** Training window (default 5 days) followed by validation window (default 1 day), advancing and collecting per-window metrics. Coherence-gated vs ungated baselines compared on slippage-adjusted PnL, memory write rate, and false actuation rate.

**Outputs:** Per-window PnL curves with coherence annotations, gate decision logs, embedding drift timeseries, regime transition accuracy.

**Data preparation:** `npm run backtest:prepare` downloads and validates required date ranges from object storage into a local replay directory, using `nt_partition_registry` to track availability.

## Consequences

### Positive
- Single pipeline for live and backtesting ensures no train/serve skew
- Three-tier retention keeps storage costs bounded while preserving audit trail
- WASM deployment enables browser-based research without separate backend
- Environment variable substitution keeps secrets out of configuration files
- Comprehensive metrics enable early detection of pipeline degradation

### Negative
- Postgres partitioning adds operational complexity (partition creation, lifecycle)
- WASM serialization boundary introduces overhead for high-frequency gate evaluation
- Single YAML config may become unwieldy; may need per-component splits later

### Risks
- WebSocket reconnection during volatile markets may cause sequence gaps
- WASM `wasm-opt` disabled due to Rust 1.91 codegen bug (ADR-086); binary size is larger than optimal
- Cold tier retrieval latency may be too slow for ad-hoc backtesting without pre-staging

## References

- RuVector ADR-085: Neural Trader RuVector architecture
- RuVector ADR-086: Neural Trader WASM bindings
- RuVector ADR-084: ruvllm-wasm Rust 1.91 workaround
- PostgreSQL partitioning documentation
- pgvector HNSW indexing reference
