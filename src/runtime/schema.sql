-- Shopfloor control-plane durable ledger (Neon / Postgres)
-- Applied automatically by PostgresRuntimeStore.ensureSchema().

CREATE TABLE IF NOT EXISTS shopfloor_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  owner TEXT NOT NULL DEFAULT '',
  repo TEXT NOT NULL DEFAULT '',
  installation_id INTEGER,
  received_at TIMESTAMPTZ NOT NULL,
  duplicate BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS shopfloor_runs (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  issue_number INTEGER,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  error_message TEXT,
  executed BOOLEAN NOT NULL DEFAULT FALSE,
  reason TEXT
);

CREATE INDEX IF NOT EXISTS shopfloor_runs_created_at_idx
  ON shopfloor_runs (created_at DESC);

CREATE INDEX IF NOT EXISTS shopfloor_runs_delivery_id_idx
  ON shopfloor_runs (delivery_id);

CREATE TABLE IF NOT EXISTS shopfloor_audit (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  event JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS shopfloor_audit_run_id_idx
  ON shopfloor_audit (run_id);
