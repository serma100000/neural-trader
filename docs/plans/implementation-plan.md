# Neural Trader Implementation Plan

**Status**: Draft
**Created**: 2026-03-26
**Target**: 13-week build, paper-trading by week 13

---

## Existing Foundation (RuVector Submodule)

| Layer | Crate | Key Exports |
|-------|-------|-------------|
| L1 Ingest | `neural-trader-core` | `MarketEvent`, 7 `EventType`s, 10 `NodeKind`s, 12 `EdgeKind`s, 17 `PropertyKey`s, `GraphDelta`, `EventIngestor`/`GraphUpdater`/`Embedder` traits, `StateWindow` |
| L4 Memory | `neural-trader-replay` | `ReplaySegment`, 7 `SegmentKind`s, `ReservoirStore`, `MemoryStore` trait, `WitnessReceipt`, `InMemoryReceiptLog` |
| L5 Coherence | `neural-trader-coherence` | `ThresholdGate`, `CoherenceDecision`, `GateConfig`, `GateContext`, `RegimeLabel`, `VerifiedToken`, `WitnessLogger` trait |
| WASM | `neural-trader-wasm` | All above exposed via `wasm_bindgen` (`@ruvector/neural-trader-wasm`) |

**Available RuVector crates**: `ruvector-graph`, `ruvector-gnn`, `ruvector-attention` (46 mechanisms), `ruvector-mincut`, `ruvector-postgres`, `ruvector-graph-transformer`, `ruvector-mincut-gated-transformer`, `ruvector-hyperbolic-hnsw`, `ruvector-temporal-tensor`, `ruvector-verified`, and 90+ more.

---

## Phase 1 -- Foundation (Weeks 1-3)

### 1.1 Project Scaffolding (Week 1)

**Deliverables:**

- `src/index.ts` -- application entry point
- `src/config/` -- environment config loader, schema validation
  - `src/config/app-config.ts` -- typed config interface
  - `src/config/schema.ts` -- Zod validation schemas
- `src/shared/` -- shared kernel (types, errors, event bus)
  - `src/shared/types.ts` -- domain primitives (SymbolId, VenueId, Timestamp)
  - `src/shared/errors.ts` -- typed error hierarchy
  - `src/shared/event-bus.ts` -- in-process pub/sub for DDD events
  - `src/shared/logger.ts` -- structured logging wrapper
- `src/wasm/` -- WASM binding loader and typed wrappers
  - `src/wasm/loader.ts` -- lazy init of `@ruvector/neural-trader-wasm`
  - `src/wasm/market-event.ts` -- TS facade over `MarketEventWasm`
  - `src/wasm/coherence-gate.ts` -- TS facade over `ThresholdGateWasm`
  - `src/wasm/replay-store.ts` -- TS facade over `ReservoirStoreWasm`
- `tsconfig.json`, `package.json` updates (TypeScript, Vitest, ESLint)
- `config/default.toml` -- default runtime configuration

**Dependencies:** None (greenfield).

**Acceptance criteria:**
- `npm run build` produces clean output with strict TypeScript
- `npm test` passes with WASM loader smoke test (`healthCheck() === true`)
- Config loads from TOML with Zod validation, rejects invalid input
- Event bus delivers typed domain events between bounded contexts

**Risks:**
- WASM binary size may impact startup time. **Mitigation**: lazy-load WASM module, measure load time in CI.
- BigInt serialization across WASM boundary. **Mitigation**: use existing `serde_wasm_bindgen` BigInt-safe serializer already in the WASM crate.

### 1.2 L2 Graph Layer (Weeks 1-2)

**Deliverables:**

