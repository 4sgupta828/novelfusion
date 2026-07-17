// Local workbench server — JSON API over the existing SQLite pipeline + the
// static web UI. Phase 0 tool: single-user, localhost only. Workspace scoping
// is enforced by passing :ws into every db call (the hard boundary lives in
// src/db, which filters every query on workspace_id).

import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import {
  getDraft,
  getMoment,
  getPrinciple,
  getUtterancesByIds,
  getDb,
  listDrafts,
  listEdits,
  listMoments,
  listPrinciples,
  updateMomentState,
  updatePrincipleStatus,
  admitSource,
  listSources,
} from './db/index.js';
import { captureEditContent } from './pipeline/edits.js';
import { assertPrincipleTransition } from './domain/lifecycle.js';
import { distill } from './pipeline/distill.js';
import { latestBlastRadius, runCounterfactual } from './pipeline/counterfactual.js';
import { proposeStubs, weaveDraft } from './pipeline/weave.js';
import { extractMoments } from './pipeline/moments.js';
import { ingestUrl, ingestDocumentText, ingestUploadBuffer } from './pipeline/ingest.js';
import { gateReport } from './report/gate.js';
import { listCounterfactuals } from './db/index.js';
import { TEMPLATES } from './domain/templates.js';
import type { AssetFormat, EditReasonChip, RejectionChip } from './domain/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.NF_PORT ?? 4780);

