# ADR-001: Neural Trader Project Architecture — TypeScript Orchestration over RuVector WASM Crates

## Status

Proposed

## Date

2026-03-26

## Deciders

mschiaramonte

## Related

- RuVector ADR-085: Neural Trader — Dynamic Market Graphs, MinCut Coherence Gating, and Proof-Gated Mutation
- RuVector ADR-016: RuVector integration patterns
- RuVector ADR-047: Proof-gated mutation protocol
- `@ruvector/neural-trader-wasm` npm package
- `./RuVector/` git submodule

## Context

RuVector ADR-085 defines a six-layer neural trading architecture. Three of those layers already exist as Rust crates with WASM bindings:

- **L1 (Ingest):** `neural-trader-core` — MarketEvent struct, EventIngestor/GraphUpdater/Embedder traits, 7 event types, 10 node kinds, 12 edge types, 17 property keys
- **L4 (Memory):** `neural-trader-replay` — ReplaySegment with 7 segment kinds, ReservoirStore, MemoryStore trait, WitnessReceipt
- **L5 (Coherence):** `neural-trader-coherence` — ThresholdGate, CoherenceDecision, regime-adaptive MinCut thresholds (Calm:12, Normal:9, Volatile:6), CUSUM drift detection

The WASM package `neural-trader-wasm` exposes all three crates to browser and Node.js environments.

Three layers remain unbuilt:

- **L2 (Graph):** Dynamic heterogeneous market graph
- **L3 (GNN+Attention):** Temporal GNN embeddings with attention mechanisms
- **L6 (Policy):** Policy kernel, risk budgets, broker adapters, proof-gated order execution

This project exists to build those three missing layers, integrate them with the existing three, and provide a complete serving layer for research and paper trading.

The primary constraint is that the Rust crates are owned by the upstream RuVector repository and must not be forked or modified here. We consume them as a git submodule and interact with them through their published WASM bindings.

## Decision

We will build the neural-trader project as a TypeScript/Rust hybrid system:

1. **TypeScript** is the primary language for orchestration, domain logic, API serving, and workflow coordination.
2. **Rust compiled to WASM** handles compute-heavy paths: graph operations, GNN forward passes, attention computation, mincut evaluation, and embedding generation.
3. **RuVector crates** are consumed via the `./RuVector/` git submodule and the `@ruvector/neural-trader-wasm` npm package. We do not modify upstream crates.
4. **New Rust/WASM modules** will be authored in this repository for L2/L3/L6 compute kernels that require native performance.
5. **Node.js** is the runtime. No browser deployment is planned for the initial phases.
6. **PostgreSQL** is the relational source of record, following the schema patterns defined in ADR-085.
7. **Event-driven architecture** with DDD bounded contexts structures the TypeScript layer.

## Architecture Overview

### Layer Integration Map

```
L6  Policy         [NEW - TypeScript + WASM kernel]
 |                    Policy kernel, risk budgets, broker adapters,
 |                    proof-gated order execution
 v
L5  Coherence      [EXISTING - neural-trader-coherence via WASM]
 |                    ThresholdGate, CoherenceDecision, CUSUM drift
 v
L4  Memory         [EXISTING - neural-trader-replay via WASM]
 |                    ReplaySegment, ReservoirStore, WitnessReceipt
 v
L3  GNN+Attention  [NEW - TypeScript orchestration + WASM compute]
 |                    Temporal GNN, 46 attention mechanisms,
 |                    prediction heads, control heads
 v
L2  Graph          [NEW - TypeScript + ruvector-graph WASM]
 |                    Dynamic heterogeneous market graph,
 |                    10 node kinds, 12 edge types
 v
L1  Ingest         [EXISTING - neural-trader-core via WASM]
                      MarketEvent, EventIngestor, GraphUpdater, Embedder
```

### Data Flow