- `src/graph/` -- L2 bounded context
  - `src/graph/market-graph.ts` -- `MarketGraph` class wrapping `ruvector-graph` (via its npm node addon `@ruvector/graph-node`)
  - `src/graph/graph-updater.ts` -- implements `GraphUpdater` logic in TS, maps `MarketEvent` to node/edge mutations using `NodeKind`/`EdgeKind` enums from WASM
  - `src/graph/schema.ts` -- graph schema constants (node/edge/property type registrations)
  - `src/graph/sliding-window.ts` -- manages temporal windowing, evicts stale nodes/edges (configurable TTL per `NodeKind`)
  - `src/graph/subgraph-extractor.ts` -- extracts k-hop ego subgraph around a symbol for GNN input
- `tests/graph/market-graph.test.ts` -- unit tests with mock events
- `tests/graph/graph-updater.test.ts` -- property-based tests for delta correctness

**Dependencies:** 1.1 (WASM loader, shared types).

**Acceptance criteria:**
- Ingesting 1000 synthetic `MarketEvent`s produces a graph with correct node/edge counts per kind
- Subgraph extraction returns consistent k-hop neighborhoods
- Sliding window eviction keeps graph under configured memory ceiling
- All 10 `NodeKind` and 12 `EdgeKind` values are exercised in tests

**Risks:**
- `@ruvector/graph-node` N-API addon may have platform-specific build issues. **Mitigation**: fall back to pure-TS adjacency list for dev; gate on native addon for production.

### 1.3 Market Data Ingestion (Weeks 2-3)

**Deliverables:**

- `src/ingest/` -- L1 bounded context (TS orchestration layer)
  - `src/ingest/feed-adapter.ts` -- abstract `FeedAdapter` interface
  - `src/ingest/ws-feed-adapter.ts` -- WebSocket feed adapter (exchange-agnostic base)
  - `src/ingest/binance-adapter.ts` -- Binance book/trade stream normalization
  - `src/ingest/normalizer.ts` -- raw JSON to `MarketEvent` conversion (fixed-point price encoding, UUID generation)
  - `src/ingest/sequencer.ts` -- assigns monotonic sequence numbers, detects gaps
  - `src/ingest/ingest-pipeline.ts` -- orchestrates: connect, normalize, sequence, push to graph + event bus
- `tests/ingest/normalizer.test.ts` -- round-trip tests with recorded exchange payloads
- `tests/ingest/sequencer.test.ts` -- gap detection tests

**Dependencies:** 1.1 (shared types), 1.2 (graph layer for push target).

**Acceptance criteria:**
- Connects to Binance testnet WebSocket, normalizes depth and trade messages into `MarketEvent`
- Sequence gaps are detected and logged within 1 second
- Normalizer correctly encodes prices to `i64` fixed-point (`price * 1e8`)
- Pipeline pushes events through graph updater at >10k events/sec on dev hardware

**Risks:**
- Exchange rate limits during development. **Mitigation**: record and replay from fixture files; only hit live feeds in integration tests.

### 1.4 Postgres Schema (Week 3)

**Deliverables:**

- `src/storage/` -- persistence bounded context
  - `src/storage/pg-client.ts` -- typed Postgres client wrapper (using `pg` or `postgres` npm)
  - `src/storage/migrations/001-init.sql` -- events table (partitioned by day), segments table, receipts table
  - `src/storage/migrations/002-indexes.sql` -- symbol_id + ts_ns composite indexes, GIN on segment labels
  - `src/storage/event-repo.ts` -- `EventRepository` (batch insert, range query by symbol+time)
  - `src/storage/segment-repo.ts` -- `SegmentRepository` (write with coherence check, retrieve by embedding similarity via `pgvector`)
- `scripts/migrate.ts` -- migration runner
- `tests/storage/event-repo.test.ts` -- integration tests against testcontainers Postgres

**Dependencies:** 1.1 (shared types).

**Acceptance criteria:**
- Migrations run idempotently; `migrate.ts` applies all pending migrations
- Batch insert of 10k events completes in <500ms
- Range query by `(symbol_id, ts_range)` uses index scan (verified via `EXPLAIN`)
- Segment table stores `embedding` column as `vector(128)` for future similarity search

**Risks:**
- `pgvector` extension availability in target Postgres. **Mitigation**: migration checks for extension, falls back to cosine distance UDF if unavailable.

