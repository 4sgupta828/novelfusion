import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import type {
  Cluster,
  Collaborator,
  Idea,
  TalkProposal,
  VoicePersona,
  CounterfactualResult,
  Draft,
  EditEvent,
  EvalRun,
  Moment,
  Principle,
  PrincipleStatus,
  Source,
  Utterance,
} from '../domain/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(path.join(here, 'schema.sql'), 'utf-8');
  db.exec(schema);
  migrate(db);
  return db;
}

/** Additive column migrations for DBs created before a column existed.
 *  Idempotent — checks table_info before each ALTER (SQLite can't ADD IF NOT EXISTS). */
function migrate(d: Database.Database): void {
  const addCols = (table: string, add: [string, string][]) => {
    const cols = new Set((d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name));
    for (const [name, def] of add) if (!cols.has(name)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
  };
  addCols('drafts', [
    ['template', "TEXT NOT NULL DEFAULT 'freeform'"],
    ['sections', "TEXT NOT NULL DEFAULT '[]'"],
    ['viz', "TEXT NOT NULL DEFAULT '[]'"],
    ['infographic', 'TEXT'],
  ]);
  addCols('utterances', [
    ['locator', `TEXT NOT NULL DEFAULT '{"kind":"transcript"}'`],
    ['provenance_class', "TEXT NOT NULL DEFAULT 'human_utterance'"],
  ]);
  addCols('sources', [['admitted', 'INTEGER NOT NULL DEFAULT 1'], ['is_voice', 'INTEGER NOT NULL DEFAULT 0']]);
  addCols('principles', [['cluster_id', 'TEXT']]);
  addCols('edit_events', [['author_id', 'TEXT']]);

  // Relax the old speaker NOT NULL constraint (docs/web segments have no speaker).
  // SQLite can't ALTER a column constraint, so rebuild the table. Safe: nothing has
  // a FK to utterances (moments store JSON ids). Only runs on legacy DBs.
  const info = d.prepare('PRAGMA table_info(utterances)').all() as { name: string; notnull: number }[];
  const speakerCol = info.find((c) => c.name === 'speaker');
  if (speakerCol && speakerCol.notnull === 1) {
    d.transaction(() => {
      d.exec('DROP INDEX IF EXISTS idx_utterances_ws');
      d.exec(`CREATE TABLE utterances_new (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id),
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        speaker TEXT,
        t_start_sec REAL, t_end_sec REAL,
        text TEXT NOT NULL, seq INTEGER NOT NULL,
        locator TEXT NOT NULL DEFAULT '{"kind":"transcript"}',
        provenance_class TEXT NOT NULL DEFAULT 'human_utterance'
      )`);
      d.exec(`INSERT INTO utterances_new (id, source_id, workspace_id, speaker, t_start_sec, t_end_sec, text, seq, locator, provenance_class)
        SELECT id, source_id, workspace_id, speaker, t_start_sec, t_end_sec, text, seq, locator, provenance_class FROM utterances`);
      d.exec('DROP TABLE utterances');
      d.exec('ALTER TABLE utterances_new RENAME TO utterances');
      d.exec('CREATE INDEX IF NOT EXISTS idx_utterances_ws ON utterances(workspace_id, source_id, seq)');
    })();
  }
}

export const newId = (prefix: string) => `${prefix}_${randomUUID().slice(0, 12)}`;

// ---------- workspaces ----------

export function ensureWorkspace(id: string, name?: string): void {
  getDb()
    .prepare('INSERT INTO workspaces (id, name) VALUES (?, ?) ON CONFLICT(id) DO NOTHING')
    .run(id, name ?? id);
}

export function listWorkspaceIds(): string[] {
  return (getDb().prepare('SELECT id FROM workspaces').all() as { id: string }[]).map((r) => r.id);
}

// ---------- sources & utterances ----------

export function insertSource(s: Source): void {
  getDb()
    .prepare(
      `INSERT INTO sources (id, workspace_id, kind, uri, title, recorded_at, consent_basis, admitted)
       VALUES (@id, @workspaceId, @kind, @uri, @title, @recordedAt, @consentBasis, @admittedInt)`,
    )
    .run({ ...s, admittedInt: s.admitted ? 1 : 0 } as unknown as Record<string, unknown>);
}

export function admitSource(workspaceId: string, sourceId: string): void {
  getDb().prepare('UPDATE sources SET admitted = 1 WHERE workspace_id = ? AND id = ?').run(workspaceId, sourceId);
}

/** Tag/untag a source as part of the VOICE corpus (published brand output the persona learns from). */
export function setSourceVoice(workspaceId: string, sourceId: string, isVoice: boolean): void {
  getDb().prepare('UPDATE sources SET is_voice = ? WHERE workspace_id = ? AND id = ?').run(isVoice ? 1 : 0, workspaceId, sourceId);
}

/** Admitted passages from voice-tagged sources — the corpus the persona is distilled from. */
export function listVoiceUtterances(workspaceId: string): (Utterance & { workspaceId: string })[] {
  const rows = getDb()
    .prepare(
      `SELECT u.*, s.title AS source_title FROM utterances u
       JOIN sources s ON s.id = u.source_id
       WHERE u.workspace_id = ? AND s.admitted = 1 AND s.is_voice = 1 ORDER BY u.source_id, u.seq`,
    )
    .all(workspaceId) as Record<string, unknown>[];
  return rows.map(rowToUtterance);
}

// ---------- voice persona ----------

function rowToVoicePersona(r: Record<string, unknown>): VoicePersona {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    version: r.version as number,
    profile: JSON.parse(r.profile as string),
    enabled: (r.enabled as number) === 1,
    createdAt: r.created_at as string,
  };
}

