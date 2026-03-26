# Phase 2: Operational Readiness Plan

**Status**: Active
**Created**: 2026-03-26
**Goal**: Data collection running, training pipeline ready, operational infrastructure for 24/7 live trading

---

## Parallel Workstreams

### Stream A: Data Collection Infrastructure
**Priority**: Critical (blocks training by calendar time)

**A1. Docker Compose dev environment**
- `docker-compose.dev.yml` with Postgres 16 + pgvector, Redis
- Volume mounts for data persistence
- Health checks on services
- `.env.example` with all required env vars

**A2. Data recorder script**
- `scripts/record-data.ts` — connects to Binance live WS, normalizes, stores to Postgres
- Records BTC/USDT and ETH/USDT L2 depth + trades
- Runs as long-lived PM2 process
- Logs stats every 60s (events/sec, storage size)
- Handles reconnection gracefully
- Target: start collecting within hours, run for 5-7 days minimum

**A3. Data validation script**
- `scripts/validate-data.ts` — checks for gaps, duplicate events, timestamp monotonicity
- Reports coverage: hours recorded per symbol, event counts by type
- Run daily to ensure data quality

---

### Stream B: Training Pipeline
**Priority**: High (needed before backtesting)

**B1. Training data loader**
- `src/training/data-loader.ts` — loads events from Postgres by date range
- Constructs (graph_snapshot, label) pairs from historical events
- Labels: next-window mid-price move, whether fills occurred, realized slippage
- Windowed sampling: 60s windows with 10s stride
- Train/validation split by time (no lookahead)

**B2. Trainer loop**
- `src/training/trainer.ts` — iterates over windows, runs GNN forward pass, computes loss, updates weights
- Loss: L_pred + lambda_1*L_fill + lambda_2*L_risk (simplified from ADR-003)
- Optimizer: Adam with configurable LR (default 1e-4)
- Gradient clipping at norm 1.0
- Per-head loss tracking and logging

**B3. Checkpoint management**
- `src/training/checkpoint.ts` — save/load model weights (all MLP heads + GNN layers) to JSON files
- Versioned checkpoints in `data/checkpoints/`
- Load checkpoint on startup for both training resume and inference

**B4. Training CLI**
- `scripts/train.ts` — CLI: `npx tsx scripts/train.ts --from 2026-03-27 --to 2026-04-02 --epochs 50`
- Logs per-epoch loss, saves best checkpoint
- Outputs training report with per-head metrics

**B5. Training tests**
- Verify loss decreases over 10 synthetic steps
- Verify checkpoint save/load round-trip produces same predictions
- Verify train/val split has no time overlap

---

### Stream C: Operational Infrastructure
**Priority**: Medium (needed before live, not before backtest)

**C1. Startup reconciliation**
- `src/execution/reconciler.ts` — on startup, query exchange for open orders and balances
- Compare against last known Postgres state
- Cancel stale orders, update position tracker
- Log discrepancies as warnings

**C2. Graceful shutdown**
- On SIGTERM/SIGINT: cancel all open orders via broker adapter, flush pending receipts to Postgres, persist graph state snapshot, exit cleanly
- Timeout: force-exit after 30s if graceful shutdown stalls
- Wire into `src/index.ts` bootstrap

**C3. PM2 ecosystem config**
- `ecosystem.config.cjs` — PM2 process definition
- Auto-restart on crash, max 100 restarts
- Memory limit restart (1GB default)
- Log rotation
- Separate processes for: trader, data-recorder

**C4. Health monitoring + alerting**
- `src/monitoring/alerter.ts` — webhook dispatcher (Slack/Discord)
- Alert on: circuit breaker, kill switch, feed disconnect >60s, memory threshold, Postgres disconnect
- Configurable webhook URL via env var
- Cooldown: don't spam (max 1 alert per type per 5 minutes)

**C5. Operational tests**
- Graceful shutdown cancels orders and flushes state
- Reconciler detects position mismatch
- Alerter sends webhook on circuit breaker

---

## Dependencies

```
A1 (Docker) ──┐
              ├──> A2 (Recorder) ──> A3 (Validator) ──> B1 (DataLoader)
              │                                           │
              │                                           v
              │                                    B2 (Trainer) ──> B4 (CLI)
              │                                           │
              │                                           v
              │                                    B3 (Checkpoint)
              │
C1 (Reconciler) ─┐
C2 (Shutdown)  ───┼──> C3 (PM2) ──> C4 (Alerter)
C5 (Op Tests)  ───┘
```

Streams A, B, and C are largely independent — agents can work in parallel.

---

## Acceptance Criteria

- [ ] Docker Compose starts Postgres + Redis, migrations run, health checks pass
- [ ] Data recorder collects >100K events/hour from Binance
- [ ] Training pipeline trains all heads, loss decreases monotonically on synthetic data
- [ ] Checkpoint save/load produces identical predictions
- [ ] Graceful shutdown cancels orders and exits within 30s
- [ ] PM2 auto-restarts after simulated crash
- [ ] Alerter sends webhook on circuit breaker trigger