---

## Phase 2 -- Intelligence (Weeks 4-6)

### 2.1 L3 GNN + Attention Pipeline (Weeks 4-5)

**Deliverables:**

- `src/gnn/` -- L3 bounded context
  - `src/gnn/gnn-engine.ts` -- wraps `@ruvector/gnn-node` N-API addon; configures message-passing layers, aggregation, and readout
  - `src/gnn/attention-pool.ts` -- wraps `@ruvector/attention-node`; applies graph-level attention pooling (configurable mechanism from the 46 available)
  - `src/gnn/temporal-encoder.ts` -- temporal positional encoding using `ruvector-temporal-tensor` concepts (sinusoidal + learned)
  - `src/gnn/pipeline.ts` -- end-to-end: subgraph extraction, feature matrix construction, GNN forward pass, attention pooling, output embedding
  - `src/gnn/feature-builder.ts` -- converts graph node properties (17 `PropertyKey`s) into feature tensors
- `tests/gnn/pipeline.test.ts` -- end-to-end test with synthetic graph, verifies output dimension
- `tests/gnn/feature-builder.test.ts` -- property coverage tests

**Dependencies:** 1.2 (graph layer, subgraph extractor).

**Acceptance criteria:**
- GNN forward pass on a 500-node subgraph completes in <50ms
- Output embedding dimension matches configured value (default 128)
- All 17 `PropertyKey` features are included in the feature matrix
- Attention weights are retrievable for interpretability

**Risks:**
- N-API addon memory management under high throughput. **Mitigation**: use explicit `Buffer` pinning, add memory pressure tests.

### 2.2 Embedding Generation -- 6 Families (Week 5)

**Deliverables:**

- `src/embeddings/` -- embedding orchestration
  - `src/embeddings/families.ts` -- enum and config for 6 embedding families:
    1. **Structural**: GNN readout from market graph topology
    2. **Temporal**: windowed sequence encoding of recent events
    3. **Order-flow**: bid/ask imbalance, trade flow, cancel rates
    4. **Volatility**: realized vol, GARCH residuals, vol surface features
    5. **Regime**: coherence state embedding (mincut, CUSUM, drift scores)
    6. **Cross-asset**: correlation graph features across symbols
  - `src/embeddings/composer.ts` -- concatenates/projects family embeddings into unified vector
  - `src/embeddings/cache.ts` -- LRU cache keyed by `(symbol_id, window_hash)` to avoid redundant computation
- `tests/embeddings/composer.test.ts` -- verifies output dimension = sum of family dims after projection

**Dependencies:** 2.1 (GNN pipeline), 1.2 (graph), 1.3 (ingest for live features).

**Acceptance criteria:**
- Each family produces a well-defined embedding dimension
- Composer output is a single `Float32Array` of configurable total dimension
- Cache hit rate >80% during steady-state operation with 100ms tick interval
- NaN/Inf values are detected and replaced with safe defaults (logged as warnings)

### 2.3 Prediction Heads (Week 6)

**Deliverables:**

- `src/heads/` -- prediction head bounded context
  - `src/heads/head-registry.ts` -- registry pattern for pluggable heads
  - `src/heads/mid-price.ts` -- mid-price move prediction (regression, horizons: 100ms, 1s, 10s)
  - `src/heads/fill-prob.ts` -- limit order fill probability (binary classification)
  - `src/heads/cancel-prob.ts` -- order cancellation probability (binary classification)
  - `src/heads/slippage.ts` -- execution slippage estimator (regression)
  - `src/heads/vol-jump.ts` -- volatility jump detector (binary + magnitude)
  - `src/heads/regime-transition.ts` -- regime transition probability (3-class: Calm/Normal/Volatile)
  - `src/heads/ensemble.ts` -- weighted ensemble combining head outputs with coherence-gated confidence
- `tests/heads/` -- one test file per head with synthetic embeddings