/** The latest persona for a workspace (the active one), or null. */
export function getActiveVoicePersona(workspaceId: string): VoicePersona | null {
  const r = getDb()
    .prepare('SELECT * FROM voice_personas WHERE workspace_id = ? ORDER BY version DESC, created_at DESC LIMIT 1')
    .get(workspaceId) as Record<string, unknown> | undefined;
  return r ? rowToVoicePersona(r) : null;
}

/** Save a freshly-distilled persona as a new version (becomes the active one). */
export function saveVoicePersona(workspaceId: string, profile: unknown): VoicePersona {
  const prev = getActiveVoicePersona(workspaceId);
  const id = newId('voice');
  getDb()
    .prepare('INSERT INTO voice_personas (id, workspace_id, version, profile, enabled) VALUES (?, ?, ?, ?, 1)')
    .run(id, workspaceId, (prev?.version ?? 0) + 1, JSON.stringify(profile));
  return getActiveVoicePersona(workspaceId)!;
}

/** Toggle whether the active persona conditions weaving (the voice layer's on/off switch). */
export function setVoicePersonaEnabled(workspaceId: string, enabled: boolean): void {
  const p = getActiveVoicePersona(workspaceId);
  if (p) getDb().prepare('UPDATE voice_personas SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, p.id);
}

/** Remove a source and everything derived from it, workspace-scoped: its passages, their
 *  embeddings + FTS rows, the retained blob, and any SLATED moments that cited a deleted
 *  passage (a slated moment pointing at deleted content is stale). Woven/rejected moments and
 *  drafts are history and preserved (their receipts to deleted passages simply won't resolve).
 *  Returns how many slated moments were removed. */
export function deleteSource(workspaceId: string, sourceId: string): { deletedMoments: number } {
  const db = getDb();
  let deletedMoments = 0;
  const tx = db.transaction(() => {
    const uids = new Set(
      (db.prepare('SELECT id FROM utterances WHERE workspace_id = ? AND source_id = ?').all(workspaceId, sourceId) as { id: string }[]).map((r) => r.id),
    );
    if (uids.size > 0) {
      const slated = db.prepare("SELECT id, utterance_ids FROM moments WHERE workspace_id = ? AND state = 'slated'").all(workspaceId) as { id: string; utterance_ids: string }[];
      const del = db.prepare('DELETE FROM moments WHERE id = ?');
      for (const m of slated) {
        const ids = JSON.parse(m.utterance_ids) as string[];
        if (ids.some((id) => uids.has(id))) { del.run(m.id); deletedMoments++; }
      }
    }
    // Derived rows keyed off the passages — delete before the passages themselves.
    db.prepare('DELETE FROM passage_embeddings WHERE workspace_id = ? AND utterance_id IN (SELECT id FROM utterances WHERE workspace_id = ? AND source_id = ?)').run(workspaceId, workspaceId, sourceId);
    db.prepare('DELETE FROM passage_fts WHERE workspace_id = ? AND utterance_id IN (SELECT id FROM utterances WHERE workspace_id = ? AND source_id = ?)').run(workspaceId, workspaceId, sourceId);
    db.prepare('DELETE FROM utterances WHERE workspace_id = ? AND source_id = ?').run(workspaceId, sourceId);
    db.prepare('DELETE FROM source_blobs WHERE workspace_id = ? AND source_id = ?').run(workspaceId, sourceId);
    db.prepare('DELETE FROM sources WHERE workspace_id = ? AND id = ?').run(workspaceId, sourceId);
  });
  tx();
  return { deletedMoments };
}

export interface SourceSummary {
  id: string;
  kind: string;
  title: string;
  uri: string;
  consentBasis: string;
  admitted: boolean;
  isVoice: boolean;
  segmentCount: number;
  createdAt: string;
}

export function listSources(workspaceId: string): SourceSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT s.id, s.kind, s.title, s.uri, s.consent_basis, s.admitted, s.is_voice, s.created_at,
              (SELECT COUNT(*) FROM utterances u WHERE u.source_id = s.id) AS seg_count
       FROM sources s WHERE s.workspace_id = ? ORDER BY s.created_at DESC`,
    )
    .all(workspaceId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    kind: r.kind as string,
    title: r.title as string,
    uri: r.uri as string,
    consentBasis: r.consent_basis as string,
    admitted: (r.admitted as number) === 1,
    isVoice: (r.is_voice as number) === 1,
    segmentCount: r.seg_count as number,
    createdAt: r.created_at as string,
  }));
}

export function insertUtterances(rows: Utterance[]): void {
  const stmt = getDb().prepare(
    `INSERT INTO utterances (id, source_id, workspace_id, speaker, t_start_sec, t_end_sec, text, seq, locator, provenance_class)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = getDb().transaction((items: Utterance[]) => {
    for (const u of items) {
      stmt.run(u.id, u.sourceId, u.workspaceId, u.speaker, u.tStartSec, u.tEndSec, u.text, u.seq,
        JSON.stringify(u.locator), u.provenanceClass);
    }
  });
  tx(rows);
}