1. Market data arrives via feed adapters (TypeScript)
2. L1 normalizes events into canonical MarketEvent envelopes (WASM)
3. L2 projects events into the dynamic heterogeneous graph (WASM via ruvector-graph)
4. L3 computes temporal GNN embeddings and prediction/control head outputs (WASM via ruvector-gnn + ruvector-attention)
5. L4 selects and stores replay segments based on uncertainty and impact (WASM)
6. L5 evaluates coherence gate: mincut, drift, CUSUM (WASM)
7. L6 applies policy kernel, risk budgets, and emits action decisions (TypeScript + WASM)
8. Serving layer exposes gRPC/HTTP endpoints for research and paper trading (TypeScript)

### Bounded Contexts

The TypeScript layer is organized into five DDD bounded contexts:

1. **Ingestion** — Feed adapters, normalization, event publishing
2. **Graph** — Graph projection, neighborhood extraction, structural queries
3. **Intelligence** — GNN orchestration, embedding management, prediction serving
4. **Policy** — Policy kernel, risk management, order intent, broker adapters
5. **Serving** — API gateway, WebSocket streaming, health monitoring

Each bounded context owns its domain events, aggregates, and repository interfaces. Cross-context communication uses domain events on an internal event bus.

## Project Structure

```
neural-trader/
  RuVector/                          # Git submodule — upstream RuVector repo
  src/
    ingestion/                       # Bounded Context: Ingestion
      domain/
        events/                      # MarketDataReceived, NormalizationComplete
        models/                      # FeedConfig, VenueConnection
        ports/                       # FeedAdapter interface, EventPublisher
      infrastructure/
        adapters/                    # WebSocket feed, REST feed, file replay
        wasm/                        # Bindings to neural-trader-core WASM
      application/
        services/                    # IngestionOrchestrator, NormalizationService

    graph/                           # Bounded Context: Graph
      domain/
        events/                      # GraphUpdated, NeighborhoodExtracted
        models/                      # GraphState, Neighborhood, Subgraph
        ports/                       # GraphStore, GraphQuery interfaces
      infrastructure/
        wasm/                        # Bindings to ruvector-graph WASM
        persistence/                 # Postgres graph state snapshots
      application/
        services/                    # GraphProjectionService, SubgraphExtractor

    intelligence/                    # Bounded Context: Intelligence
      domain/
        events/                      # EmbeddingComputed, PredictionGenerated
        models/                      # Embedding, Prediction, ControlSignal
        ports/                       # EmbeddingStore, ModelRegistry
      infrastructure/
        wasm/                        # Bindings to ruvector-gnn, ruvector-attention
        persistence/                 # Postgres embedding tables (nt_embeddings)
      application/
        services/                    # GnnOrchestrator, AttentionPipeline

    policy/                          # Bounded Context: Policy
      domain/
        events/                      # ActionDecided, OrderIntentCreated
        models/                      # PolicyInput, ActionDecision, RiskBudget
        ports/                       # BrokerAdapter, WitnessLogger
      infrastructure/
        wasm/                        # Coherence + replay WASM bindings
        adapters/                    # Paper trading adapter, broker stubs
        persistence/                 # nt_policy_receipts table
      application/
        services/                    # PolicyKernel, RiskManager, OrderExecutor

    serving/                         # Bounded Context: Serving
      domain/
        models/                      # ApiResponse, StreamMessage
      infrastructure/
        http/                        # Express/Fastify routes
        grpc/                        # gRPC service definitions
        websocket/                   # Real-time streaming
      application/
        services/                    # HealthService, MetricsCollector

    shared/                          # Cross-cutting concerns
      kernel/                        # Base types, Result, DomainEvent
      wasm-loader/                   # WASM module initialization
      event-bus/                     # Internal domain event bus
      config/                        # Environment and runtime config
      observability/                 # Logging, tracing, metrics

  wasm/                              # New Rust WASM modules authored here
    graph-kernel/                    # L2 graph projection hot paths
    gnn-kernel/                      # L3 GNN forward pass
    policy-kernel/                   # L6 policy evaluation hot path

  tests/                             # Test files
    unit/                            # Unit tests by bounded context
    integration/                     # Cross-context integration tests
    e2e/                             # End-to-end pipeline tests

  config/                            # Configuration files
    default.yaml                     # Default config (mirrors ADR-085 example)
    development.yaml
    production.yaml

  scripts/                           # Utility scripts
    build-wasm.sh                    # Compile local WASM kernels
    replay-data.sh                   # Replay historical data for testing

  docs/                              # Documentation
    adr/                             # Architecture Decision Records
```

