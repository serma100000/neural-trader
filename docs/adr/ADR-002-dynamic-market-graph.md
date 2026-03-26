# ADR-002: Dynamic Market Graph (Layer 2)

## Status

Proposed

## Date

2026-03-26

## Deciders

mschiaramonte

## Related

- RuVector ADR-085: Neural Trader architecture (parent spec)
- RuVector ADR-086: Neural Trader WASM bindings
- `neural-trader-core` crate: `NodeKind`, `EdgeKind`, `PropertyKey`, `GraphUpdater` trait
- `ruvector-graph`: Host graph substrate (`GraphDB`, `Node`, `Edge`, DashMap storage)
- `ruvector-graph-wasm`: WASM bindings for browser-side graph operations

## Context

ADR-085 defines a six-layer architecture for Neural Trader. Layer 1 (Ingest) normalizes raw
market feeds into `MarketEvent` envelopes. Layer 2 must project those events into a typed
heterogeneous dynamic graph that downstream layers consume:

- **L3 (GNN/Attention)** needs neighborhood subgraphs with numeric feature tensors.
- **L5 (Coherence Gate)** needs graph connectivity metrics (mincut, bridge counts).
- **L6 (Policy)** needs strategy-state traversals for proof-gated mutation.

The `neural-trader-core` crate already defines the schema (10 node kinds, 12 edge kinds,
17 property keys) and the `GraphUpdater` trait. This ADR specifies how we implement that
trait, manage graph lifecycle, expose queries, and integrate with `ruvector-graph` via WASM.

## Decision

### 1. GraphUpdater Implementation

We implement `GraphUpdater` in a new Rust module `crates/neural-trader-graph/src/updater.rs`.
The struct holds a reference to `ruvector_graph::GraphDB` and maintains index maps for fast
node lookup by domain key.

```rust
pub struct MarketGraphUpdater {
    db: Arc<GraphDB>,
    // Domain-key to NodeId maps for O(1) lookup on the hot path
    symbol_index:      HashMap<u32, NodeId>,
    venue_index:       HashMap<u16, NodeId>,
    price_level_index: HashMap<(u32, u16, i64), NodeId>,  // (symbol, venue, price_fp)
    order_index:       HashMap<[u8; 16], NodeId>,          // order_id_hash
    participant_index: HashMap<[u8; 16], NodeId>,          // participant_id_hash
    time_bucket_index: HashMap<(u32, u64), NodeId>,        // (symbol, bucket_id)
    // Monotonic node-id counter (maps to ruvector-graph NodeId)
    next_id: AtomicU64,
}
```

`apply_event` dispatches on `event.event_type` and returns a `GraphDelta` describing all
mutations. The caller decides whether to persist the delta or discard it.

### 2. Event-to-Graph Mutation Mapping

Each `EventType` variant maps to a deterministic set of graph mutations.

| EventType | Nodes Created | Nodes Updated | Edges Created |
|-----------|---------------|---------------|---------------|
| `NewOrder` | Order, Event; PriceLevel and TimeBucket if absent | PriceLevel (depth, queue, imbalance) | AT_LEVEL, GENERATED, BELONGS_TO_SYMBOL, ON_VENUE, IN_WINDOW |
| `ModifyOrder` | Event; new Order version | Old Order (mark stale), PriceLevel (recompute depth) | MODIFIED_FROM (new -> old), GENERATED, AT_LEVEL (new level) |
| `CancelOrder` | Event | PriceLevel (depth, depletion rate), Order (mark canceled) | CANCELED_BY, GENERATED |
| `Trade` | Trade, Event | PriceLevel (depth), both matched Orders | MATCHED, GENERATED, BELONGS_TO_SYMBOL, ON_VENUE, IN_WINDOW |
| `BookSnapshot` | PriceLevels (bulk upsert) | All affected PriceLevels (full replace) | AT_LEVEL, NEXT_TICK (chain adjacent levels) |
| `SessionMarker` | TimeBucket, possibly Regime | StrategyState | IN_REGIME, IN_WINDOW, AFFECTS_STATE |
| `VenueStatus` | Event | Venue node properties | ON_VENUE |

**NEXT_TICK edges** link adjacent PriceLevel nodes on the same side, forming a doubly-linked
price ladder. These are rebuilt on BookSnapshot and incrementally maintained on NewOrder and
CancelOrder.

**Derived properties** are computed inline during `apply_event`:

- `LocalImbalance` = `(bid_depth - ask_depth) / (bid_depth + ask_depth)` at each level.
- `RefillRate` and `DepletionRate` use exponential moving averages over the last N events
  touching that level (N configurable, default 20).
