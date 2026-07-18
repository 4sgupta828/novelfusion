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
  setSourceVoice,
  deleteSource,
  listSources,
  getActiveVoicePersona,
  setVoicePersonaEnabled,
  getUtterancesByIdsOrdered,
  saveDraftInfographic,
  listCollaborators,
  createCollaborator,
  getCollaborator,
  deleteCollaborator,
  listUtterances,
  insertSourceBlob,
  getSourceBlob,
  ensureWorkspace,
  listClusters,
  createCluster,
  getCluster,
  updateCluster,
  deleteCluster,
  assignPrincipleCluster,
  clusterMemberCounts,
} from './db/index.js';
import { answerQuery, embedBackfill } from './pipeline/retrieval.js';
import { discoverSources } from './pipeline/discover.js';
import { kickBackfill, startBackfillWorker } from './pipeline/backfill.js';
import { clusterPrinciples } from './pipeline/clusters.js';
import { captureEditContent } from './pipeline/edits.js';
import { assertPrincipleTransition } from './domain/lifecycle.js';
import { distill } from './pipeline/distill.js';
import { latestBlastRadius, runCounterfactual } from './pipeline/counterfactual.js';
import { proposeStubs, weaveDraft } from './pipeline/weave.js';
import { suggestTemplate } from './pipeline/template-advisor.js';
import { suggestInfographic } from './pipeline/infographic.js';
import { distillPersona } from './pipeline/persona.js';
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

// Create a workspace. id is a slug derived from the name (the hard tenancy key); collisions
// are rejected so an existing workspace is never silently reused under a new label.
app.post('/api/workspaces', wrap((req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (name.length < 2) throw new Error('workspace name is required (min 2 chars)');
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (!id) throw new Error('workspace name must contain letters or digits');
  const exists = getDb().prepare('SELECT 1 FROM workspaces WHERE id = ?').get(id);
  if (exists) throw new Error(`workspace "${id}" already exists`);
  ensureWorkspace(id, name);
  res.json({ id, name });
}));

app.get('/api/templates', wrap((_req, res) => {
  res.json(TEMPLATES.map((t) => ({ id: t.id, name: t.name, blurb: t.blurb, sections: t.sections })));
}));

// Client-visible feature flags (drives conditional UI: Query box, download affordance).
app.get('/api/config', wrap((_req, res) => {
  res.json({ flags: { corpusQuery: config.flags.corpusQuery, retainOriginals: config.flags.retainOriginals, sourceDiscovery: config.flags.sourceDiscovery } });
}));

// ---------- collaborators (named experts who author versions) ----------

app.get('/api/:ws/collaborators', wrap((req, res) => {
  res.json(listCollaborators(param(req, 'ws')));
}));

app.post('/api/:ws/collaborators', wrap((req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (name.length < 2) throw new Error('collaborator name is required (min 2 chars)');
  const expertise = typeof req.body?.expertise === 'string' ? req.body.expertise.trim() : '';
  res.json(createCollaborator(param(req, 'ws'), name, expertise));
}));