function rowToUtterance(r: Record<string, unknown>): Utterance & { workspaceId: string } {
  return {
    id: r.id as string,
    sourceId: r.source_id as string,
    workspaceId: r.workspace_id as string,
    speaker: (r.speaker as string | null) ?? null,
    tStartSec: r.t_start_sec as number | null,
    tEndSec: r.t_end_sec as number | null,
    text: r.text as string,
    seq: r.seq as number,
    locator: JSON.parse((r.locator as string) ?? '{"kind":"transcript"}'),
    provenanceClass: ((r.provenance_class as string) ?? 'human_utterance') as Utterance['provenanceClass'],
    sourceTitle: r.source_title as string | undefined,
  };
}

/** Extraction reads only ADMITTED sources (ingest quarantine). */
export function listUtterances(
  workspaceId: string,
  sourceId?: string,
  opts: { admittedOnly?: boolean } = {},
): (Utterance & { workspaceId: string })[] {
  const admitted = opts.admittedOnly ? ' AND s.admitted = 1' : '';
  const sql = sourceId
    ? `SELECT u.* FROM utterances u JOIN sources s ON s.id = u.source_id WHERE u.workspace_id = ? AND u.source_id = ?${admitted} ORDER BY u.seq`
    : `SELECT u.* FROM utterances u JOIN sources s ON s.id = u.source_id WHERE u.workspace_id = ?${admitted} ORDER BY u.source_id, u.seq`;
  const rows = (sourceId ? getDb().prepare(sql).all(workspaceId, sourceId) : getDb().prepare(sql).all(workspaceId)) as Record<string, unknown>[];
  return rows.map(rowToUtterance);
}

export function getUtterancesByIds(workspaceId: string, ids: string[]): (Utterance & { workspaceId: string })[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = getDb()
    .prepare(
      `SELECT u.*, s.title AS source_title FROM utterances u
       JOIN sources s ON s.id = u.source_id
       WHERE u.workspace_id = ? AND u.id IN (${placeholders}) ORDER BY u.seq`,
    )
    .all(workspaceId, ...ids) as Record<string, unknown>[];
  return rows.map(rowToUtterance);
}

/** THE retrieval isolation choke-point (panel-mandated). Every candidate id from any
 *  retrieval leg (FTS, dense cosine) becomes passage text ONLY through this call. It is
 *  workspace-scoped, so a foreign-workspace id simply vanishes from the result (fail-safe:
 *  a leak becomes a silently-dropped candidate). Unlike getUtterancesByIds it preserves the
 *  CALLER's id order (retrieval rank), not seq order. Also used by the span-gate to refetch a
 *  cited passage — it must never fetch by bare id across workspaces (cross-tenant false-pass). */
export function getUtterancesByIdsOrdered(workspaceId: string, ids: string[]): (Utterance & { workspaceId: string })[] {
  const byId = new Map(getUtterancesByIds(workspaceId, ids).map((u) => [u.id, u]));
  const out: (Utterance & { workspaceId: string })[] = [];
  for (const id of ids) {
    const u = byId.get(id);
    if (u) out.push(u); // foreign / unknown ids drop out here
  }
  return out;
}

// ---------- source blobs (original-bytes retention for download) ----------

export interface SourceBlob {
  sourceId: string;
  workspaceId: string;
  filename: string;
  mime: string;
  size: number;
  bytes: Buffer;
}

export function insertSourceBlob(b: SourceBlob): void {
  getDb()
    .prepare(
      `INSERT INTO source_blobs (source_id, workspace_id, filename, mime, size, bytes)
       VALUES (@sourceId, @workspaceId, @filename, @mime, @size, @bytes)
       ON CONFLICT(source_id) DO UPDATE SET
         filename = excluded.filename, mime = excluded.mime, size = excluded.size, bytes = excluded.bytes`,
    )
    .run(b as unknown as Record<string, unknown>);
}

/** Workspace-scoped fetch — never returns another workspace's blob even on a colliding id. */
export function getSourceBlob(workspaceId: string, sourceId: string): SourceBlob | null {
  const r = getDb()
    .prepare('SELECT source_id, workspace_id, filename, mime, size, bytes FROM source_blobs WHERE workspace_id = ? AND source_id = ?')
    .get(workspaceId, sourceId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    sourceId: r.source_id as string,
    workspaceId: r.workspace_id as string,
    filename: r.filename as string,
    mime: r.mime as string,
    size: r.size as number,
    bytes: r.bytes as Buffer,
  };
}

// ---------- FTS lexical leg (NON-PORTABLE; isolated here) ----------

/** Populate/refresh the FTS row for a passage. Called from the flag-gated retrieval
 *  backfill only — NOT from ingest and NOT via a trigger (a trigger would fire with the
 *  flag OFF, breaking Rule 20's byte-identical OFF path). */
export function ftsUpsertPassages(rows: { id: string; workspaceId: string; text: string }[]): void {
  const del = getDb().prepare('DELETE FROM passage_fts WHERE utterance_id = ?');
  const ins = getDb().prepare('INSERT INTO passage_fts (utterance_id, workspace_id, text) VALUES (?, ?, ?)');
  const tx = getDb().transaction((items: typeof rows) => {
    for (const r of items) { del.run(r.id); ins.run(r.id, r.workspaceId, r.text); }
  });
  tx(rows);
}