**Dependencies:** 2.2 (embedding composer provides input to all heads).

**Acceptance criteria:**
- Each head accepts a `Float32Array` embedding and returns typed prediction + confidence interval
- Head outputs include uncertainty estimates (e.g., MC dropout or ensemble variance)
- Ensemble respects coherence gate: if `allow_learn === false`, heads freeze weights
- All 6 heads registered and callable through `HeadRegistry`

### 2.4 Offline Training Pipeline (Week 6)

**Deliverables:**

- `src/training/` -- training bounded context
  - `src/training/data-loader.ts` -- loads replay segments from Postgres, constructs `(embedding, label)` pairs
  - `src/training/trainer.ts` -- training loop: forward pass through heads, loss computation, gradient step (WASM or ONNX runtime)
  - `src/training/checkpoint.ts` -- model checkpoint save/load to disk and Postgres
  - `src/training/metrics.ts` -- training metrics: loss curves, per-head accuracy, calibration plots
- `scripts/train.ts` -- CLI entry point for offline training
- `tests/training/trainer.test.ts` -- trains for 10 steps on synthetic data, verifies loss decreases

**Dependencies:** 2.3 (heads), 1.4 (Postgres segment storage).

**Acceptance criteria:**
- Training on 1000 replay segments completes without OOM
- Checkpoints are reproducibly loadable (same weights produce same predictions on fixed input)
- Per-head metrics are logged in structured format suitable for dashboard consumption
- Training respects coherence gate: segments with `coherence_stats.drift_score > threshold` are excluded

**Risks:**
- ONNX runtime may not support all needed ops. **Mitigation**: start with simple MLP heads, escalate to transformer heads only after validating runtime compatibility.

---

## Phase 3 -- Action (Weeks 7-9)

### 3.1 L6 Policy Kernel (Weeks 7-8)

**Deliverables:**

- `src/policy/` -- L6 bounded context
  - `src/policy/policy-kernel.ts` -- core decision engine: takes head predictions + coherence decision, emits `ActionIntent`
  - `src/policy/action-intent.ts` -- typed action intents: `PlaceLimitOrder`, `CancelOrder`, `ModifyOrder`, `NoOp`, `ReduceExposure`
  - `src/policy/constraints.ts` -- hard constraints: max position size, max notional, max orders per symbol, sector limits
  - `src/policy/scoring.ts` -- action scoring: expected PnL, risk-adjusted return, coherence penalty
  - `src/policy/proof-gate.ts` -- issues `VerifiedToken` by combining coherence hash + policy hash; only verified intents proceed
- `tests/policy/policy-kernel.test.ts` -- decision matrix tests across regime/confidence combinations
- `tests/policy/constraints.test.ts` -- boundary condition tests for all hard limits

**Dependencies:** 2.3 (head predictions), L5 coherence (WASM).

**Acceptance criteria:**
- Policy never emits `PlaceLimitOrder` when coherence `allow_act === false`
- Hard constraints are enforced regardless of head confidence (no override path)
- Every action intent carries a `VerifiedToken` with traceable hashes
- `NoOp` is the default when uncertainty exceeds configured threshold

### 3.2 Risk Budget Management (Week 8)

**Deliverables:**

- `src/risk/` -- risk management bounded context
  - `src/risk/risk-budget.ts` -- hierarchical budget: portfolio-level, sector-level, symbol-level
  - `src/risk/drawdown-monitor.ts` -- rolling drawdown tracking; circuit breaker at configurable thresholds (e.g., 2% daily, 5% weekly)
  - `src/risk/position-sizer.ts` -- Kelly-criterion-based position sizing with half-Kelly default
  - `src/risk/exposure-tracker.ts` -- real-time gross/net exposure tracking
  - `src/risk/circuit-breaker.ts` -- automatic halt: kills all open orders, flattens positions if drawdown breached
- `tests/risk/drawdown-monitor.test.ts` -- simulated PnL sequences triggering circuit breaker
- `tests/risk/position-sizer.test.ts` -- Kelly sizing edge cases (negative edge, max cap)