- `CancelHazard` and `FillHazard` on Order nodes use survival-style estimators updated on
  each event that modifies or fills the order.
- `SpreadDistance` is maintained on every PriceLevel as `abs(price_fp - mid_fp)` in ticks.

### 3. Windowed Graph Management

The graph grows without bound if unmanaged. We enforce three mechanisms.

**Sliding time window.** A configurable retention window (default 60 seconds of exchange
time) determines which nodes remain active. Nodes older than the window are candidates for
compaction. The `GraphCompactor` runs on a timer or after every N events (default 10,000).

**Compaction strategy:**

1. Event nodes older than the window are removed. Their edges are removed.
2. Order nodes in terminal state (filled or canceled) older than the window are removed.
3. Trade nodes older than the window are removed after their properties have been aggregated
   into the parent TimeBucket node.
4. PriceLevel nodes with zero visible depth and no remaining Order children are removed.
5. Symbol, Venue, Regime, StrategyState, and TimeBucket nodes are never auto-removed.

**Bounded graph size.** A hard cap (default 500,000 nodes) triggers emergency compaction if
the sliding window is insufficient. Emergency compaction halves the retention window and
re-runs.

**Neighborhood extraction.** For GNN consumption, `extract_neighborhood` returns the k-hop
subgraph around a given node, materialized as adjacency lists and feature matrices:

```rust
pub struct Neighborhood {
    pub node_ids: Vec<u64>,
    pub node_kinds: Vec<NodeKind>,
    pub features: Vec<Vec<f64>>,       // len = node_ids.len(), inner len = feature_dim
    pub edge_index: Vec<(usize, usize)>, // COO format indices into node_ids
    pub edge_kinds: Vec<EdgeKind>,
    pub edge_features: Vec<Vec<f64>>,
}
```

This structure maps directly to PyG/DGL tensor formats when serialized through WASM.

### 4. Integration with ruvector-graph

`MarketGraphUpdater` wraps `ruvector_graph::GraphDB` and translates between the
neural-trader-core schema and ruvector-graph's label/property model:

- `NodeKind` maps to a ruvector-graph label string (e.g., `NodeKind::PriceLevel` ->
  label `"PriceLevel"`).
- `PropertyKey` maps to a string property key on the node (e.g., `PropertyKey::VisibleDepth`
  -> `"visible_depth"`).
- `EdgeKind` maps to the edge's `RelationType` (e.g., `EdgeKind::AtLevel` -> `"AT_LEVEL"`).
- All property values are stored as `PropertyValue::Float` for numeric properties and
  `PropertyValue::Integer` for counters.

Node creation uses `NodeBuilder` with labels and initial properties. Edge creation uses
`EdgeBuilder` with the relation type and optional weight/properties. Both go through
`GraphDB::add_node` and `GraphDB::add_edge`, which maintain the adjacency and label indexes.

For traversal, we use `GraphDB`'s adjacency index (`node_edges_out`, `node_edges_in`) for
neighborhood walks. The DashMap-based storage gives lock-free concurrent reads, which is
critical because the GNN layer may read neighborhoods while the ingest path writes.

### 5. TypeScript Orchestration Layer

The TypeScript layer in `src/graph/` drives the WASM graph engine and manages lifecycle.

```
src/graph/
  market-graph.ts       # MarketGraph class: owns the WASM GraphDB instance
  event-projector.ts    # Calls WASM apply_event, collects GraphDelta
  compactor.ts          # Triggers compaction on timer or event count
  neighborhood.ts       # Extracts typed neighborhoods for GNN
  index.ts              # Public API re-exports
```

**MarketGraph** is the primary entry point:

```typescript
interface MarketGraph {
  applyEvent(event: MarketEvent): GraphDelta;
  extractNeighborhood(nodeId: bigint, hops: number): Neighborhood;
  getStateWindow(symbolId: number, venueId: number, durationNs: bigint): StateWindow;
  compact(): CompactionStats;
  nodeCount(): number;
  edgeCount(): number;
}
```

The TypeScript layer does not duplicate graph logic. All mutations and traversals happen in
WASM. TypeScript is responsible for:

1. Feeding `MarketEvent` buffers from the ingest layer into `apply_event`.
2. Scheduling compaction (via `setInterval` or after N events).
3. Requesting neighborhoods when the GNN layer needs input.
4. Exposing graph statistics for the monitoring dashboard.
5. Serializing `Neighborhood` into typed arrays for transfer to the GNN worker.

Communication between TypeScript and WASM uses `SharedArrayBuffer` for the event stream and
structured clone for neighborhood results. This avoids serialization overhead on the hot path.

