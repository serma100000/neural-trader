# ADR-003: GNN + Temporal Attention Learning Layer (L3)

**Status:** Accepted
**Date:** 2026-03-26
**Deciders:** Architecture team
**Supersedes:** N/A
**Related:** RuVector ADR-085 (Learning Layer Spec), ADR-001 (System Overview), ADR-002 (Data Ingestion)

## Context

Layer 3 of the neural-trader stack is the learning layer. It consumes the normalized
market graph produced by upstream layers and outputs vector embeddings, prediction
signals, and control decisions. RuVector ADR-085 specifies the model family as typed
message-passing GNN with temporal attention, contrastive regime loss, and coherence
regularization. This ADR maps that specification onto the available RuVector crate
ecosystem and defines the concrete architecture for training, inference, and deployment.

## Decision

### 1. Unified Learning Pipeline Composition

The pipeline composes three RuVector crates into a single forward pass:

```
Input Graph (L2) --> ruvector-gnn (message passing) --> ruvector-attention (temporal) --> Heads
                                                    \-> ruvector-mincut-gated-transformer (instability path)
```

**ruvector-gnn** performs K rounds of typed message passing over the dynamic market
graph. Node types include instrument, venue, order-level, and strategy. Edge types
encode book adjacency, cross-symbol correlation, venue routing, and temporal
succession. Each message-passing round applies edge-type-specific linear transforms
before aggregation.

**ruvector-attention** applies temporal attention over a sliding window of the most
recent N event snapshots (default N=64). We use the `causal_flash_attention` variant
from the 46-mechanism library for O(N) memory during training. During inference we
switch to `incremental_kv_attention` to avoid recomputation on each new event.

**ruvector-mincut-gated-transformer** activates only when the coherence gate (L5)
signals regime instability. It provides early-exit sparse compute: if the gating
score exceeds a threshold (default 0.7), the transformer short-circuits through a
reduced-rank path, cutting latency by approximately 40% at the cost of minor
accuracy loss that is acceptable during volatile transitions.

Pipeline wiring is static at model-load time. No dynamic dispatch occurs on the
hot path. The three crates share a common tensor memory arena allocated once per
inference session.

### 2. Embedding Generation Strategy

Six embedding families, each with a dedicated encoder head on the GNN output:

| Family | Dimension | Source Nodes | Pooling | Update Freq |
|---|---|---|---|---|
| Book state | 128 | Instrument + price-level nodes | Attention-weighted | Every tick |
| Queue state | 64 | Order-level nodes per price level | Sum pool | Every tick |
| Event stream | 128 | Temporal event sequence | Causal attention | Every event |
| Cross-symbol regime | 64 | All instrument root nodes | Mean pool | 100ms window |
| Strategy context | 64 | Strategy + position nodes | Concat + project | On position change |
| Risk context | 64 | Risk limit + exposure nodes | Max pool | 100ms window |

Total embedding dimension when concatenated: 512.

Dimension choices follow these constraints:
- Book and event stream carry the highest information density; 128d each.
- Queue, regime, strategy, and risk are lower-entropy signals; 64d each.
- 512d total stays within the budget for a single WASM SIMD dot-product pass.

Regime embeddings use hyperbolic space via **ruvector-hyperbolic-hnsw**. The Poincare
ball model naturally represents hierarchical regime structure (e.g., trending >
momentum > mean-reverting) with distances that grow exponentially near the boundary,
giving better separation for tail regimes.

### 3. Prediction and Control Head Architecture

All heads share the 512d concatenated embedding as input.

**Prediction heads** (6 outputs):

| Head | Output | Activation | Loss |
|---|---|---|---|
| Next-window mid-price move | R^1 (signed bp) | Linear | Huber |
| Fill probability | [0,1] | Sigmoid | BCE |
| Cancel probability | [0,1] | Sigmoid | BCE |
| Slippage risk | R^1 (bp) | Softplus | Quantile (tau=0.95) |
| Local vol jump risk | [0,1] | Sigmoid | BCE |
| Regime transition prob | [0,1] per regime | Softmax | Cross-entropy |