**Dependencies:** 3.1 (policy kernel feeds risk checks).

**Acceptance criteria:**
- Circuit breaker fires within 1 tick of drawdown threshold breach
- Position sizer never exceeds symbol-level or portfolio-level limits
- Budget allocations sum to <= 100% of total capital at all times
- All risk state changes are logged as domain events on the event bus

### 3.3 Paper Trading Adapter (Week 9)

**Deliverables:**

- `src/execution/` -- execution bounded context
  - `src/execution/broker-adapter.ts` -- abstract `BrokerAdapter` interface
  - `src/execution/paper-adapter.ts` -- simulated exchange: maintains order book state, matches at mid-price with configurable slippage model
  - `src/execution/order-manager.ts` -- tracks open orders, handles fills/cancels, updates positions
  - `src/execution/position-tracker.ts` -- real-time position, PnL, and fee tracking
  - `src/execution/fill-journal.ts` -- append-only fill log with witness hashes
- `tests/execution/paper-adapter.test.ts` -- simulated order lifecycle tests
- `tests/execution/position-tracker.test.ts` -- PnL accuracy with fees

**Dependencies:** 3.1 (policy kernel emits action intents), 3.2 (risk budget checks).

**Acceptance criteria:**
- Paper adapter correctly simulates limit order fills, partial fills, and cancels
- Position tracker PnL matches manual calculation to within 1 basis point
- Fill journal entries carry `WitnessReceipt` hashes linking back to coherence state
- Order lifecycle events flow through event bus for monitoring

### 3.4 Proof-Gated Mutation Flow (Week 9)

**Deliverables:**

- `src/proof/` -- proof and audit bounded context
  - `src/proof/mutation-flow.ts` -- orchestrates: coherence check, policy check, token issuance, execution, witness logging
  - `src/proof/witness-logger.ts` -- implements `WitnessLogger` trait in TS; persists `WitnessReceipt` to Postgres
  - `src/proof/audit-trail.ts` -- queryable audit trail: find all mutations for a time range, symbol, or policy version
- `tests/proof/mutation-flow.test.ts` -- end-to-end: event arrives, coherence passes, policy approves, order placed, receipt logged

**Dependencies:** 3.1 (policy), 3.3 (execution), L5 coherence (WASM).

**Acceptance criteria:**
- Every state mutation (order placement, position change, model update) has a `WitnessReceipt`
- Audit trail query returns complete chain from market event to execution outcome
- Tampered receipts are detectable via hash chain validation
- No mutation can bypass the proof gate (enforced at the type level via `VerifiedToken` requirement)

---

## Phase 4 -- Integration and Hardening (Weeks 10-12)

### 4.1 End-to-End Pipeline (Week 10)

**Deliverables:**

- `src/pipeline/` -- pipeline orchestration
  - `src/pipeline/live-pipeline.ts` -- wires all layers: ingest, graph, GNN, heads, policy, risk, execution, proof
  - `src/pipeline/tick-loop.ts` -- main event loop: processes events in micro-batches, respects backpressure
  - `src/pipeline/health-check.ts` -- component health aggregator (WASM loaded, DB connected, feed alive, graph size)
- `tests/pipeline/integration.test.ts` -- full pipeline with recorded market data, paper execution, receipt verification

**Dependencies:** All Phase 1-3 deliverables.

**Acceptance criteria:**
- Pipeline processes recorded 1-hour BTC/USDT data end-to-end without errors
- Latency from event arrival to policy decision <100ms at p99
- Health check reports all components green under normal operation
- Graceful degradation: if GNN is slow, pipeline continues with stale embeddings (logged)

### 4.2 Backtesting Infrastructure (Weeks 10-11)

**Deliverables:**

