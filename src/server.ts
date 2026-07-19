// Local workbench server — JSON API over the existing SQLite pipeline + the
// static web UI. Phase 0 tool: single-user, localhost only. Workspace scoping
// is enforced by passing :ws into every db call (the hard boundary lives in
// src/db, which filters every query on workspace_id).

import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
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
  listSlate,
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
  listConsentGrants,
  insertConsentGrant,
  revokeConsentGrant,
  consentGate,
  sourceExists,
  listRenderedClips,
  getRenderedClip,
  deleteRenderedClip,
  listFusionVideos,
  getFusionVideo,
  deleteFusionVideo,
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
  listIdeas,
  getIdea,
  updateIdeaStatus,
  deleteIdea,
  listTalkProposals,
  deleteTalkProposal,
} from './db/index.js';
import { generateIdeaClusters, brainstormIdeas, promoteIdeaToMoment } from './pipeline/ideas.js';
import { proposeTalks, planTalk, dismissTalk, reopenTalk, developTalk, talkKit } from './pipeline/talks.js';
import { renderClip, clipFileAbsPath, ClipError } from './pipeline/clips.js';
import { renderFusionVideo, fusionFileAbsPath, FusionError } from './pipeline/fusion.js';
import { answerQuery, embedBackfill } from './pipeline/retrieval.js';
import { discoverSources } from './pipeline/discover.js';
import { sweepFootprint } from './pipeline/footprint.js';
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
// Serve the SPA with ETags but force revalidation: `no-cache` means the browser must check with
// the server before reusing a cached asset, so a plain reload always gets the latest app.js/CSS
// after a redeploy (unchanged files still return a cheap 304). Without this, the no-build SPA's
// cached JS/CSS goes stale and UI changes appear to "not show up".
app.use(
  express.static(path.join(here, '..', 'web'), {
    etag: true,
    lastModified: true,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }),
);

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
  res.json({ flags: { corpusQuery: config.flags.corpusQuery, retainOriginals: config.flags.retainOriginals, sourceDiscovery: config.flags.sourceDiscovery, talkKit: config.flags.talkKit, clipRender: config.flags.clipRender, fusionVideo: config.flags.fusionVideo } });
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

// ---------- consent ledger (per-person, scoped, revocable grants + the gate) ----------

const CONSENT_SCOPES = ['quote', 'clip', 'likeness', 'voice_clone'];

app.get('/api/:ws/consent', wrap((req, res) => {
  res.json(listConsentGrants(param(req, 'ws')));
}));

app.post('/api/:ws/consent', wrap((req, res) => {
  const ws = param(req, 'ws');
  const subjectLabel = typeof req.body?.subjectLabel === 'string' ? req.body.subjectLabel.trim() : '';
  if (subjectLabel.length < 2) throw new Error('a person name is required (min 2 chars)');
  const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes.filter((s: unknown) => CONSENT_SCOPES.includes(s as string)) : [];
  if (scopes.length === 0) throw new Error('at least one consent scope is required (quote/clip/likeness/voice_clone)');
  const channels = Array.isArray(req.body?.channels) && req.body.channels.length ? req.body.channels.map((c: unknown) => String(c)) : ['all'];
  const grant = insertConsentGrant({
    workspaceId: ws,
    subjectLabel,
    collaboratorId: typeof req.body?.collaboratorId === 'string' && req.body.collaboratorId ? req.body.collaboratorId : null,
    scopes,
    channels,
    survivesDeparture: req.body?.survivesDeparture === true,
    evidence: typeof req.body?.evidence === 'string' ? req.body.evidence.trim() : '',
    grantedAt: typeof req.body?.grantedAt === 'string' && req.body.grantedAt ? req.body.grantedAt : null,
  });
  res.json(grant);
}));

app.post('/api/:ws/consent/:id/revoke', wrap((req, res) => {
  revokeConsentGrant(param(req, 'ws'), param(req, 'id'));
  res.json({ ok: true });
}));

// Probe the gate (for UI coverage display / future render blocks).
app.get('/api/:ws/consent/check', wrap((req, res) => {
  const ws = param(req, 'ws');
  const subjectLabel = String(req.query.subject ?? '');
  const scope = String(req.query.scope ?? '') as import('./domain/types.js').ConsentScope;
  const channel = String(req.query.channel ?? 'all');
  if (!subjectLabel || !CONSENT_SCOPES.includes(scope)) return void res.status(400).json({ error: 'subject and a valid scope are required' });
  res.json(consentGate(ws, { subjectLabel, scope, channel }));
}));