export function ftsIndexedIds(workspaceId: string): Set<string> {
  const rows = getDb().prepare('SELECT utterance_id FROM passage_fts WHERE workspace_id = ?').all(workspaceId) as { utterance_id: string }[];
  return new Set(rows.map((r) => r.utterance_id));
}

/** BM25 recall leg. Returns utterance ids best-match-first, workspace- AND admitted-scoped.
 *  Query is tokenized to a safe OR-of-terms MATCH (recall only — the LLM owns meaning). */
export function ftsSearch(workspaceId: string, query: string, limit: number): string[] {
  const terms = query.match(/[\p{L}\p{N}]+/gu);
  if (!terms || terms.length === 0) return [];
  const match = terms.map((t) => `"${t}"`).join(' OR ');
  const rows = getDb()
    .prepare(
      `SELECT f.utterance_id AS id FROM passage_fts f
       JOIN utterances u ON u.id = f.utterance_id
       JOIN sources s ON s.id = u.source_id
       WHERE f.workspace_id = ? AND s.admitted = 1 AND passage_fts MATCH ?
       ORDER BY bm25(passage_fts) LIMIT ?`,
    )
    .all(workspaceId, match, limit) as { id: string }[];
  return rows.map((r) => r.id);
}

// ---------- dense embeddings sidecar ----------

export function upsertEmbedding(row: { utteranceId: string; workspaceId: string; model: string; dim: number; vec: Float32Array }): void {
  getDb()
    .prepare(
      `INSERT INTO passage_embeddings (utterance_id, workspace_id, model, dim, vec)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(utterance_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, vec = excluded.vec`,
    )
    .run(row.utteranceId, row.workspaceId, row.model, row.dim, Buffer.from(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength));
}

/** Admitted, not-yet-embedded (for the current model) passages in a workspace. */
export function listUnembeddedUtterances(workspaceId: string, model: string): { id: string; text: string; workspaceId: string }[] {
  const rows = getDb()
    .prepare(
      `SELECT u.id, u.text, u.workspace_id FROM utterances u
       JOIN sources s ON s.id = u.source_id
       WHERE u.workspace_id = ? AND s.admitted = 1
         AND NOT EXISTS (SELECT 1 FROM passage_embeddings e WHERE e.utterance_id = u.id AND e.model = ?)`,
    )
    .all(workspaceId, model) as Record<string, unknown>[];
  return rows.map((r) => ({ id: r.id as string, text: r.text as string, workspaceId: r.workspace_id as string }));
}

/** Load a workspace's dense vectors for one embedding space (model+dim). The dense leg
 *  scans these in JS; the WHERE is the isolation + space guard. */
export function loadEmbeddings(workspaceId: string, model: string, dim: number): { id: string; vec: Float32Array }[] {
  const rows = getDb()
    .prepare('SELECT utterance_id AS id, vec FROM passage_embeddings WHERE workspace_id = ? AND model = ? AND dim = ?')
    .all(workspaceId, model, dim) as { id: string; vec: Buffer }[];
  return rows.map((r) => {
    const b = r.vec;
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); // aligned copy
    return { id: r.id, vec: new Float32Array(ab) };
  });
}

/** Counterfactual results are per-RUN evidence: a fresh ratification run replaces
 *  prior rows so "latest blast radius" is truly the latest run, never cumulative
 *  history (panel finding: cumulative rows let repeated runs dilute or
 *  permanently block the accept gate). */
export function deleteCounterfactuals(workspaceId: string, principleId: string): void {
  getDb()
    .prepare('DELETE FROM counterfactual_results WHERE workspace_id = ? AND principle_id = ?')
    .run(workspaceId, principleId);
}

// ---------- moments ----------