// Cross-origin defense (panel finding: 127.0.0.1 binding does not stop a hostile
// web page from firing no-preflight POSTs at localhost, and DNS rebinding can
// upgrade that to reads). Two independent checks on every /api mutation:
//   1. Host must be a localhost origin (defeats DNS rebinding).
//   2. A custom header must be present (forces a CORS preflight, which a
//      cross-origin page cannot pass) and Origin/Referer, when sent, must match.
const LOCAL_HOSTS = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
app.use('/api', (req, res, next) => {
  if (!LOCAL_HOSTS.has(req.headers.host ?? '')) {
    return void res.status(403).json({ error: 'forbidden host' });
  }
  if (req.method !== 'GET') {
    const origin = req.headers.origin ?? (req.headers.referer ? new URL(req.headers.referer).host : null);
    const originOk = origin === null || LOCAL_HOSTS.has(origin.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
    if (!originOk || req.headers['x-nf-workbench'] !== '1') {
      return void res.status(403).json({ error: 'forbidden origin' });
    }
  }
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(here, '..', 'web')));

// Request-body enum validation (panel finding: blind casts persisted arbitrary
// strings into columns the distiller and scope matching consume as enums).
const REJECTION_CHIPS: RejectionChip[] = ['not_our_pov', 'too_generic', 'off_limits_source', 'wrong_speaker', 'legal_risk', 'already_said'];
const EDIT_REASONS: EditReasonChip[] = ['off-voice', 'off-strategy', 'risky', 'not-now', 'factual', 'style'];
const FORMATS: AssetFormat[] = ['li_post', 'x_thread', 'blog', 'clip_spec'];
function oneOf<T extends string>(value: unknown, allowed: T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as string[]).includes(value)) {
    throw new Error(`Invalid ${field}: expected one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/** Express 5 types params as string | string[]; our routes only ever bind single segments. */
const param = (req: express.Request, name: string): string => {
  const v = req.params[name];
  return Array.isArray(v) ? v[0]! : (v as string);
};

type Handler = (req: express.Request, res: express.Response) => Promise<void> | void;
const wrap = (fn: Handler): express.RequestHandler => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
};

// ---------- read surfaces ----------

app.get('/api/workspaces', wrap((_req, res) => {
  const rows = getDb().prepare('SELECT id, name FROM workspaces ORDER BY created_at').all();
  res.json(rows);
}));

app.get('/api/templates', wrap((_req, res) => {
  res.json(TEMPLATES.map((t) => ({ id: t.id, name: t.name, blurb: t.blurb, sections: t.sections })));
}));

app.get('/api/:ws/slate', wrap((req, res) => {
  const ws = param(req, 'ws');
  const top = Number.isFinite(Number(req.query.top)) ? Number(req.query.top) : 5;
  const moments = listMoments(ws, 'slated', top).map((m) => ({
    ...m,
    utterances: getUtterancesByIds(ws, m.utteranceIds),
  }));
  res.json(moments);
}));

app.get('/api/:ws/moments/:id', wrap((req, res) => {
  const ws = param(req, 'ws');
  const m = getMoment(ws, param(req, 'id'));
  if (!m) return void res.status(404).json({ error: 'moment not found' });
  res.json({ ...m, utterances: getUtterancesByIds(ws, m.utteranceIds) });
}));

app.get('/api/:ws/drafts', wrap((req, res) => {
  const ws = param(req, 'ws');
  const allEdits = listEdits(ws);
  const drafts = listDrafts(ws).map((d) => ({
    ...d,
    editCount: allEdits.filter((e) => e.draftId === d.id).length,
    figureCount: d.viz.length,
  }));
  res.json(drafts.reverse());
}));

app.get('/api/:ws/drafts/:id', wrap((req, res) => {
  const ws = param(req, 'ws');
  const d = getDraft(ws, param(req, 'id'));
  if (!d) return void res.status(404).json({ error: 'draft not found' });
  const utteranceIds = [...new Set(d.provenance.flatMap((p) => p.utteranceIds))];
  res.json({
    ...d,
    utterances: getUtterancesByIds(ws, utteranceIds),
    edits: listEdits(ws).filter((e) => e.draftId === d.id),
  });
}));

app.get('/api/:ws/constitution', wrap((req, res) => {
  const ws = param(req, 'ws');
  const principles = listPrinciples(ws).map((p) => {
    const cf = listCounterfactuals(ws, p.id);
    return { ...p, counterfactualCount: cf.length, blast: cf.length > 0 ? latestBlastRadius(ws, p.id) : null };
  });
  res.json(principles);
}));

app.get('/api/:ws/principles/:id/report', wrap((req, res) => {
  const ws = param(req, 'ws');
  const results = listCounterfactuals(ws, param(req, 'id'));
  res.json({ results, blast: latestBlastRadius(ws, param(req, 'id')) });
}));

app.get('/api/:ws/gate', wrap((req, res) => {
  res.json(gateReport(param(req, 'ws')));
}));

// ---------- actions (structural — no LLM) ----------

app.post('/api/:ws/moments/:id/reject', wrap((req, res) => {
  const chip = oneOf<RejectionChip>(req.body?.chip, REJECTION_CHIPS, 'rejection chip');
  updateMomentState(param(req, 'ws'), param(req, 'id'), 'rejected', chip);
  res.json({ ok: true });
}));

app.post('/api/:ws/drafts/:id/edit', wrap((req, res) => {
  const { content, reason } = req.body ?? {};
  if (typeof content !== 'string' || content.trim() === '') throw new Error('Edited content is required.');
  const chip = reason == null ? null : oneOf<EditReasonChip>(reason, EDIT_REASONS, 'edit reason');
  const e = captureEditContent(param(req, 'ws'), param(req, 'id'), content, chip);
  res.json(e);
}));

app.post('/api/:ws/principles/:id/accept', wrap((req, res) => {
  const ws = param(req, 'ws');
  const id = param(req, 'id');
  const principle = getPrinciple(ws, id);
  if (!principle) throw new Error(`Principle ${id} not found.`);
  assertPrincipleTransition(principle.status, 'accept');
  // Same gate as the CLI: ratification requires a counterfactual run and ≤10% blast radius.
  const blast = latestBlastRadius(ws, id);
  if (blast.inScopeTotal + blast.outOfScopeTotal === 0) {
    throw new Error('No counterfactual run yet — run "Ratify" first. Acceptance is gated on diffs, not prose.');
  }
  if (blast.radius > 0.1) {
    throw new Error(`Out-of-scope blast radius ${(blast.radius * 100).toFixed(0)}% exceeds 10% — narrow the scope or reject.`);
  }
  updatePrincipleStatus(ws, id, 'shadow');
  res.json({ ok: true, status: 'shadow' });
}));

app.post('/api/:ws/principles/:id/promote', wrap((req, res) => {
  const ws = param(req, 'ws');
  const id = param(req, 'id');
  const principle = getPrinciple(ws, id);
  if (!principle) throw new Error(`Principle ${id} not found.`);
  assertPrincipleTransition(principle.status, 'promote');
  updatePrincipleStatus(ws, id, 'active');
  res.json({ ok: true, status: 'active' });
}));

app.post('/api/:ws/principles/:id/reject', wrap((req, res) => {
  const ws = param(req, 'ws');
  const id = param(req, 'id');
  const principle = getPrinciple(ws, id);
  if (!principle) throw new Error(`Principle ${id} not found.`);
  assertPrincipleTransition(principle.status, 'reject');
  updatePrincipleStatus(ws, id, 'rejected');
  res.json({ ok: true, status: 'rejected' });
}));

// ---------- corpus: sources list + ingestion (upload / paste / URL) ----------

app.get('/api/:ws/sources', wrap((req, res) => {
  res.json(listSources(param(req, 'ws')));
}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
app.post('/api/:ws/ingest-file', upload.array('files', 20), wrap(async (req, res) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (files.length === 0) throw new Error('no files uploaded');
  const results = [];
  for (const f of files) {
    const r = await ingestUploadBuffer(param(req, 'ws'), f.originalname, f.buffer, {});
    results.push({ id: r.source.id, title: r.source.title, kind: r.source.kind, segmentCount: r.segmentCount });
  }
  res.json(results);
}));

app.post('/api/:ws/ingest-url', wrap(async (req, res) => {
  const url = req.body?.url;
  if (typeof url !== 'string' || !url.trim()) throw new Error('url is required');
  res.json(await ingestUrl(param(req, 'ws'), url.trim(), { admitted: req.body?.pending !== true }));
}));

app.post('/api/:ws/ingest-doc', wrap((req, res) => {
  const { title, text } = req.body ?? {};
  if (typeof text !== 'string' || text.trim().length < 24) throw new Error('doc text is required (min 24 chars)');
  res.json(ingestDocumentText(param(req, 'ws'), text, { title, admitted: req.body?.pending !== true }));
}));

app.post('/api/:ws/sources/:id/admit', wrap((req, res) => {
  admitSource(param(req, 'ws'), param(req, 'id'));
  res.json({ ok: true });
}));

// ---------- actions (LLM — require credentials; errors surface to the UI) ----------

app.post('/api/:ws/extract', wrap(async (req, res) => {
  res.json(await extractMoments(param(req, 'ws')));
}));

app.post('/api/:ws/moments/:id/stubs', wrap(async (req, res) => {
  res.json(await proposeStubs(param(req, 'ws'), param(req, 'id')));
}));

app.post('/api/:ws/moments/:id/weave', wrap(async (req, res) => {
  const format = oneOf<AssetFormat>(req.body?.format, FORMATS, 'format');
  const angle = typeof req.body?.angle === 'string' ? req.body.angle : 'default';
  const template = typeof req.body?.template === 'string' ? req.body.template : 'freeform';
  res.json(await weaveDraft(param(req, 'ws'), param(req, 'id'), format, angle, { template }));
}));

app.post('/api/:ws/distill', wrap(async (req, res) => {
  res.json(await distill(param(req, 'ws')));
}));

app.post('/api/:ws/principles/:id/ratify', wrap(async (req, res) => {
  const r = await runCounterfactual(param(req, 'ws'), param(req, 'id'));
  res.json({ blast: r.blast, reportPath: r.reportPath });
}));

app.listen(port, '127.0.0.1', () => {
  console.log(`NovelFusion workbench → http://localhost:${port}  (db: ${config.dbPath})`);
});