// ---------- ideas (scratch space upstream of the slate) ----------

const hydrateIdea = (ws: string, idea: import('./domain/types.js').Idea) => ({
  ...idea,
  utterances: getUtterancesByIdsOrdered(ws, idea.sourceUtteranceIds),
});

app.get('/api/:ws/ideas', wrap((req, res) => {
  const ws = param(req, 'ws');
  const status = typeof req.query.status === 'string' ? (req.query.status as import('./domain/types.js').IdeaStatus) : undefined;
  res.json(listIdeas(ws, status).map((i) => hydrateIdea(ws, i)));
}));

app.post('/api/:ws/ideas/cluster', wrap(async (req, res) => {
  const ws = param(req, 'ws');
  const created = await generateIdeaClusters(ws);
  res.json(created.map((i) => hydrateIdea(ws, i)));
}));

app.post('/api/:ws/ideas/brainstorm', wrap(async (req, res) => {
  const ws = param(req, 'ws');
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (prompt.length < 3) throw new Error('a brainstorm prompt is required (min 3 chars)');
  const authorId = typeof req.body?.authorId === 'string' && req.body.authorId ? req.body.authorId : null;
  const refineIdeaId = typeof req.body?.refineIdeaId === 'string' && req.body.refineIdeaId ? req.body.refineIdeaId : null;
  const created = await brainstormIdeas(ws, { prompt, authorId, refineIdeaId });
  res.json(created.map((i) => hydrateIdea(ws, i)));
}));

app.post('/api/:ws/ideas/:id/promote', wrap((req, res) => {
  const ws = param(req, 'ws');
  const moment = promoteIdeaToMoment(ws, param(req, 'id'));
  res.json({ ok: true, moment });
}));

app.post('/api/:ws/ideas/:id/dismiss', wrap((req, res) => {
  const ws = param(req, 'ws');
  const idea = getIdea(ws, param(req, 'id'));
  if (!idea) return void res.status(404).json({ error: 'idea not found' });
  updateIdeaStatus(ws, idea.id, 'dismissed');
  res.json({ ok: true });
}));

app.delete('/api/:ws/ideas/:id', wrap((req, res) => {
  deleteIdea(param(req, 'ws'), param(req, 'id'));
  res.json({ ok: true });
}));

// ---------- talk slate (proposed long-form talks; behind NF_FLAG_TALK_KIT) ----------

const talkKitGate = (res: import('express').Response): boolean => {
  if (!config.flags.talkKit) {
    res.status(404).json({ error: 'talk slate is disabled (flag NF_FLAG_TALK_KIT off)' });
    return false;
  }
  return true;
};

const hydrateTalk = (ws: string, t: import('./domain/types.js').TalkProposal) => ({
  ...t,
  utterances: getUtterancesByIdsOrdered(ws, t.sourceUtteranceIds),
});

app.get('/api/:ws/talks', wrap((req, res) => {
  if (!talkKitGate(res)) return;
  const ws = param(req, 'ws');
  const status = typeof req.query.status === 'string' ? (req.query.status as import('./domain/types.js').TalkStatus) : undefined;
  res.json(listTalkProposals(ws, status).map((t) => hydrateTalk(ws, t)));
}));

app.post('/api/:ws/talks/propose', wrap(async (req, res) => {
  if (!talkKitGate(res)) return;
  const ws = param(req, 'ws');
  const goal = typeof req.body?.goal === 'string' && req.body.goal.trim() ? req.body.goal.trim() : undefined;
  const created = await proposeTalks(ws, { goal });
  res.json(created.map((t) => hydrateTalk(ws, t)));
}));

app.post('/api/:ws/talks/:id/plan', wrap((req, res) => {
  if (!talkKitGate(res)) return;
  const ws = param(req, 'ws');
  const talk = planTalk(ws, param(req, 'id'));
  res.json({ ok: true, talk: hydrateTalk(ws, talk) });
}));

app.post('/api/:ws/talks/:id/dismiss', wrap((req, res) => {
  if (!talkKitGate(res)) return;
  const ws = param(req, 'ws');
  dismissTalk(ws, param(req, 'id'));
  res.json({ ok: true });
}));

app.delete('/api/:ws/talks/:id', wrap((req, res) => {
  if (!talkKitGate(res)) return;
  deleteTalkProposal(param(req, 'ws'), param(req, 'id'));
  res.json({ ok: true });
}));