## Technology Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Runtime | Node.js 20 LTS | Stable async runtime, WASM support, ecosystem |
| Language | TypeScript 5.x (strict) | Type safety, DDD expressiveness, refactoring |
| WASM Bridge | `@ruvector/neural-trader-wasm` | Upstream WASM bindings for L1/L4/L5 |
| WASM Toolchain | `wasm-pack` + `wasm-bindgen` | Build local Rust WASM kernels for L2/L3/L6 |
| Available Crates | ruvector-graph, ruvector-gnn, ruvector-attention, ruvector-mincut, ruvector-postgres, ruvector-graph-transformer, ruvector-coherence, ruvector-verified, ruvector-mincut-gated-transformer, ruvector-hyperbolic-hnsw, ruvector-temporal-tensor | Upstream compute modules |
| Database | PostgreSQL 16 | Source of record per ADR-085, pgvector for embeddings |
| Cache | Redis | Hot embedding cache, session state |
| Event Bus | Internal TypeScript bus (initial), RabbitMQ (later) | Domain event routing between bounded contexts |
| API | gRPC + REST | gRPC for inter-service, REST for external clients |
| Streaming | WebSocket | Real-time market data and prediction streaming |
| Testing | Vitest | Fast TypeScript test runner |
| Build | tsup + wasm-pack | TypeScript bundling + WASM compilation |
| Observability | OpenTelemetry + Prometheus | Distributed tracing, metrics |

## Integration Strategy

### Consuming RuVector via Submodule

The `./RuVector/` directory is a git submodule pointing at the upstream RuVector repository. We pin to a specific commit hash for reproducible builds.

```bash
# Initial setup
git submodule add <ruvector-repo-url> RuVector
git submodule update --init --recursive

# Pin to specific version
cd RuVector && git checkout <commit-hash> && cd ..
git add RuVector
```

### WASM Module Loading

All WASM modules are loaded through a centralized `wasm-loader` in `src/shared/`. This provides:

1. **Lazy initialization** — WASM modules load on first use, not at startup
2. **Error containment** — WASM panics are caught and converted to TypeScript errors
3. **Memory management** — Explicit allocation and deallocation of WASM linear memory
4. **Version checking** — Runtime verification that WASM module versions match expected API

```typescript
// src/shared/wasm-loader/loader.ts
interface WasmModule<T> {
  readonly instance: T;
  readonly memoryUsageBytes: number;
  dispose(): void;
}

interface WasmLoader {
  loadIngestCore(): Promise<WasmModule<IngestCoreApi>>;
  loadCoherence(): Promise<WasmModule<CoherenceApi>>;
  loadReplay(): Promise<WasmModule<ReplayApi>>;
  loadGraphKernel(): Promise<WasmModule<GraphKernelApi>>;
  loadGnnKernel(): Promise<WasmModule<GnnKernelApi>>;
  loadPolicyKernel(): Promise<WasmModule<PolicyKernelApi>>;
}
```

### Existing Crate Consumption

| Existing Crate | WASM Package | Used By |
|---------------|-------------|---------|
| neural-trader-core | `@ruvector/neural-trader-wasm` | `src/ingestion/infrastructure/wasm/` |
| neural-trader-replay | `@ruvector/neural-trader-wasm` | `src/policy/infrastructure/wasm/` |
| neural-trader-coherence | `@ruvector/neural-trader-wasm` | `src/policy/infrastructure/wasm/` |

### New WASM Kernels

