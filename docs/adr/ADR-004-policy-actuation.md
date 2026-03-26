# ADR-004: Policy and Actuation Layer (Layer 6)

## Status

Proposed

## Date

2026-03-26

## Deciders

ruv

## Related

- RuVector ADR-085: Neural Trader full specification (Layer 6 source)
- ADR-047: Proof-gated mutation protocol
- Crate `neural-trader-coherence`: CoherenceDecision, VerifiedToken, WitnessReceipt
- Crate `neural-trader-replay`: WitnessLogger, InMemoryReceiptLog
- Crate `ruvector-verified`: ProofEnvironment, formal attestation substrate

## Context

Layers 1 through 5 of the neural-trader stack produce model outputs, coherence
decisions, and memory fragments. None of those layers may directly place orders,
modify positions, or mutate live strategy state. Layer 6 is the sole bridge
between intelligence and execution. It enforces policy rules, manages risk
budgets, mints proof tokens, and routes action intents to broker adapters.

This ADR specifies Layer 6 in implementation detail.

## Decision

### 1. PolicyKernel Trait

The policy kernel receives a `PolicyInput` and returns an `ActionDecision`.
Every call is stateless with respect to the kernel itself; all mutable state
lives in the risk budget and position tracker passed by reference.

```rust
pub struct PolicyInput {
    pub coherence: CoherenceDecision,
    pub model_output: ModelOutput,
    pub position: PositionSnapshot,
    pub risk_budget: RiskBudgetSnapshot,
    pub venue_state: VenueState,
    pub ts_ns: u64,
}

pub trait PolicyKernel {
    fn decide(&self, input: &PolicyInput) -> anyhow::Result<ActionDecision>;
}
```

The default `RulePolicyKernel` evaluates the five ADR-085 rules in order:

1. **Coherence gate.** If `coherence.allow_act == false`, return `Hold` with
   reason `coherence_blocked`.
2. **Regime uncertainty.** If `coherence.drift_score` exceeds the regime
   uncertainty threshold and the proposed action would increase notional
   exposure, return `Hold` with reason `regime_uncertainty`.
3. **Adversarial drift guard.** If `coherence.cusum_score` exceeds the
   adversarial drift threshold, suppress memory writes unless the segment is
   explicitly quarantined.
4. **Slippage-drift interaction.** If realized slippage exceeds the configured
   bound and `coherence.drift_score` is rising, block online learning.
5. **Rate throttle.** If the rolling order or cancel rate within the current
   window approaches the venue threshold (configurable fraction, default 0.8),
   return `Throttle` with a back-off duration.

Rules are evaluated sequentially. The first blocking rule wins. If all rules
pass, the kernel maps `ModelOutput` to a concrete `ActionDecision`.

### 2. ActionDecision Type Hierarchy

```rust
pub enum ActionDecision {
    Place(OrderIntent),
    Modify(ModifyIntent),
    Cancel(CancelIntent),
    Hold(HoldReason),
    Throttle { resume_after_ns: u64, reason: String },
    EmergencyFlatten { reason: String },
}

pub struct OrderIntent {
    pub symbol_id: u32,
    pub venue_id: u16,
    pub side: Side,
    pub price_fp: i64,
    pub qty_fp: i64,
    pub order_type: OrderType,
    pub time_in_force: TimeInForce,
}

pub enum OrderType { Limit, MarketableLimit, ImmediateOrCancel }
pub enum TimeInForce { Day, GoodTilCancel, FillOrKill }

pub struct ModifyIntent {
    pub order_id_hash: [u8; 16],
    pub new_price_fp: Option<i64>,
    pub new_qty_fp: Option<i64>,
}

pub struct CancelIntent {
    pub order_id_hash: [u8; 16],
    pub reason: String,
}

pub struct HoldReason {
    pub rule_name: String,
    pub detail: String,
}
```

`EmergencyFlatten` cancels all open orders and liquidates the position for the
affected symbol or, if triggered by the human kill switch, across all symbols.

### 3. Risk Budget Management

Risk budgets are checked before every `Place` or `Modify` decision. The
`RiskBudget` struct maintains rolling counters reset on a configurable window.

```rust
pub struct RiskBudgetConfig {
    pub max_notional_usd: f64,          // portfolio-wide cap
    pub max_symbol_notional_usd: f64,   // per-symbol cap
    pub max_sector_correlation: f64,    // sector-level exposure cap
    pub max_order_rate_per_sec: u32,    // venue order rate limit
    pub max_cancel_rate_per_sec: u32,   // venue cancel rate limit
    pub max_slippage_bp: f64,           // rolling slippage budget
    pub rate_throttle_fraction: f64,    // fraction of venue limit that triggers throttle (default 0.8)
}
```