Each prediction head is a 2-layer MLP: 512 -> 256 -> output, with LayerNorm and
GELU between layers. Dropout 0.1 during training.

**Control heads** (5 outputs):

| Head | Output | Activation | Loss |
|---|---|---|---|
| Place / don't-place | Binary | Sigmoid | BCE + reward shaping |
| Modify / hold | Binary | Sigmoid | BCE + reward shaping |
| Size scaling | [0.0, 1.0] | Sigmoid | MSE against oracle |
| Venue selection | Categorical | Softmax | Cross-entropy |
| Write admission score | [0,1] | Sigmoid | BCE |

Control heads use a 3-layer MLP: 512 -> 256 -> 128 -> output. The extra layer
provides capacity for the policy gradient signal which is noisier than supervised
prediction targets. Control heads receive a stop-gradient copy of the embedding
during the first phase of training to prevent policy gradients from destabilizing
the encoder.

### 4. Training Pipeline

#### 4a. Offline Historical Training

Training proceeds in three phases on historical data:

**Phase 1 -- Encoder pre-training (contrastive + prediction).**
Freeze control heads. Train the GNN encoder, attention layers, and prediction heads
using L_pred + lambda_3 * L_contrast + lambda_4 * L_coherence. Contrastive loss
uses InfoNCE over regime-labeled windows: embeddings from the same regime are pulled
together, different regimes are pushed apart. Duration: until validation prediction
loss plateaus (typically 50-100 epochs on 6 months of tick data).

**Phase 2 -- Control head warm-start.**
Freeze encoder. Train control heads against oracle labels derived from hindsight-
optimal decisions computed by the offline backtester. Duration: 20-30 epochs.

**Phase 3 -- End-to-end fine-tuning.**
Unfreeze all parameters. Train with the full composite loss:

```
L = L_pred + lambda_1 * L_fill + lambda_2 * L_risk
  + lambda_3 * L_contrast + lambda_4 * L_coherence + lambda_5 * L_budget
```

Default lambda values: lambda_1=1.0, lambda_2=2.0, lambda_3=0.5, lambda_4=0.3,
lambda_5=0.1. L_budget penalizes the control heads for exceeding a per-window
message-rate or capital-usage budget. Learning rate reduced to 1/10 of Phase 1.

Optimizer: AdamW, lr=1e-4 (Phase 1/2), 1e-5 (Phase 3), weight decay=0.01.
Batch size: 256 windows. Gradient clipping at norm 1.0.

#### 4b. Bounded Online Adaptation

In production, the model adapts within strict bounds:

- Only the final linear layer of each head is updated (fewer than 5% of parameters).
- Updates use a ring buffer of the most recent 10,000 inference samples.
- Adaptation runs every 60 seconds on a background thread.
- Parameter drift is bounded: if the L2 distance from the base checkpoint exceeds
  a threshold (default 0.05), adaptation halts and raises an alert.
- A shadow model runs in parallel; if the adapted model underperforms the shadow on
  a held-out validation slice, adaptation rolls back.

### 5. Coherence Regularization and L5 Integration

L_coherence has two components from ADR-085:

**Mincut loss.** Computed over the market graph using the normalized-cut objective.
The GNN soft-assigns each node to one of K clusters (K=8 default). The mincut loss
penalizes assignments that place strongly connected nodes in different clusters,
encouraging the encoder to learn topologically coherent representations. Implemented
via `ruvector-mincut-gated-transformer::mincut_loss()`.

**Boundary stability loss.** Penalizes large changes in cluster assignments between
consecutive time steps. Computed as the KL divergence between soft assignments at
t and t-1. This prevents the embedding space from reorganizing abruptly during
regime transitions.

Integration with the L5 coherence gate is bidirectional:

- **L5 -> L3:** When L5 detects coherence degradation (gate score > 0.7), it sends
  a signal that activates the early-exit path in ruvector-mincut-gated-transformer
  and increases lambda_4 by 2x for the next online adaptation cycle.