app.post('/api/:ws/talks/:id/reopen', wrap((req, res) => {
  if (!talkKitGate(res)) return;
  const ws = param(req, 'ws');
  const talk = reopenTalk(ws, param(req, 'id'));
  res.json({ ok: true, talk: hydrateTalk(ws, talk) });
}));

// Hydrate a run-of-show's receipts: gather every sourced point's utterance ids and attach texts.
const hydrateKit = (ws: string, kit: import('./domain/types.js').TalkKit) => {
  const ids = [...new Set(kit.segments.flatMap((s) => s.points.flatMap((p) => p.utteranceIds)))];
  return { ...kit, utterances: getUtterancesByIdsOrdered(ws, ids) };
};

app.post('/api/:ws/talks/:id/develop', wrap(async (req, res) => {
  if (!talkKitGate(res)) return;
  const ws = param(req, 'ws');
  const kit = await developTalk(ws, param(req, 'id'));
  res.json(hydrateKit(ws, kit));
}));

app.get('/api/:ws/talks/:id/kit', wrap((req, res) => {
  if (!talkKitGate(res)) return;
  const ws = param(req, 'ws');
  const kit = talkKit(ws, param(req, 'id'));
  if (!kit) return void res.status(404).json({ error: 'no run-of-show yet' });
  res.json(hydrateKit(ws, kit));
}));