| New Kernel | Upstream Crate Dependency | Purpose |
|-----------|--------------------------|---------|
| `wasm/graph-kernel/` | ruvector-graph | L2 graph projection, neighborhood extraction |
| `wasm/gnn-kernel/` | ruvector-gnn, ruvector-attention | L3 temporal GNN forward pass, attention heads |
| `wasm/policy-kernel/` | ruvector-mincut, ruvector-verified | L6 fast policy evaluation, proof minting |

New kernels are compiled with `wasm-pack` targeting `nodejs` and loaded through the same `wasm-loader` infrastructure. They depend on upstream RuVector crates via Cargo workspace path references into the submodule:

```toml
# wasm/graph-kernel/Cargo.toml
[dependencies]
ruvector-graph = { path = "../../RuVector/crates/ruvector-graph" }
wasm-bindgen = "0.2"
```

### TypeScript-to-WASM Boundary Rules

1. TypeScript owns all I/O: network, database, file system, API serving
2. WASM owns all compute: graph updates, GNN forward passes, mincut, embedding generation
3. Data crosses the boundary as typed ArrayBuffers or JSON-serialized structs
4. No WASM module holds persistent state across calls — TypeScript manages all state
5. WASM panics are caught at the boundary and converted to domain errors

## Consequences

### Positive

1. **Reuses proven Rust compute** — L1, L4, L5 are battle-tested upstream; we get correctness for free
2. **TypeScript for domain complexity** — DDD patterns, event sourcing, and bounded contexts are natural in TypeScript
3. **Clear performance boundary** — WASM handles the inner loop; TypeScript handles orchestration and I/O
4. **Submodule isolation** — Upstream changes are opt-in via explicit commit pin updates
5. **Unified six-layer stack** — All layers from ADR-085 are present and integrated
6. **Auditable by design** — Proof-gated mutation and witness receipts flow through from the Rust layer
7. **Incremental buildout** — Each bounded context and WASM kernel can be developed and tested independently
8. **Local-first development** — No cloud dependencies for research and paper trading workflows

### Negative

1. **WASM boundary overhead** — Serialization cost at every TypeScript-to-WASM call; requires careful batching
2. **Dual-language maintenance** — Developers must be comfortable in both TypeScript and Rust
3. **Submodule complexity** — Git submodules add friction to cloning, branching, and CI
4. **WASM debugging** — Stack traces across the WASM boundary are harder to interpret than pure TypeScript
5. **Upstream dependency risk** — Breaking changes in RuVector crate APIs require adaptation in our WASM kernels
6. **Memory management discipline** — WASM linear memory must be explicitly managed to avoid leaks
7. **Build toolchain complexity** — Requires both Node.js and Rust toolchains, plus wasm-pack

### Mitigations

- WASM boundary cost is mitigated by batching operations and minimizing cross-boundary calls per tick
- Submodule friction is mitigated by pinning to known-good commits and automating updates via CI
- Debugging is mitigated by comprehensive logging at the TypeScript boundary layer
- Memory leaks are mitigated by the `WasmModule.dispose()` pattern and integration tests that check memory growth

---

## Decision Summary

Neural Trader will be a TypeScript-first project that consumes the RuVector neural-trader crates (L1, L4, L5) via WASM and builds three new layers (L2 Graph, L3 GNN+Attention, L6 Policy) as TypeScript orchestration backed by new Rust/WASM compute kernels.

The core principle is:

> **TypeScript owns the domain. Rust owns the math. The WASM boundary is explicit, typed, and narrow.**

This gives us a system that is expressive enough for complex trading domain logic, fast enough for sub-second research serving, and auditable through the proof-gated mutation chain inherited from RuVector.

### Implementation Priority

1. **Shared infrastructure** — WASM loader, event bus, config, observability
2. **Ingestion bounded context** — Feed adapters, L1 WASM integration, event publishing
3. **Graph bounded context** — L2 graph kernel, projection service, Postgres persistence
4. **Intelligence bounded context** — L3 GNN kernel, attention pipeline, embedding management
5. **Policy bounded context** — L6 policy kernel, risk management, coherence integration with L5
6. **Serving bounded context** — API gateway, WebSocket streaming, health endpoints