export function insertMoment(m: Moment): void {
  getDb()
    .prepare(
      `INSERT INTO moments (id, workspace_id, utterance_ids, claim, judgment, score, state, rejection_chip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(m.id, m.workspaceId, JSON.stringify(m.utteranceIds), m.claim, JSON.stringify(m.judgment), m.score, m.state, m.rejectionChip);
}

function rowToMoment(r: Record<string, unknown>): Moment {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    utteranceIds: JSON.parse(r.utterance_ids as string),
    claim: r.claim as string,
    judgment: JSON.parse(r.judgment as string),
    score: r.score as number,
    state: r.state as Moment['state'],
    rejectionChip: (r.rejection_chip as Moment['rejectionChip']) ?? null,
  };
}

export function listMoments(workspaceId: string, state?: string, limit = 50): Moment[] {
  const rows = (
    state
      ? getDb().prepare('SELECT * FROM moments WHERE workspace_id = ? AND state = ? ORDER BY score DESC LIMIT ?').all(workspaceId, state, limit)
      : getDb().prepare('SELECT * FROM moments WHERE workspace_id = ? ORDER BY score DESC LIMIT ?').all(workspaceId, limit)
  ) as Record<string, unknown>[];
  return rows.map(rowToMoment);
}

/** The Slate: the day's publishing queue. Auto-mined moments are ranked by novelty×credibility and
 *  capped at `top` (the attention budget). A PROMOTED moment (a human explicitly chose an idea →
 *  moment) is a deliberate decision, not an algorithmic guess — so it is PINNED above the ranked
 *  set and never hidden by the score cutoff (a promoted moment carries a neutral credibility prior,
 *  so it would otherwise sink below the fold). Promoted-first, newest-first; each carries a
 *  `promoted` flag for the UI. Promoted items drain from the slate as they're woven or rejected. */
export function listSlate(workspaceId: string, top = 5): (Moment & { promoted: boolean })[] {
  const promotedRows = getDb()
    .prepare(
      `SELECT m.* FROM moments m
       WHERE m.workspace_id = ? AND m.state = 'slated'
         AND m.id IN (SELECT promoted_moment_id FROM ideas WHERE workspace_id = ? AND promoted_moment_id IS NOT NULL)
       ORDER BY m.created_at DESC`,
    )
    .all(workspaceId, workspaceId) as Record<string, unknown>[];
  const promotedIds = new Set(promotedRows.map((r) => r.id as string));
  const ranked = (
    getDb().prepare(`SELECT * FROM moments WHERE workspace_id = ? AND state = 'slated' ORDER BY score DESC`).all(workspaceId) as Record<string, unknown>[]
  )
    .filter((r) => !promotedIds.has(r.id as string)) // never double-count a promoted moment
    .slice(0, top);
  return [...promotedRows, ...ranked].map((r) => ({ ...rowToMoment(r), promoted: promotedIds.has(r.id as string) }));
}

/** Canonical dedup keys for every existing moment in a workspace (any state, so a rejected
 *  moment is never resurrected by a re-extract). Key = sorted utterance-id set — a STRUCTURAL
 *  identity (code owns structure, Rule 18), not a claim-text match. */
export function existingMomentKeys(workspaceId: string): Set<string> {
  const rows = getDb().prepare('SELECT utterance_ids FROM moments WHERE workspace_id = ?').all(workspaceId) as { utterance_ids: string }[];
  return new Set(rows.map((r) => momentKey(JSON.parse(r.utterance_ids) as string[])));
}

/** The structural identity of a moment: its utterance-id set, order-independent. */
export function momentKey(utteranceIds: string[]): string {
  return [...utteranceIds].sort().join('|');
}

export function getMoment(workspaceId: string, id: string): Moment | null {
  const r = getDb().prepare('SELECT * FROM moments WHERE workspace_id = ? AND id = ?').get(workspaceId, id) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToMoment(r) : null;
}

export function updateMomentState(workspaceId: string, id: string, state: string, chip?: string): void {
  getDb()
    .prepare('UPDATE moments SET state = ?, rejection_chip = COALESCE(?, rejection_chip) WHERE workspace_id = ? AND id = ?')
    .run(state, chip ?? null, workspaceId, id);
}

// ---------- drafts ----------

export function insertDraft(d: Draft): void {
  getDb()
    .prepare(
      `INSERT INTO drafts (id, workspace_id, moment_id, format, angle, template, content, sections, viz, provenance, constitution_version, holdout, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      d.id, d.workspaceId, d.momentId, d.format, d.angle, d.template, d.content,
      JSON.stringify(d.sections), JSON.stringify(d.viz), JSON.stringify(d.provenance),
      d.constitutionVersion, d.holdout ? 1 : 0, d.state, d.createdAt,
    );
}

function rowToDraft(r: Record<string, unknown>): Draft {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    momentId: r.moment_id as string,
    format: r.format as Draft['format'],
    angle: r.angle as string,
    template: (r.template as string) ?? 'freeform',
    content: r.content as string,
    sections: JSON.parse((r.sections as string) ?? '[]'),
    viz: JSON.parse((r.viz as string) ?? '[]'),
    infographic: r.infographic ? JSON.parse(r.infographic as string) : null,
    provenance: JSON.parse(r.provenance as string),
    constitutionVersion: r.constitution_version as number,
    holdout: (r.holdout as number) === 1,
    state: r.state as Draft['state'],
    createdAt: r.created_at as string,
  };
}

export function getDraft(workspaceId: string, id: string): Draft | null {
  const r = getDb().prepare('SELECT * FROM drafts WHERE workspace_id = ? AND id = ?').get(workspaceId, id) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToDraft(r) : null;
}

/** Persist (or clear) the infographic poster attached to a draft — makes it part of the post. */
export function saveDraftInfographic(workspaceId: string, id: string, poster: unknown | null): void {
  getDb()
    .prepare('UPDATE drafts SET infographic = ? WHERE workspace_id = ? AND id = ?')
    .run(poster == null ? null : JSON.stringify(poster), workspaceId, id);
}

export function listDrafts(workspaceId: string, opts: { holdout?: boolean } = {}): Draft[] {
  let sql = 'SELECT * FROM drafts WHERE workspace_id = ?';
  const args: unknown[] = [workspaceId];
  if (opts.holdout !== undefined) {
    sql += ' AND holdout = ?';
    args.push(opts.holdout ? 1 : 0);
  }
  sql += ' ORDER BY created_at';
  const rows = getDb().prepare(sql).all(...args) as Record<string, unknown>[];
  return rows.map(rowToDraft);
}

// ---------- edits ----------