- **L3 -> L5:** L3 exports its per-tick cluster assignment entropy and boundary
  stability metrics to L5 as inputs to the coherence scoring function.

### 6. WASM Deployment for Low-Latency Inference

The inference path is compiled to WASM using the `-wasm` variants of the crates:

- **ruvector-gnn-wasm**: Message passing with SIMD-accelerated scatter/gather.
- **ruvector-attention-wasm**: Incremental KV-cache attention, no full recompute.

Deployment constraints:

| Metric | Target | Mechanism |
|---|---|---|
| Inference latency p99 | < 500us | Pre-allocated arena, no GC, SIMD |
| Memory footprint | < 50MB | Quantized weights (INT8), shared arena |
| Model load time | < 200ms | Memory-mapped weight file, lazy init |

The WASM module exports a single `infer(graph_snapshot) -> (embeddings, predictions,
controls)` function. The graph snapshot is a flat buffer in a schema shared with L2.
No serialization occurs on the hot path; the buffer is passed by reference through
shared WASM linear memory.

Quantization strategy: weights are stored as INT8 with per-channel scale factors.
Activations remain FP32. This halves the model size with less than 0.5% accuracy
degradation based on offline benchmarks.

The WASM module is stateless across calls except for the KV cache, which is managed
by the caller via an opaque handle. This allows multiple inference contexts (e.g.,
per-symbol) without module re-instantiation.

### 7. Model Versioning, Promotion, and Lineage

**Versioning scheme:** `v{major}.{minor}.{patch}-{training_run_id}`

- Major: architecture change (layer count, embedding dimension, head structure).
- Minor: full retrain on new data window.
- Patch: online adaptation checkpoint.

**Artifact storage:** Each model version produces:
- ONNX graph (for audit and portability).
- WASM binary (for deployment).
- Training config YAML (hyperparameters, data window, lambda values).
- Validation metrics JSON (per-head loss, calibration curves, regime accuracy).

**Promotion gates:**

| Gate | Criteria |
|---|---|
| Candidate | Training completes without NaN/Inf |
| Staging | Validation loss within 5% of best known; calibration error < 0.02 |
| Shadow | 24h shadow deployment; no drift alert; prediction accuracy >= baseline |
| Production | Manual approval after shadow period; automated rollback on degradation |

**Lineage tracking:** Every model records its parent version, training data hash,
code commit SHA, and the full lambda vector. This chain is stored in an append-only
ledger alongside the model artifacts. Lineage queries answer: "which data and code
produced the model currently serving symbol X?"

**Rollback:** Production always keeps the previous two model versions warm-loaded.
Rollback is a pointer swap with zero downtime. If the current and previous models
both degrade, the system falls back to a conservative rule-based baseline that does
not depend on L3.

## Consequences

**Positive:**
- Typed message passing captures heterogeneous market graph structure without
  flattening into a fixed-size feature vector.
- Temporal attention over event windows adapts to varying event rates across symbols.
- Phased training prevents control-head gradients from corrupting encoder quality.
- Bounded online adaptation allows the model to track non-stationarity without
  risking catastrophic drift.
- WASM deployment achieves sub-millisecond inference without JIT warmup.
- Hyperbolic regime embeddings provide natural hierarchy for regime clustering.

**Negative:**
- Six embedding families increase the surface area for integration bugs between L2
  and L3. Mitigated by schema validation at the boundary.
- INT8 quantization may underperform on symbols with extreme tick-size granularity.
  Mitigated by per-symbol quantization calibration.
- The coherence gate feedback loop between L3 and L5 creates a circular dependency
  that must be carefully initialized at system startup. Mitigated by running L3 in
  open-loop mode for the first 60 seconds after boot.

**Risks:**
- Online adaptation drift exceeding the L2-distance bound could cause silent
  degradation if the bound is set too loosely. Requires periodic review of the
  threshold against realized parameter trajectories.
- WASM SIMD support varies across runtimes. We target wasmtime 15+ and require
  the `simd128` proposal. Fallback scalar paths exist but exceed latency targets.
