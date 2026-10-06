CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS shopfloor_review_memory (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  path TEXT NOT NULL,
  lens TEXT NOT NULL,
  body TEXT NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'unverified' CHECK (disposition IN ('unverified', 'confirmed', 'dismissed', 'fixed')),
  model_version TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding vector NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shopfloor_review_memory_repo_idx ON shopfloor_review_memory (owner, repo, embedding_model);