- `src/backtest/` -- backtesting bounded context
  - `src/backtest/replay-engine.ts` -- replays historical events from Postgres at configurable speed (1x to max)
  - `src/backtest/backtest-runner.ts` -- runs a strategy config against a date range, collects fills and PnL
  - `src/backtest/walk-forward.ts` -- walk-forward validation: train on window N, test on window N+1, slide
  - `src/backtest/report.ts` -- generates structured report: Sharpe, Sortino, max drawdown, win rate, profit factor
- `scripts/backtest.ts` -- CLI entry point: `npx ts-node scripts/backtest.ts --config config/btc-usdt.toml --from 2025-01-01 --to 2025-12-31`
- `tests/backtest/walk-forward.test.ts` -- validates window sliding logic

**Dependencies:** 4.1 (live pipeline, reused in replay mode), 1.4 (Postgres data).

**Acceptance criteria:**
- Backtest produces deterministic results given same data and config
- Walk-forward generates train/test splits with zero lookahead
- Report metrics match manual spot-check on a known 1-day sample
- Backtest of 30 days of data completes in <10 minutes

### 4.3 Monitoring Dashboard (Week 11)

**Deliverables:**

- `src/api/` -- serving layer
  - `src/api/http-server.ts` -- Express/Fastify HTTP server
  - `src/api/ws-server.ts` -- WebSocket server for real-time dashboard updates
  - `src/api/routes/health.ts` -- `GET /health` endpoint
  - `src/api/routes/predictions.ts` -- `GET /predictions/:symbol` -- latest head outputs
  - `src/api/routes/positions.ts` -- `GET /positions` -- current positions and PnL
  - `src/api/routes/coherence.ts` -- `GET /coherence/:symbol` -- gate status, mincut, drift
  - `src/api/routes/audit.ts` -- `GET /audit` -- recent witness receipts
- `src/api/ws-channels.ts` -- real-time channels: `ticks`, `predictions`, `fills`, `alerts`

**Dependencies:** 4.1 (pipeline provides data), 3.3 (position tracker).

**Acceptance criteria:**
- All REST endpoints return typed JSON with <50ms latency
- WebSocket pushes prediction updates within 1 tick of computation
- Dashboard shows: live positions, PnL curve, coherence status, head confidence, recent fills
- Authentication via API key header (no public exposure)

### 4.4 Performance Optimization (Week 12)

**Deliverables:**

- `src/perf/` -- performance utilities
  - `src/perf/profiler.ts` -- per-stage latency instrumentation (ingest, graph update, GNN, heads, policy)
  - `src/perf/batch-optimizer.ts` -- dynamic micro-batch sizing based on event arrival rate
  - `src/perf/memory-monitor.ts` -- tracks WASM heap, Node.js RSS, graph node count; alerts on threshold
- `scripts/benchmark.ts` -- throughput benchmark: events/sec, latency percentiles
- Performance tuning of graph sliding window, GNN batch size, embedding cache

**Dependencies:** 4.1 (full pipeline to measure).

**Acceptance criteria:**
- Sustained throughput >10k events/sec for a single symbol
- Event-to-decision latency <100ms at p99 under production load
- Memory usage stable over 24-hour simulated run (no unbounded growth)
- Benchmark results documented in `docs/performance-baseline.md`

**Risks:**
- GNN N-API overhead may dominate latency. **Mitigation**: profile first, consider WASM-based GNN fallback or batching strategy.

---

## Phase 5 -- Live Research (Weeks 13+)

### 5.1 Live Paper Trading Deployment (Week 13)

**Deliverables:**

- `config/paper-live.toml` -- production paper trading config (Binance testnet)
- `scripts/run-paper.ts` -- daemon entry point with graceful shutdown
- Systemd/PM2 process config for long-running operation
- Alerting: Slack/Discord webhook on circuit breaker, coherence collapse, feed disconnect

**Dependencies:** All Phase 4 deliverables.

**Acceptance criteria:**
- Runs continuously for 48 hours on Binance testnet without crash or memory leak
- Circuit breaker fires correctly on simulated drawdown injection
- All alerts delivered within 30 seconds of trigger event
- Witness receipt chain is unbroken for the full 48-hour run