app.get('/api/:ws/slate', wrap((req, res) => {
  const ws = param(req, 'ws');
  const top = Number.isFinite(Number(req.query.top)) ? Number(req.query.top) : 5;
  const moments = listSlate(ws, top).map((m) => ({
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

// ---------- real-footage clip rendering (behind NF_FLAG_CLIP_RENDER) ----------

const clipGate = (res: import('express').Response): boolean => {
  if (!config.flags.clipRender) {
    res.status(404).json({ error: 'clip rendering is disabled (flag NF_FLAG_CLIP_RENDER off)' });
    return false;
  }
  return true;
};

// Attach the original recording (audio/video) to an existing source, so real clips can be cut from it.
const mediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 400 * 1024 * 1024 } });
app.post('/api/:ws/sources/:id/media', mediaUpload.single('file'), wrap((req, res) => {
  if (!clipGate(res)) return;
  const ws = param(req, 'ws');
  const sourceId = param(req, 'id');
  const f = req.file as Express.Multer.File | undefined;
  if (!f) throw new Error('no file uploaded');
  if (!sourceExists(ws, sourceId)) return void res.status(404).json({ error: 'source not found' });
  const mime = f.mimetype || 'application/octet-stream';
  if (!/^(audio|video)\//.test(mime)) throw new Error(`attach an audio or video file (got ${mime})`);
  insertSourceBlob({ sourceId, workspaceId: ws, filename: f.originalname, mime, size: f.size, bytes: f.buffer });
  res.json({ ok: true, filename: f.originalname, mime, size: f.size });
}));

app.post('/api/:ws/clips/render', wrap(async (req, res) => {
  if (!clipGate(res)) return;
  const ws = param(req, 'ws');
  const momentId = typeof req.body?.momentId === 'string' && req.body.momentId ? req.body.momentId : undefined;
  const utteranceIds = Array.isArray(req.body?.utteranceIds) ? req.body.utteranceIds.map((x: unknown) => String(x)) : undefined;
  const format = ['16:9', '9:16', '1:1'].includes(req.body?.format) ? req.body.format : '16:9';
  const channel = typeof req.body?.channel === 'string' && req.body.channel ? req.body.channel : 'all';
  try {
    const clip = await renderClip(ws, { momentId, utteranceIds, format, channel });
    res.json(clip);
  } catch (e) {
    if (e instanceof ClipError) return void res.status(422).json({ error: e.message, code: e.code, detail: e.detail });
    throw e;
  }
}));

app.get('/api/:ws/clips', wrap((req, res) => {
  if (!clipGate(res)) return;
  res.json(listRenderedClips(param(req, 'ws')));
}));

app.get('/api/:ws/clips/:id/file', wrap((req, res) => {
  if (!clipGate(res)) return;
  const ws = param(req, 'ws');
  const clip = getRenderedClip(ws, param(req, 'id')); // workspace-scoped: no cross-tenant file access
  if (!clip) return void res.status(404).json({ error: 'clip not found' });
  const abs = clipFileAbsPath(clip);
  if (!abs) return void res.status(410).json({ error: 'clip file no longer on disk' });
  res.setHeader('Content-Type', clip.mime);
  res.sendFile(abs);
}));

app.delete('/api/:ws/clips/:id', wrap((req, res) => {
  if (!clipGate(res)) return;
  const ws = param(req, 'ws');
  const clip = getRenderedClip(ws, param(req, 'id'));
  if (clip) {
    const abs = clipFileAbsPath(clip);
    if (abs) try { fs.unlinkSync(abs); } catch { /* file already gone */ }
    deleteRenderedClip(ws, param(req, 'id'));
  }
  res.json({ ok: true });
}));

// ---------- fusion videos (EXPERIMENTAL ngram-style generator; behind NF_FLAG_FUSION_VIDEO) ----------

const fusionGate = (res: import('express').Response): boolean => {
  if (!config.flags.fusionVideo) {
    res.status(404).json({ error: 'fusion video is disabled (flag NF_FLAG_FUSION_VIDEO off)' });
    return false;
  }
  return true;
};

app.get('/api/:ws/fusion', wrap((req, res) => {
  if (!fusionGate(res)) return;
  res.json(listFusionVideos(param(req, 'ws')));
}));

app.post('/api/:ws/fusion/render', wrap(async (req, res) => {
  if (!fusionGate(res)) return;
  const ws = param(req, 'ws');
  const talkId = typeof req.body?.talkId === 'string' && req.body.talkId ? req.body.talkId : undefined;
  const momentId = typeof req.body?.momentId === 'string' && req.body.momentId ? req.body.momentId : undefined;
  const sourceId = typeof req.body?.sourceId === 'string' && req.body.sourceId ? req.body.sourceId : undefined;
  const voice = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].includes(req.body?.voice) ? req.body.voice : undefined;
  const format = ['16:9', '9:16', '1:1'].includes(req.body?.format) ? req.body.format : undefined;
  try {
    const video = await renderFusionVideo(ws, { talkId, momentId, sourceId, voice, format });
    res.json(video);
  } catch (e) {
    if (e instanceof FusionError) return void res.status(422).json({ error: e.message, code: e.code });
    throw e;
  }
}));

app.get('/api/:ws/fusion/:id/file', wrap((req, res) => {
  if (!fusionGate(res)) return;
  const ws = param(req, 'ws');
  const v = getFusionVideo(ws, param(req, 'id')); // workspace-scoped
  if (!v) return void res.status(404).json({ error: 'fusion video not found' });
  const abs = fusionFileAbsPath(v);
  if (!abs) return void res.status(410).json({ error: 'fusion video file no longer on disk' });
  res.setHeader('Content-Type', v.mime);
  res.sendFile(abs);
}));

app.delete('/api/:ws/fusion/:id', wrap((req, res) => {
  if (!fusionGate(res)) return;
  const ws = param(req, 'ws');
  const v = getFusionVideo(ws, param(req, 'id'));
  if (v) {
    const abs = fusionFileAbsPath(v);
    if (abs) try { fs.unlinkSync(abs); } catch { /* file already gone */ }
    deleteFusionVideo(ws, param(req, 'id'));
  }
  res.json({ ok: true });
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

// Company footprint sweep: public-web presence (site/blog/interviews/press) → voice corpus.
app.post('/api/:ws/footprint', wrap(async (req, res) => {
  if (!config.flags.sourceDiscovery) return void res.status(404).json({ error: 'source discovery is disabled (flag NF_FLAG_SOURCE_DISCOVERY off)' });
  const company = req.body?.company;
  if (typeof company !== 'string' || company.trim().length < 2) throw new Error('company name is required (min 2 chars)');
  const domain = typeof req.body?.domain === 'string' && req.body.domain.trim() ? req.body.domain.trim() : undefined;
  const years = Number.isFinite(req.body?.years) ? Math.max(1, Math.min(15, req.body.years)) : 5;
  res.json(await sweepFootprint(param(req, 'ws'), company.trim(), { domain, years }));
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

// Bulk-delete sources (multi-select in Corpus). Each cascades like the single delete.
app.post('/api/:ws/sources/delete', wrap((req, res) => {
  const ws = param(req, 'ws');
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x: unknown): x is string => typeof x === 'string') : [];
  if (ids.length === 0) throw new Error('ids[] is required');
  let deletedMoments = 0;
  for (const id of ids) deletedMoments += deleteSource(ws, id).deletedMoments;
  res.json({ deleted: ids.length, deletedMoments });
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