export function insertEdit(e: EditEvent): void {
  getDb()
    .prepare(
      `INSERT INTO edit_events (id, workspace_id, draft_id, author_id, reason_chip, diff, edited_content, holdout, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(e.id, e.workspaceId, e.draftId, e.authorId, e.reasonChip, e.diff, e.editedContent, e.holdout ? 1 : 0, e.createdAt);
}

// ---------- collaborators (named experts / SMEs) ----------

function rowToCollaborator(r: Record<string, unknown>): Collaborator {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    name: r.name as string,
    expertise: (r.expertise as string) ?? '',
    createdAt: r.created_at as string,
  };
}

export function listCollaborators(workspaceId: string): Collaborator[] {
  return (getDb().prepare('SELECT * FROM collaborators WHERE workspace_id = ? ORDER BY created_at').all(workspaceId) as Record<string, unknown>[]).map(rowToCollaborator);
}

export function getCollaborator(workspaceId: string, id: string): Collaborator | null {
  const r = getDb().prepare('SELECT * FROM collaborators WHERE workspace_id = ? AND id = ?').get(workspaceId, id) as Record<string, unknown> | undefined;
  return r ? rowToCollaborator(r) : null;
}

export function createCollaborator(workspaceId: string, name: string, expertise = ''): Collaborator {
  const id = newId('collab');
  getDb().prepare('INSERT INTO collaborators (id, workspace_id, name, expertise) VALUES (?, ?, ?, ?)').run(id, workspaceId, name, expertise);
  return getCollaborator(workspaceId, id)!;
}

export function deleteCollaborator(workspaceId: string, id: string): void {
  // Keep authored versions but detach them (author_id → NULL): history is never silently destroyed.
  const tx = getDb().transaction(() => {
    getDb().prepare('UPDATE edit_events SET author_id = NULL WHERE workspace_id = ? AND author_id = ?').run(workspaceId, id);
    getDb().prepare('DELETE FROM collaborators WHERE workspace_id = ? AND id = ?').run(workspaceId, id);
  });
  tx();
}

// ---------- ideas (scratch space upstream of the slate) ----------

function rowToIdea(r: Record<string, unknown>): Idea {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    text: r.text as string,
    rationale: (r.rationale as string) ?? '',
    novelty: (r.novelty as number) ?? 0.5,
    sourceUtteranceIds: JSON.parse((r.source_utterance_ids as string) ?? '[]'),
    origin: r.origin as Idea['origin'],
    clusterTitle: (r.cluster_title as string) ?? null,
    clusterThesis: (r.cluster_thesis as string) ?? null,
    authorId: (r.author_id as string) ?? null,
    status: r.status as Idea['status'],
    promotedMomentId: (r.promoted_moment_id as string) ?? null,
    createdAt: r.created_at as string,
  };
}

export type NewIdea = Omit<Idea, 'id' | 'status' | 'promotedMomentId' | 'createdAt'>;

export function insertIdea(idea: NewIdea): Idea {
  const id = newId('idea');
  getDb()
    .prepare(
      `INSERT INTO ideas (id, workspace_id, text, rationale, novelty, source_utterance_ids, origin, cluster_title, cluster_thesis, author_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      idea.workspaceId,
      idea.text,
      idea.rationale,
      idea.novelty,
      JSON.stringify(idea.sourceUtteranceIds),
      idea.origin,
      idea.clusterTitle,
      idea.clusterThesis,
      idea.authorId,
    );
  return getIdea(idea.workspaceId, id)!;
}

export function getIdea(workspaceId: string, id: string): Idea | null {
  const r = getDb().prepare('SELECT * FROM ideas WHERE workspace_id = ? AND id = ?').get(workspaceId, id) as Record<string, unknown> | undefined;
  return r ? rowToIdea(r) : null;
}

export function listIdeas(workspaceId: string, status?: Idea['status']): Idea[] {
  const rows = (
    status
      ? getDb().prepare('SELECT * FROM ideas WHERE workspace_id = ? AND status = ? ORDER BY created_at DESC').all(workspaceId, status)
      : getDb().prepare('SELECT * FROM ideas WHERE workspace_id = ? ORDER BY created_at DESC').all(workspaceId)
  ) as Record<string, unknown>[];
  return rows.map(rowToIdea);
}

/** Set an idea's status. When promoting, records the moment it became (traceability). */
export function updateIdeaStatus(workspaceId: string, id: string, status: Idea['status'], promotedMomentId: string | null = null): void {
  getDb()
    .prepare('UPDATE ideas SET status = ?, promoted_moment_id = ? WHERE workspace_id = ? AND id = ?')
    .run(status, promotedMomentId, workspaceId, id);
}

export function deleteIdea(workspaceId: string, id: string): void {
  getDb().prepare('DELETE FROM ideas WHERE workspace_id = ? AND id = ?').run(workspaceId, id);
}

// ---------- talk proposals (the Talk Slate — discovery layer of talk_kit) ----------

function rowToTalkProposal(r: Record<string, unknown>): TalkProposal {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    title: r.title as string,
    goal: r.goal as string,
    outcome: (r.outcome as string) ?? '',
    thesis: (r.thesis as string) ?? '',
    audience: (r.audience as string) ?? '',
    format: (r.format as string) ?? 'webinar',
    outline: JSON.parse((r.outline as string) ?? '[]'),
    sourceUtteranceIds: JSON.parse((r.source_utterance_ids as string) ?? '[]'),
    feasibility: (r.feasibility as number) ?? 0.5,
    novelty: (r.novelty as number) ?? 0.5,
    rationale: (r.rationale as string) ?? '',
    buildsOn: JSON.parse((r.builds_on as string) ?? '[]'),
    status: r.status as TalkProposal['status'],
    createdAt: r.created_at as string,
  };
}

export type NewTalkProposal = Omit<TalkProposal, 'id' | 'status' | 'createdAt'>;

