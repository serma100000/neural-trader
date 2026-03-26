-- 002-indexes.sql: Indexes for neural-trader storage layer (ADR-005)

-- Event log indexes
CREATE INDEX idx_event_log_symbol_ts
    ON nt_event_log (symbol_id, ts_exchange_ns);

CREATE INDEX idx_event_log_venue_ts
    ON nt_event_log (venue_id, ts_exchange_ns);

CREATE INDEX idx_event_log_type
    ON nt_event_log (event_type, ts_exchange_ns);

CREATE INDEX idx_event_log_seq
    ON nt_event_log (seq);

CREATE INDEX idx_event_log_order_hash
    ON nt_event_log (order_id_hash)
    WHERE order_id_hash IS NOT NULL;

-- Embeddings indexes
CREATE INDEX idx_embeddings_symbol_ts
    ON nt_embeddings (symbol_id, ts_ns);

CREATE INDEX idx_embeddings_type
    ON nt_embeddings (embedding_type, ts_ns);

CREATE INDEX idx_embeddings_venue
    ON nt_embeddings (venue_id, ts_ns);

-- HNSW index for approximate nearest neighbor search on embeddings
CREATE INDEX idx_embeddings_hnsw
    ON nt_embeddings
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Segments indexes
CREATE INDEX idx_segments_symbol
    ON nt_segments (symbol_id, start_ts_ns);

CREATE INDEX idx_segments_kind
    ON nt_segments (segment_kind, start_ts_ns);

CREATE INDEX idx_segments_time_range
    ON nt_segments (start_ts_ns, end_ts_ns);

-- Partition registry indexes
CREATE INDEX idx_partition_registry_table
    ON nt_partition_registry (table_name, range_start_ns);

CREATE INDEX idx_partition_registry_tier
    ON nt_partition_registry (tier);

-- Model registry indexes
CREATE INDEX idx_model_registry_name
    ON nt_model_registry (model_name, version);

CREATE INDEX idx_model_registry_promoted
    ON nt_model_registry (model_name, promoted_at)
    WHERE promoted_at IS NOT NULL AND retired_at IS NULL;

-- Policy receipts indexes
CREATE INDEX idx_policy_receipts_ts
    ON nt_policy_receipts (ts_ns);

CREATE INDEX idx_policy_receipts_model
    ON nt_policy_receipts (model_id, ts_ns);

CREATE INDEX idx_policy_receipts_token
    ON nt_policy_receipts (token_id);

-- Schema version tracking
INSERT INTO nt_schema_version (version, name) VALUES (2, '002-indexes');