app.delete('/api/:ws/collaborators/:id', wrap((req, res) => {
  deleteCollaborator(param(req, 'ws'), param(req, 'id'));
  res.json({ ok: true });
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
  const byId = new Map(listCollaborators(ws).map((c) => [c.id, c]));
  res.json({
    ...d,
    utterances: getUtterancesByIds(ws, utteranceIds),
    // Each edit is a "version"; attach its author for display (null author = house editor).
    edits: listEdits(ws)
      .filter((e) => e.draftId === d.id)
      .map((e) => ({ ...e, authorName: e.authorId ? byId.get(e.authorId)?.name ?? 'former collaborator' : 'House editor', authorExpertise: e.authorId ? byId.get(e.authorId)?.expertise ?? '' : '' })),
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

// ---------- principle clusters (escape-hatch groups) ----------

app.get('/api/:ws/clusters', wrap((req, res) => {
  const ws = param(req, 'ws');
  const counts = clusterMemberCounts(ws);
  res.json(listClusters(ws).map((c) => ({ ...c, memberCount: counts.get(c.id) ?? 0 })));
}));

app.post('/api/:ws/clusters', wrap((req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (name.length < 2) throw new Error('cluster name is required (min 2 chars)');
  res.json(createCluster(param(req, 'ws'), name, String(req.body?.description ?? '')));
}));

app.post('/api/:ws/clusters/:id', wrap((req, res) => {
  const ws = param(req, 'ws');
  const id = param(req, 'id');
  if (!getCluster(ws, id)) return void res.status(404).json({ error: 'cluster not found' });
  const patch: { name?: string; description?: string; enabled?: boolean } = {};
  if (typeof req.body?.name === 'string') patch.name = req.body.name.trim();
  if (typeof req.body?.description === 'string') patch.description = req.body.description;
  if (typeof req.body?.enabled === 'boolean') patch.enabled = req.body.enabled;
  updateCluster(ws, id, patch);
  res.json({ ok: true });
}));

app.delete('/api/:ws/clusters/:id', wrap((req, res) => {
  deleteCluster(param(req, 'ws'), param(req, 'id'));
  res.json({ ok: true });
}));

// Assign a principle to a cluster (clusterId null → unassign).
app.post('/api/:ws/principles/:id/cluster', wrap((req, res) => {
  const clusterId = req.body?.clusterId === null || typeof req.body?.clusterId === 'string' ? req.body.clusterId : undefined;
  if (clusterId === undefined) throw new Error('clusterId (string or null) is required');
  assignPrincipleCluster(param(req, 'ws'), param(req, 'id'), clusterId);
  res.json({ ok: true });
}));

// Auto-cluster unclustered live principles into themes (LLM; non-destructive).
app.post('/api/:ws/cluster-principles', wrap(async (req, res) => {
  res.json(await clusterPrinciples(param(req, 'ws')));
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
  const ws = param(req, 'ws');
  const { content, reason, authorId } = req.body ?? {};
  if (typeof content !== 'string' || content.trim() === '') throw new Error('Edited content is required.');
  const chip = reason == null ? null : oneOf<EditReasonChip>(reason, EDIT_REASONS, 'edit reason');
  // Attribute the version to a named collaborator (validated in-workspace), or the house editor.
  let author: string | null = null;
  if (typeof authorId === 'string' && authorId) {
    if (!getCollaborator(ws, authorId)) throw new Error('Unknown collaborator for this workspace.');
    author = authorId;
  }
  const e = captureEditContent(ws, param(req, 'id'), content, chip, author);
  res.json(e);
}));

// Compose + persist a shareable infographic on a draft (grounded in the draft's own content).
app.post('/api/:ws/drafts/:id/infographic', wrap(async (req, res) => {
  res.json(await suggestInfographic(param(req, 'ws'), param(req, 'id')));
}));

// Remove the infographic from a draft.
app.delete('/api/:ws/drafts/:id/infographic', wrap((req, res) => {
  saveDraftInfographic(param(req, 'ws'), param(req, 'id'), null);
  res.json({ ok: true });
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
  const ws = param(req, 'ws');
  const results = [];
  for (const f of files) {
    const r = await ingestUploadBuffer(ws, f.originalname, f.buffer, {});
    // Retain the original bytes (workspace-scoped) so the source can be downloaded. Killable
    // via NF_FLAG_RETAIN_ORIGINALS=false. Only uploads carry bytes; URLs/pasted text do not.
    if (config.flags.retainOriginals) {
      insertSourceBlob({
        sourceId: r.source.id,
        workspaceId: ws,
        filename: f.originalname,
        mime: f.mimetype || 'application/octet-stream',
        size: f.size,
        bytes: f.buffer,
      });
    }
    results.push({ id: r.source.id, title: r.source.title, kind: r.source.kind, segmentCount: r.segmentCount });
  }
  kickBackfill(ws); // eager background embed/index of the newly-admitted passages (no-op if retrieval off)
  res.json(results);
}));

app.post('/api/:ws/ingest-url', wrap(async (req, res) => {
  const url = req.body?.url;
  if (typeof url !== 'string' || !url.trim()) throw new Error('url is required');
  const ws = param(req, 'ws');
  const out = await ingestUrl(ws, url.trim(), { admitted: req.body?.pending !== true });
  kickBackfill(ws);
  res.json(out);
}));

app.post('/api/:ws/ingest-doc', wrap((req, res) => {
  const { title, text } = req.body ?? {};
  if (typeof text !== 'string' || text.trim().length < 24) throw new Error('doc text is required (min 24 chars)');
  const ws = param(req, 'ws');
  const out = ingestDocumentText(ws, text, { title, admitted: req.body?.pending !== true });
  kickBackfill(ws);
  res.json(out);
}));

// Auto-discover public web sources via Exa (flag-gated). Results land QUARANTINED, pending review.
app.post('/api/:ws/discover', wrap(async (req, res) => {
  if (!config.flags.sourceDiscovery) return void res.status(404).json({ error: 'source discovery is disabled (flag NF_FLAG_SOURCE_DISCOVERY off)' });
  const topic = req.body?.topic;
  if (typeof topic !== 'string' || topic.trim().length < 3) throw new Error('topic is required (min 3 chars)');
  res.json(await discoverSources(param(req, 'ws'), topic.trim()));
}));

app.post('/api/:ws/sources/:id/admit', wrap((req, res) => {
  const ws = param(req, 'ws');
  admitSource(ws, param(req, 'id'));
  kickBackfill(ws); // admitting makes its passages retrieval-eligible — embed/index them now, in the background
  res.json({ ok: true });
}));

// Tag/untag a source as the company's published VOICE (the corpus the persona is distilled from).
app.post('/api/:ws/sources/:id/voice', wrap((req, res) => {
  setSourceVoice(param(req, 'ws'), param(req, 'id'), req.body?.voice === true);
  res.json({ ok: true });
}));

// ---------- voice persona ----------

// Distill (+persist) the brand persona from the workspace's voice corpus.
app.post('/api/:ws/persona/distill', wrap(async (req, res) => {
  res.json(await distillPersona(param(req, 'ws')));
}));

// The active persona, with example passages hydrated for receipts.
app.get('/api/:ws/persona', wrap((req, res) => {
  const ws = param(req, 'ws');
  const persona = getActiveVoicePersona(ws);
  if (!persona) return void res.json({ persona: null, examples: [] });
  const p = persona.profile;
  const ids = [...new Set([
    ...p.beliefs.flatMap((b) => b.exampleUtteranceIds),
    ...p.dos.flatMap((d) => d.exampleUtteranceIds),
    ...p.donts.flatMap((d) => d.exampleUtteranceIds),
  ])];
  res.json({ persona, examples: getUtterancesByIdsOrdered(ws, ids) });
}));

// Toggle whether the persona conditions weaving (the voice layer on/off).
app.post('/api/:ws/persona/enabled', wrap((req, res) => {
  setVoicePersonaEnabled(param(req, 'ws'), req.body?.enabled === true);
  res.json({ ok: true });
}));

// Remove a source and everything derived from it (passages, embeddings, FTS, blob, stale
// slated moments). Workspace-scoped; irreversible.
app.delete('/api/:ws/sources/:id', wrap((req, res) => {
  res.json(deleteSource(param(req, 'ws'), param(req, 'id')));
}));

// Source detail — passages with locators (View). Read-only; workspace-scoped.
app.get('/api/:ws/sources/:id', wrap((req, res) => {
  const ws = param(req, 'ws');
  const id = param(req, 'id');
  const passages = listUtterances(ws, id);
  if (passages.length === 0) return void res.status(404).json({ error: 'source not found or has no passages' });
  const blob = config.flags.retainOriginals ? getSourceBlob(ws, id) : null;
  res.json({
    id,
    passages: passages.map((u) => ({ id: u.id, speaker: u.speaker, text: u.text, locator: u.locator, provenanceClass: u.provenanceClass, seq: u.seq })),
    download: blob ? { filename: blob.filename, mime: blob.mime, size: blob.size } : null,
  });
}));

// Download the original uploaded bytes (workspace-scoped; 404 if not retained).
app.get('/api/:ws/sources/:id/download', wrap((req, res) => {
  const blob = getSourceBlob(param(req, 'ws'), param(req, 'id'));
  if (!blob) return void res.status(404).json({ error: 'no original file retained for this source' });
  res.setHeader('Content-Type', blob.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${blob.filename.replace(/"/g, '')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(blob.bytes);
}));

// Export the extracted passages as text (always available — this is what the corpus holds).
app.get('/api/:ws/sources/:id/export', wrap((req, res) => {
  const ws = param(req, 'ws');
  const id = param(req, 'id');
  const passages = listUtterances(ws, id);
  if (passages.length === 0) return void res.status(404).json({ error: 'source not found' });
  const body = passages
    .map((u) => {
      const loc = u.locator;
      const anchor = loc.kind === 'document' ? [loc.page ? `p.${loc.page}` : '', loc.heading ? `§${loc.heading}` : ''].filter(Boolean).join(' ')
        : loc.kind === 'webpage' ? (loc.anchor ? `§${loc.anchor}` : '') : (u.speaker ?? '');
      return `${anchor ? `[${anchor}] ` : ''}${u.text}`;
    })
    .join('\n\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${id}.txt"`);
  res.send(body);
}));

// ---------- corpus query (hybrid retrieval + grounded answer; flag-gated) ----------

app.post('/api/:ws/query', wrap(async (req, res) => {
  if (!config.flags.corpusQuery) return void res.status(404).json({ error: 'corpus query is disabled (flag NF_FLAG_CORPUS_QUERY off)' });
  const ws = param(req, 'ws');
  const q = req.body?.q;
  if (typeof q !== 'string' || q.trim().length < 3) throw new Error('query is required (min 3 chars)');
  await embedBackfill(ws); // lazy: ensure admitted passages are embedded + FTS-indexed (best-effort)
  res.json(await answerQuery(ws, q.trim()));
}));

// ---------- actions (LLM — require credentials; errors surface to the UI) ----------

app.post('/api/:ws/extract', wrap(async (req, res) => {
  res.json(await extractMoments(param(req, 'ws')));
}));

app.post('/api/:ws/moments/:id/stubs', wrap(async (req, res) => {
  res.json(await proposeStubs(param(req, 'ws'), param(req, 'id')));
}));

// LLM recommends the best-fitting template + format for a moment, with reasoning (advisory).
app.post('/api/:ws/moments/:id/suggest-template', wrap(async (req, res) => {
  res.json(await suggestTemplate(param(req, 'ws'), param(req, 'id')));
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
  // Eager background embed/FTS backfill (self-healing sweep). Inert unless retrieval is on.
  startBackfillWorker();
  if (config.flags.corpusQuery && process.env.OPENAI_API_KEY) console.log('  ↳ background backfill worker active (embeds admitted passages eagerly)');
});