export function insertTalkProposal(t: NewTalkProposal): TalkProposal {
  const id = newId('talk');
  getDb()
    .prepare(
      `INSERT INTO talk_proposals (id, workspace_id, title, goal, outcome, thesis, audience, format, outline, source_utterance_ids, feasibility, novelty, rationale, builds_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      t.workspaceId,
      t.title,
      t.goal,
      t.outcome,
      t.thesis,
      t.audience,
      t.format,
      JSON.stringify(t.outline),
      JSON.stringify(t.sourceUtteranceIds),
      t.feasibility,
      t.novelty,
      t.rationale,
      JSON.stringify(t.buildsOn),
    );
  return getTalkProposal(t.workspaceId, id)!;
}

export function getTalkProposal(workspaceId: string, id: string): TalkProposal | null {
  const r = getDb().prepare('SELECT * FROM talk_proposals WHERE workspace_id = ? AND id = ?').get(workspaceId, id) as Record<string, unknown> | undefined;
  return r ? rowToTalkProposal(r) : null;
}

export function listTalkProposals(workspaceId: string, status?: TalkProposal['status']): TalkProposal[] {
  const rows = (
    status
      ? getDb().prepare('SELECT * FROM talk_proposals WHERE workspace_id = ? AND status = ? ORDER BY feasibility DESC, created_at DESC').all(workspaceId, status)
      : getDb().prepare('SELECT * FROM talk_proposals WHERE workspace_id = ? ORDER BY feasibility DESC, created_at DESC').all(workspaceId)
  ) as Record<string, unknown>[];
  return rows.map(rowToTalkProposal);
}

export function updateTalkProposalStatus(workspaceId: string, id: string, status: TalkProposal['status']): void {
  getDb().prepare('UPDATE talk_proposals SET status = ? WHERE workspace_id = ? AND id = ?').run(status, workspaceId, id);
}

export function deleteTalkProposal(workspaceId: string, id: string): void {
  getDb().prepare('DELETE FROM talk_proposals WHERE workspace_id = ? AND id = ?').run(workspaceId, id);
}

export function listEdits(workspaceId: string, opts: { holdout?: boolean } = {}): EditEvent[] {
  let sql = 'SELECT * FROM edit_events WHERE workspace_id = ?';
  const args: unknown[] = [workspaceId];
  if (opts.holdout !== undefined) {
    sql += ' AND holdout = ?';
    args.push(opts.holdout ? 1 : 0);
  }
  sql += ' ORDER BY created_at';
  const rows = getDb().prepare(sql).all(...args) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    draftId: r.draft_id as string,
    authorId: (r.author_id as string | null) ?? null,
    reasonChip: (r.reason_chip as EditEvent['reasonChip']) ?? null,
    diff: r.diff as string,
    editedContent: r.edited_content as string,
    holdout: (r.holdout as number) === 1,
    createdAt: r.created_at as string,
  }));
}

// ---------- principles ----------

export function insertPrinciple(p: Principle): void {
  getDb()
    .prepare(
      `INSERT INTO principles (id, workspace_id, text, tier, scope, status, evidence_edit_ids, counterexamples, version, fire_count, override_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      p.id, p.workspaceId, p.text, p.tier, JSON.stringify(p.scope), p.status,
      JSON.stringify(p.evidenceEditIds), JSON.stringify(p.counterexamples),
      p.version, p.fireCount, p.overrideCount, p.createdAt,
    );
}

function rowToPrinciple(r: Record<string, unknown>): Principle {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    text: r.text as string,
    tier: r.tier as Principle['tier'],
    scope: JSON.parse(r.scope as string),
    status: r.status as Principle['status'],
    evidenceEditIds: JSON.parse(r.evidence_edit_ids as string),
    counterexamples: JSON.parse(r.counterexamples as string),
    version: r.version as number,
    fireCount: r.fire_count as number,
    overrideCount: r.override_count as number,
    clusterId: (r.cluster_id as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

export function listPrinciples(workspaceId: string, status?: PrincipleStatus): Principle[] {
  const rows = (
    status
      ? getDb().prepare('SELECT * FROM principles WHERE workspace_id = ? AND status = ? ORDER BY created_at').all(workspaceId, status)
      : getDb().prepare('SELECT * FROM principles WHERE workspace_id = ? ORDER BY created_at').all(workspaceId)
  ) as Record<string, unknown>[];
  return rows.map(rowToPrinciple);
}

export function getPrinciple(workspaceId: string, id: string): Principle | null {
  const r = getDb().prepare('SELECT * FROM principles WHERE workspace_id = ? AND id = ?').get(workspaceId, id) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToPrinciple(r) : null;
}

export function updatePrincipleStatus(workspaceId: string, id: string, status: PrincipleStatus): void {
  getDb().prepare('UPDATE principles SET status = ? WHERE workspace_id = ? AND id = ?').run(status, workspaceId, id);
}

// ---------- clusters (escape-hatch groups) ----------

function rowToCluster(r: Record<string, unknown>): Cluster {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    name: r.name as string,
    description: (r.description as string) ?? '',
    enabled: (r.enabled as number) === 1,
    createdAt: r.created_at as string,
  };
}

export function listClusters(workspaceId: string): Cluster[] {
  const rows = getDb().prepare('SELECT * FROM clusters WHERE workspace_id = ? ORDER BY created_at').all(workspaceId) as Record<string, unknown>[];
  return rows.map(rowToCluster);
}

export function getCluster(workspaceId: string, id: string): Cluster | null {
  const r = getDb().prepare('SELECT * FROM clusters WHERE workspace_id = ? AND id = ?').get(workspaceId, id) as Record<string, unknown> | undefined;
  return r ? rowToCluster(r) : null;
}

export function createCluster(workspaceId: string, name: string, description = '', enabled = true): Cluster {
  const id = newId('clu');
  getDb()
    .prepare('INSERT INTO clusters (id, workspace_id, name, description, enabled) VALUES (?, ?, ?, ?, ?)')
    .run(id, workspaceId, name, description, enabled ? 1 : 0);
  return getCluster(workspaceId, id)!;
}

export function updateCluster(workspaceId: string, id: string, patch: { name?: string; description?: string; enabled?: boolean }): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.name !== undefined) { sets.push('name = ?'); vals.push(patch.name); }
  if (patch.description !== undefined) { sets.push('description = ?'); vals.push(patch.description); }
  if (patch.enabled !== undefined) { sets.push('enabled = ?'); vals.push(patch.enabled ? 1 : 0); }
  if (sets.length === 0) return;
  vals.push(workspaceId, id);
  getDb().prepare(`UPDATE clusters SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`).run(...vals);
}

