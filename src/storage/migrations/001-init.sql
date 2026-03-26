-- 001-init.sql: Core schema for neural-trader storage layer (ADR-005)

-- Enable pgvector extension for embedding storage
CREATE EXTENSION IF NOT EXISTS vector;

-- Event log: range-partitioned by ts_exchange_ns
CREATE TABLE nt_event_log (
    event_id       BYTEA NOT NULL,
    ts_exchange_ns BIGINT NOT NULL,
    ts_ingest_ns   BIGINT NOT NULL,
    venue_id       INT NOT NULL,
    symbol_id      INT NOT NULL,
    event_type     INT NOT NULL,
    side           INT,
    price_fp       BIGINT NOT NULL,
    qty_fp         BIGINT NOT NULL,
    order_id_hash  BYTEA,
    flags          INT NOT NULL DEFAULT 0,
    seq            BIGINT NOT NULL,
    witness_hash   BYTEA,
    PRIMARY KEY (ts_exchange_ns, event_id)
) PARTITION BY RANGE (ts_exchange_ns);

-- Embeddings table with vector column
CREATE TABLE nt_embeddings (
    embedding_id   BIGSERIAL PRIMARY KEY,
    symbol_id      INT NOT NULL,
    venue_id       INT NOT NULL,
    ts_ns          BIGINT NOT NULL,
    embedding_type TEXT NOT NULL,
    dim            INT NOT NULL,
    metadata       JSONB NOT NULL DEFAULT '{}',
    embedding      vector(256)
);

-- Replay segments: range-partitioned by start_ts_ns
CREATE TABLE nt_segments (
    segment_id   BIGSERIAL NOT NULL,
    symbol_id    INT NOT NULL,
    start_ts_ns  BIGINT NOT NULL,
    end_ts_ns    BIGINT NOT NULL,
    segment_kind TEXT NOT NULL,
    data_blob    BYTEA,
    signature    BYTEA,
    witness_hash BYTEA,
    metadata     JSONB,
    PRIMARY KEY (start_ts_ns, segment_id)
) PARTITION BY RANGE (start_ts_ns);

-- Partition registry for lifecycle management
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

-- Model registry
CREATE TABLE nt_model_registry (
    model_id       TEXT PRIMARY KEY,
    model_name     TEXT NOT NULL,
    version        INT NOT NULL,
    artifact_path  TEXT NOT NULL,
    training_hash  TEXT NOT NULL,
    metrics        JSONB NOT NULL DEFAULT '{}',
    promoted_at    TIMESTAMPTZ,
    retired_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ DEFAULT now(),
    UNIQUE (model_name, version)
);

-- Policy receipts
CREATE TABLE nt_policy_receipts (
    receipt_id     BIGSERIAL PRIMARY KEY,
    ts_ns          BIGINT NOT NULL,
    model_id       TEXT REFERENCES nt_model_registry(model_id),
    action_type    TEXT NOT NULL,
    input_hash     TEXT NOT NULL,
    coherence_hash TEXT NOT NULL,
    policy_hash    TEXT NOT NULL,
    token_id       TEXT NOT NULL,
    result_hash    TEXT NOT NULL,
    metadata       JSONB,
    created_at     TIMESTAMPTZ DEFAULT now()
);

-- Schema version tracking
CREATE TABLE nt_schema_version (
    version    INT PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO nt_schema_version (version, name) VALUES (1, '001-init');
