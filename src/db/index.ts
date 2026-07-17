import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import type {
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
  ]);
  addCols('utterances', [
    ['locator', `TEXT NOT NULL DEFAULT '{"kind":"transcript"}'`],
    ['provenance_class', "TEXT NOT NULL DEFAULT 'human_utterance'"],
  ]);
  addCols('sources', [['admitted', 'INTEGER NOT NULL DEFAULT 1']]);

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
      `INSERT INTO edit_events (id, workspace_id, draft_id, reason_chip, diff, edited_content, holdout, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(e.id, e.workspaceId, e.draftId, e.reasonChip, e.diff, e.editedContent, e.holdout ? 1 : 0, e.createdAt);
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
