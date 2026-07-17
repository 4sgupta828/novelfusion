-- NovelFusion Phase 0 schema (SQLite; keep portable — Postgres is the Phase 1 target).
-- Workspace isolation is a HARD boundary: every table carries workspace_id and every
-- query in src/db/index.ts filters on it. No cross-workspace query path may exist.

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL,
  uri TEXT NOT NULL,
  title TEXT NOT NULL,
  recorded_at TEXT,
  consent_basis TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS utterances (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  speaker TEXT NOT NULL,
  t_start_sec REAL,
  t_end_sec REAL,
  text TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_utterances_ws ON utterances(workspace_id, source_id, seq);

CREATE TABLE IF NOT EXISTS moments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  utterance_ids TEXT NOT NULL,          -- JSON array
  claim TEXT NOT NULL,
  judgment TEXT NOT NULL,               -- JSON MomentJudgment
  score REAL NOT NULL,
  state TEXT NOT NULL DEFAULT 'slated',
  rejection_chip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_moments_ws ON moments(workspace_id, state, score);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  moment_id TEXT NOT NULL REFERENCES moments(id),
  format TEXT NOT NULL,
  angle TEXT NOT NULL,
  template TEXT NOT NULL DEFAULT 'freeform',
  content TEXT NOT NULL,
  sections TEXT NOT NULL DEFAULT '[]',   -- JSON DraftSection[]
  viz TEXT NOT NULL DEFAULT '[]',        -- JSON VizSpec[]
  provenance TEXT NOT NULL,             -- JSON ProvenanceEntry[]
  constitution_version INTEGER NOT NULL DEFAULT 0,
  holdout INTEGER NOT NULL DEFAULT 0,   -- Rule 5: holdouts excluded from exemplars/distillation
  state TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_drafts_ws ON drafts(workspace_id, state);

CREATE TABLE IF NOT EXISTS edit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  reason_chip TEXT,
  diff TEXT NOT NULL,
  edited_content TEXT NOT NULL,
  holdout INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_edits_ws ON edit_events(workspace_id, holdout);

CREATE TABLE IF NOT EXISTS principles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  text TEXT NOT NULL,
  tier TEXT NOT NULL,
  scope TEXT NOT NULL,                  -- JSON PrincipleScope
  status TEXT NOT NULL DEFAULT 'candidate',
  evidence_edit_ids TEXT NOT NULL,      -- JSON array
  counterexamples TEXT NOT NULL,        -- JSON array
  version INTEGER NOT NULL DEFAULT 1,
  fire_count INTEGER NOT NULL DEFAULT 0,
  override_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_principles_ws ON principles(workspace_id, status);

CREATE TABLE IF NOT EXISTS counterfactual_results (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  principle_id TEXT NOT NULL REFERENCES principles(id),
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  in_scope INTEGER NOT NULL,
  changed INTEGER NOT NULL,
  diff TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL,
  config_json TEXT NOT NULL,            -- Rule 11: enough to re-run (model, versions, git SHA)
  results_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