### 5.2 Small Capital Bounded Execution (Week 14+)

**Deliverables:**

- `src/execution/live-adapter.ts` -- real exchange adapter (Binance spot, initially)
- `src/risk/capital-cap.ts` -- hard capital ceiling (configurable, default $100)
- Additional risk guardrails: max 1 open position, max $10 per trade, kill switch API endpoint

**Dependencies:** 5.1 (proven stable in paper).

**Acceptance criteria:**
- Capital cap enforced at adapter level (cannot be overridden by policy)
- Kill switch endpoint immediately cancels all orders and flattens positions
- 7-day live run with bounded capital produces audit trail matching paper trading behavior
- Slippage vs. paper model deviation tracked and reported

### 5.3 Daily Audit Pipeline (Week 14+)

**Deliverables:**

- `scripts/daily-audit.ts` -- nightly job: validates witness chain, reconciles fills, generates PnL report
- `src/audit/reconciler.ts` -- compares internal position state vs. exchange reported balances
- `src/audit/chain-validator.ts` -- verifies hash chain integrity of all `WitnessReceipt`s for the day

**Dependencies:** 5.2 (live execution data to audit).

**Acceptance criteria:**
- Reconciliation detects intentionally injected 1-cent discrepancy in test fixture
- Chain validator detects intentionally tampered receipt hash in test fixture
- Daily report includes: PnL, Sharpe (rolling 30d), max drawdown, coherence uptime %, head accuracy

### 5.4 Continuous Regime Monitoring (Week 15+)

**Deliverables:**

- `src/monitoring/regime-tracker.ts` -- long-running regime classification with transition alerts
- `src/monitoring/drift-detector.ts` -- embedding drift monitoring with automatic model staleness detection
- `src/monitoring/model-health.ts` -- per-head calibration monitoring; triggers retrain when calibration degrades

**Dependencies:** 5.1 (live pipeline producing regime data).

**Acceptance criteria:**
- Regime transitions detected within 5 seconds of structural change
- Model staleness alert fires when head calibration error exceeds 2x baseline
- Drift detector correctly identifies synthetic distribution shift in test fixture

---

## Critical Path

```
1.1 Scaffolding
 +-> 1.2 Graph Layer
 |    +-> 2.1 GNN Pipeline
 |         +-> 2.2 Embeddings
 |              +-> 2.3 Heads
 |                   +-> 3.1 Policy Kernel
 |                        +-> 3.3 Paper Adapter
 |                             +-> 4.1 End-to-End Pipeline
 |                                  +-> 4.2 Backtesting
 |                                       +-> 5.1 Live Paper
 +-> 1.3 Ingest (parallel with 1.2)
 +-> 1.4 Postgres (parallel with 1.2, 1.3)
```

Tasks off the critical path (can proceed in parallel):
- 3.2 Risk Budget (after 3.1, parallel with 3.3)
- 3.4 Proof-Gated Flow (after 3.1 + 3.3)
- 4.3 Dashboard (after 4.1, parallel with 4.2)
- 4.4 Performance (after 4.1, parallel with 4.2)

---

## Cross-Cutting Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| N-API addon build failures on CI | Blocks GNN/graph layers | Medium | Maintain pure-TS fallbacks; pin native addon versions |
| WASM memory leaks under sustained load | OOM in production | Medium | Explicit `.free()` calls on WASM objects; memory monitor with auto-restart |
| Exchange API breaking changes | Ingest pipeline failure | Low | Abstract adapter interface; version-pin API payloads in normalizer |
| Model overfitting on limited historical data | Poor live performance | High | Walk-forward validation; minimum 6-month history before live; coherence gate blocks stale models |
| Coherence gate too conservative | System never trades | Medium | Configurable thresholds per regime; backtest with various gate configs; log all rejections for tuning |
| Regulatory/compliance exposure | Legal risk | Low | Paper trading only for initial months; bounded capital cap; full audit trail |