**Budget enforcement sequence:**

1. Compute proposed notional delta from the `OrderIntent`.
2. Check portfolio-level notional: `current_notional + delta <= max_notional_usd`.
3. Check per-symbol notional: same check scoped to `symbol_id`.
4. Check sector correlation cap if sector metadata is available.
5. Check rolling order rate: orders in the last 1s window < max_order_rate.
6. Check rolling cancel rate: cancels in the last 1s window < max_cancel_rate.
7. Check slippage budget: cumulative realized slippage in the current session
   must remain below `max_slippage_bp`.

If any check fails, the `PolicyKernel` downgrades the decision to `Hold` or
`Throttle` and logs the specific budget violation.

### 4. Proof-Gated Mutation Flow

No state mutation occurs without a `VerifiedToken`. The flow follows ADR-085
section 7.2:

```
1. Compute features and local graph
2. Compute CoherenceDecision via CoherenceGate::evaluate
3. Evaluate PolicyKernel::decide
4. If decision is actionable (Place/Modify/Cancel/EmergencyFlatten):
   a. Hash (coherence_decision, policy_input, action_decision) -> policy_hash
   b. Mint VerifiedToken {
        token_id: random [u8; 16],
        ts_ns: current timestamp,
        coherence_hash: coherence.partition_hash,
        policy_hash,
        action_intent: decision variant name + symbol_id
      }
   c. Apply mutation (send to broker adapter or update position state)
   d. Append WitnessReceipt {
        ts_ns, model_id, input_segment_hash,
        coherence_witness_hash: coherence.partition_hash,
        policy_hash,
        action_intent,
        verified_token_id: token.token_id,
        resulting_state_hash: hash of post-mutation position state
      }
5. If decision is Hold or Throttle:
   - No token minted. Log decision with reasons for audit.
```

The `VerifiedToken` and `WitnessReceipt` types are defined in
`neural-trader-coherence`. The `WitnessLogger` trait from the same crate
handles receipt persistence. For research mode, `InMemoryReceiptLog` from
`neural-trader-replay` is sufficient. Production deployments write receipts to
the `nt_policy_receipts` Postgres table.

### 5. Broker Adapter Interface

```rust
pub enum FillReport {
    Filled { fill_price_fp: i64, fill_qty_fp: i64, ts_ns: u64 },
    PartialFill { fill_price_fp: i64, fill_qty_fp: i64, remaining_qty_fp: i64, ts_ns: u64 },
    Rejected { reason: String, ts_ns: u64 },
    Cancelled { ts_ns: u64 },
}

pub trait BrokerAdapter {
    fn submit_order(&mut self, intent: &OrderIntent, token: &VerifiedToken) -> anyhow::Result<()>;
    fn modify_order(&mut self, intent: &ModifyIntent, token: &VerifiedToken) -> anyhow::Result<()>;
    fn cancel_order(&mut self, intent: &CancelIntent, token: &VerifiedToken) -> anyhow::Result<()>;
    fn flatten_all(&mut self, reason: &str, token: &VerifiedToken) -> anyhow::Result<()>;
    fn poll_fills(&mut self) -> anyhow::Result<Vec<FillReport>>;
}
```

Two implementations are required at launch:

- **PaperBroker**: Simulates fills against a local order book snapshot.
  Configurable latency, partial fill probability, and slippage model. Writes
  all simulated fills to the witness log. Used in research and paper trading
  serving modes.

- **LiveBroker**: Wraps a venue-specific FIX or REST client. Every
  `submit_order` call requires a valid `VerifiedToken`. The adapter refuses to
  send any message if the token is missing or if its `ts_ns` is older than a
  configurable staleness window (default 500ms). This prevents replay of stale
  tokens.

Both adapters implement `BrokerAdapter` so the policy kernel and actuation loop
are adapter-agnostic.

### 6. Position Tracking and Inventory Management

```rust
pub struct PositionSnapshot {
    pub symbol_id: u32,
    pub net_qty_fp: i64,
    pub avg_entry_price_fp: i64,
    pub realized_pnl_fp: i64,
    pub unrealized_pnl_fp: i64,
    pub open_order_count: u32,
    pub last_fill_ts_ns: u64,
}
```