/** Delete a cluster; its principles fall back to unclustered (cluster_id → NULL). */
export function deleteCluster(workspaceId: string, id: string): void {
  const tx = getDb().transaction(() => {
    getDb().prepare('UPDATE principles SET cluster_id = NULL WHERE workspace_id = ? AND cluster_id = ?').run(workspaceId, id);
    getDb().prepare('DELETE FROM clusters WHERE workspace_id = ? AND id = ?').run(workspaceId, id);
  });
  tx();
}

/** Assign a principle to a cluster (or null to unassign). Validates the cluster is in-workspace. */
export function assignPrincipleCluster(workspaceId: string, principleId: string, clusterId: string | null): void {
  if (clusterId !== null && !getCluster(workspaceId, clusterId)) throw new Error(`Cluster ${clusterId} not found in workspace.`);
  getDb().prepare('UPDATE principles SET cluster_id = ? WHERE workspace_id = ? AND id = ?').run(clusterId, workspaceId, principleId);
}

/** Cluster ids that are currently DISABLED — the escape hatch. Their principles are suspended
 *  from conditioning new drafts (weave), regardless of the principle's own status. */
export function disabledClusterIds(workspaceId: string): Set<string> {
  const rows = getDb().prepare('SELECT id FROM clusters WHERE workspace_id = ? AND enabled = 0').all(workspaceId) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/** Member count per cluster (all statuses), for the UI. */
export function clusterMemberCounts(workspaceId: string): Map<string, number> {
  const rows = getDb()
    .prepare('SELECT cluster_id, COUNT(*) AS n FROM principles WHERE workspace_id = ? AND cluster_id IS NOT NULL GROUP BY cluster_id')
    .all(workspaceId) as { cluster_id: string; n: number }[];
  return new Map(rows.map((r) => [r.cluster_id, r.n]));
}

/** Constitution version = count of status transitions to active/shadow, monotonic-ish for Phase 0. */
export function constitutionVersion(workspaceId: string): number {
  const r = getDb()
    .prepare("SELECT COUNT(*) AS n FROM principles WHERE workspace_id = ? AND status IN ('shadow','active','decaying','retired')")
    .get(workspaceId) as { n: number };
  return r.n;
}

// ---------- counterfactuals & eval runs ----------

export function insertCounterfactual(c: CounterfactualResult & { id: string; workspaceId: string }): void {
  getDb()
    .prepare(
      `INSERT INTO counterfactual_results (id, workspace_id, principle_id, draft_id, in_scope, changed, diff)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(c.id, c.workspaceId, c.principleId, c.draftId, c.inScope ? 1 : 0, c.changed ? 1 : 0, c.diff);
}

export function listCounterfactuals(workspaceId: string, principleId: string): CounterfactualResult[] {
  const rows = getDb()
    .prepare('SELECT * FROM counterfactual_results WHERE workspace_id = ? AND principle_id = ?')
    .all(workspaceId, principleId) as Record<string, unknown>[];
  return rows.map((r) => ({
    principleId: r.principle_id as string,
    draftId: r.draft_id as string,
    inScope: (r.in_scope as number) === 1,
    changed: (r.changed as number) === 1,
    diff: r.diff as string,
  }));
}

export function insertEvalRun(e: EvalRun): void {
  getDb()
    .prepare('INSERT INTO eval_runs (id, workspace_id, kind, config_json, results_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(e.id, e.workspaceId, e.kind, e.configJson, e.resultsJson, e.createdAt);
}

export function listEvalRuns(workspaceId: string, kind?: string): EvalRun[] {
  const rows = (
    kind
      ? getDb().prepare('SELECT * FROM eval_runs WHERE workspace_id = ? AND kind = ? ORDER BY created_at DESC').all(workspaceId, kind)
      : getDb().prepare('SELECT * FROM eval_runs WHERE workspace_id = ? ORDER BY created_at DESC').all(workspaceId)
  ) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    kind: r.kind as EvalRun['kind'],
    configJson: r.config_json as string,
    resultsJson: r.results_json as string,
    createdAt: r.created_at as string,
  }));
}
