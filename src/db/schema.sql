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
  admitted INTEGER NOT NULL DEFAULT 1,   -- ingest quarantine: 0 = pending review, excluded from extraction
  is_voice INTEGER NOT NULL DEFAULT 0,   -- 1 = published brand output (the voice corpus the persona is distilled from)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Distilled brand-voice persona (the "soul"): register, lexicon, rhetoric, beliefs, obsessions, and
-- do/don'ts inferred from the workspace's VOICE corpus (published output). A versioned, inspectable,
-- receipted artifact that conditions weaving (the voice layer), independent of the constitution.
CREATE TABLE IF NOT EXISTS voice_personas (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  version INTEGER NOT NULL DEFAULT 1,
  profile TEXT NOT NULL,                 -- JSON VoicePersonaProfile (each trait cites example utterance ids)
  enabled INTEGER NOT NULL DEFAULT 1,    -- whether this persona conditions weaving
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_voice_personas_ws ON voice_personas(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS utterances (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  speaker TEXT,                          -- null for non-transcript segments
  t_start_sec REAL,
  t_end_sec REAL,
  text TEXT NOT NULL,
  seq INTEGER NOT NULL,
  locator TEXT NOT NULL DEFAULT '{"kind":"transcript"}',   -- JSON Locator
  provenance_class TEXT NOT NULL DEFAULT 'human_utterance'
);
CREATE INDEX IF NOT EXISTS idx_utterances_ws ON utterances(workspace_id, source_id, seq);

-- Original uploaded bytes (opt-in retention, download feature). Confidential source
-- data: workspace-scoped, size-capped at the ingest boundary. Kept separate from the
-- hot utterances path so no passage read ever drags a file blob.
CREATE TABLE IF NOT EXISTS source_blobs (
  source_id TEXT PRIMARY KEY REFERENCES sources(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Dense embeddings sidecar (retrieval flag). Kept OFF the hot SELECT u.* path.
-- model/dim carried so the dense leg never cosines across two embedding spaces
-- (the "dual embedding" landmine). workspace_id denormalized for the isolation filter.
CREATE TABLE IF NOT EXISTS passage_embeddings (
  utterance_id TEXT PRIMARY KEY REFERENCES utterances(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,                     -- Float32Array bytes
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_passage_emb_ws ON passage_embeddings(workspace_id, model);

-- BM25 lexical recall leg (retrieval flag). FTS5 is NON-PORTABLE to Postgres tsvector —
-- deliberately isolated behind ftsSearch()/ftsUpsertPassages() in index.ts; Phase-1 rewrite.
-- workspace_id is a stored filter column: every MATCH query ANDs on it (FTS5 does not
-- inherit the base table's tenancy).
CREATE VIRTUAL TABLE IF NOT EXISTS passage_fts USING fts5(
  utterance_id UNINDEXED,
  workspace_id UNINDEXED,
  text
);

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
  infographic TEXT,                      -- JSON InfographicPoster | null (persisted, part of the post)
  provenance TEXT NOT NULL,             -- JSON ProvenanceEntry[]
  constitution_version INTEGER NOT NULL DEFAULT 0,
  holdout INTEGER NOT NULL DEFAULT 0,   -- Rule 5: holdouts excluded from exemplars/distillation
  state TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_drafts_ws ON drafts(workspace_id, state);

-- Named human collaborators (experts / SMEs) per workspace. Each can author a version of a draft
-- via an attributed edit (per the PRD's named-person model). Phase 0 is single-user: "acting as"
-- a collaborator is chosen in the UI, not authenticated.
CREATE TABLE IF NOT EXISTS collaborators (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  expertise TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_collaborators_ws ON collaborators(workspace_id);

CREATE TABLE IF NOT EXISTS edit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  author_id TEXT,                       -- collaborator who authored this version (null = house editor)
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
  cluster_id TEXT,                        -- optional grouping (nullable = unclustered)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_principles_ws ON principles(workspace_id, status);

-- Principle clusters: named groups toggled on/off as a temporary "escape hatch". Disabling a
-- cluster suspends its ACTIVE principles from conditioning new drafts (weave) without changing
-- their status — re-enable to restore. Grouping is LLM-proposed (semantic; Rule 18) or manual.
CREATE TABLE IF NOT EXISTS clusters (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,     -- 0 = escape hatch engaged (suspended from generation)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clusters_ws ON clusters(workspace_id);

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