### 6. Performance Constraints

| Metric | Target | Rationale |
|--------|--------|-----------|
| `apply_event` latency | < 100 us p99 | Must keep up with 10K events/sec per symbol |
| Neighborhood extraction (2-hop) | < 5 ms | GNN inference runs at 200 Hz |
| Compaction cycle | < 50 ms | Must not block ingest for more than one event batch |
| Steady-state node count | < 200K per symbol | Memory budget of ~500 MB for 5-symbol graph |
| Steady-state edge count | < 1M per symbol | Edges are ~3-5x nodes due to NEXT_TICK chains |

**Allocation strategy.** `apply_event` must not allocate on the heap in the common case.
`GraphDelta` vectors are pre-allocated and cleared between calls. Domain-index lookups use
`HashMap` with pre-hashed keys. Property updates use `set_property` which mutates in place
through DashMap's mutable reference.

**Batch mode.** For replay and backtesting, `apply_events_batch(events: &[MarketEvent])`
processes a contiguous slice without returning intermediate deltas. This enables the
optimizer to elide intermediate property writes when a node is updated multiple times in
the same batch.

### 7. Graph Query Patterns for Downstream Layers

**L3 (GNN / Temporal Attention):**

- `neighborhood(node, k_hops)` -- returns typed subgraph with feature matrices.
- `price_ladder(symbol, venue, side)` -- returns the NEXT_TICK-linked chain of PriceLevel
  nodes with all properties, ordered by price.
- `recent_events(symbol, n)` -- returns the last N Event nodes with GENERATED edges
  resolved to their target Order/Trade nodes.

**L5 (Coherence Gate / MinCut):**

- `symbol_subgraph(symbol)` -- returns all nodes connected via BELONGS_TO_SYMBOL to a
  given Symbol node, used as input to the mincut solver.
- `bridge_edges(symbol)` -- returns edges whose removal would disconnect components,
  used as a fragility signal.
- `connectivity_score(symbol)` -- returns `edge_count / node_count` and algebraic
  connectivity estimate for the symbol subgraph.

**L6 (Policy / Strategy):**

- `strategy_state(symbol)` -- traverses AFFECTS_STATE edges to the StrategyState node
  and returns its current properties.
- `regime_path(symbol, window)` -- returns the sequence of Regime nodes linked via
  IN_REGIME from TimeBucket nodes in the given window.
- `order_lineage(order_id)` -- follows MODIFIED_FROM edges to reconstruct the full
  modification history of an order.

All query functions are exposed through WASM bindings and wrapped by the TypeScript
orchestration layer.

## Consequences

### Positive

1. The graph captures structural relationships (queue position, price adjacency, causal
   links) that flat feature vectors lose.
2. A single `GraphUpdater` trait implementation keeps all mutation logic in one place,
   making it testable and replayable.
3. Windowed compaction bounds memory without losing aggregated statistics.
4. WASM execution keeps the hot path in compiled Rust while TypeScript manages lifecycle.
5. The `Neighborhood` struct provides a zero-copy-friendly format for GNN tensor construction.

### Negative

1. The ruvector-graph label/property model requires string-based keys, adding indirection
   over a purpose-built typed store. We mitigate this by caching `NodeId` lookups in the
   domain-index maps.
2. Compaction introduces brief write pauses. We mitigate this by running compaction on a
   separate thread (or Web Worker in browser) and using DashMap's concurrent access.
3. The NEXT_TICK edge chain requires O(n) maintenance on book snapshots where n is the
   number of price levels. This is acceptable because snapshots are infrequent (typically
   once at session start).

### Risks

1. If `ruvector-graph-wasm` bindings do not expose sufficient `GraphDB` methods, we will
   need to extend them. The current bindings cover CRUD and basic traversal but may lack
   batch operations.
2. `SharedArrayBuffer` requires cross-origin isolation headers. Deployments that cannot
   set these headers will fall back to structured clone with ~2x overhead on event transfer.

## Implementation Plan

| Phase | Deliverable | Depends On |
|-------|-------------|------------|
| 2.1 | `neural-trader-graph` crate with `MarketGraphUpdater` and unit tests | neural-trader-core |
| 2.2 | Compaction module with time-window and size-cap strategies | 2.1 |
| 2.3 | Neighborhood extraction and query functions | 2.1 |
| 2.4 | WASM bindings for updater, compactor, and queries | 2.1, 2.2, 2.3, ruvector-graph-wasm |
| 2.5 | TypeScript orchestration layer (`src/graph/`) | 2.4 |
| 2.6 | Integration test: replay 1M events, verify bounded memory and latency | 2.5 |