The `PositionTracker` maintains a `HashMap<u32, PositionSnapshot>` keyed by
`symbol_id`. It updates on every `FillReport` from the broker adapter.
Unrealized PnL is marked to the last known mid-price from the market graph.

Position state is included in every `WitnessReceipt` via
`resulting_state_hash`, which is the hash of the full position map after the
mutation. This ensures the witness chain captures inventory changes.

### 7. Human Override and Kill Switch

The kill switch is a dedicated control path outside the normal policy loop.

```rust
pub trait KillSwitch {
    fn is_active(&self) -> bool;
    fn activate(&mut self, reason: String);
    fn deactivate(&mut self);
}
```

**Activation triggers:**

- Manual activation via operator command (REST endpoint, CLI flag, or signal).
- Automatic activation if portfolio drawdown exceeds a configurable threshold.
- Automatic activation if venue health checks fail for N consecutive polls.
- Automatic activation on market halt signals (`EventType::VenueStatus` with
  halt flag).

**Kill switch behavior:**

1. Set `is_active() = true` globally.
2. The policy kernel short-circuits to `EmergencyFlatten` for all symbols.
3. The broker adapter sends cancel-all followed by market-order liquidation.
4. All further `PolicyKernel::decide` calls return `Hold` with reason
   `kill_switch_active` until the operator explicitly deactivates.
5. A `WitnessReceipt` is appended for the flatten event with
   `action_intent = "emergency_flatten_kill_switch"`.

Deactivation requires explicit human action. The system never auto-recovers
from a kill switch state.

### 8. Serving Modes

Three serving modes govern what the actuation layer is permitted to do:

| Mode | Place Orders | Mutate Position | Write Memory | Proof Required |
|------|-------------|-----------------|-------------- |----------------|
| Research | No | No (simulated) | Yes | No |
| Paper Trading | Yes (PaperBroker) | Yes (simulated) | Yes | Yes |
| Live Bounded | Yes (LiveBroker) | Yes (real) | Yes | Yes |

**Research mode.** Model outputs are evaluated and logged but never routed to
any broker adapter. The policy kernel still runs to validate that rules would
have permitted the action. Useful for backtesting policy configurations.

**Paper trading mode.** The full actuation loop runs with `PaperBroker`.
Proof-gated mutation is enforced. All fills are simulated. This mode validates
end-to-end behavior including rate limits, slippage budgets, and position
tracking under realistic conditions.

**Live bounded mode.** The full actuation loop runs with `LiveBroker`. The risk
budget config for live mode uses conservative defaults from ADR-085:
`max_notional_usd = 250_000`, `max_symbol_notional_usd = 50_000`,
`max_order_rate_per_sec = 10`, `max_cancel_rate_per_sec = 15`,
`max_slippage_bp = 2.0`. The kill switch is mandatory. Promotion from paper
to live requires explicit operator approval and a signed configuration change
recorded in the witness log.

## Crate Layout

This ADR maps to two crates defined in ADR-085:

- `neural-trader-policy/` -- PolicyKernel, RulePolicyKernel, RiskBudget,
  ActionDecision, PositionTracker, KillSwitch, serving mode configuration.
- `neural-trader-execution/` -- BrokerAdapter trait, PaperBroker, LiveBroker,
  FillReport, OrderIntent routing.

Both crates depend on `neural-trader-coherence` for `CoherenceDecision`,
`VerifiedToken`, and `WitnessReceipt`. The execution crate depends on the
policy crate for `ActionDecision` and `OrderIntent`.

## Consequences

**Positive:**

- Every order intent is traceable through coherence, policy, proof token, and
  witness receipt. Full auditability from model output to fill.
- Risk budgets are enforced at the policy layer, not in broker-specific code.
  Changing brokers does not change risk behavior.
- The kill switch provides a hard safety boundary independent of model or
  coherence state.
- Serving modes allow incremental promotion from research through paper trading
  to live execution with the same policy code path.

**Negative:**

- The proof-gated flow adds latency to every actuation cycle. For
  latency-critical live trading this cost must be benchmarked and bounded.
- The `RulePolicyKernel` encodes fixed rules. Adaptive policy learning is
  explicitly deferred to avoid uncontrolled mutation of safety logic.

**Risks:**

- Miscalibrated risk budget thresholds could either block valid trades or
  permit excessive exposure. Calibration must use paper trading telemetry.
- The LiveBroker token staleness window (500ms default) must be tuned per
  venue to avoid rejecting valid tokens under normal network jitter.
