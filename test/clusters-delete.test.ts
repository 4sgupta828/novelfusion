import { describe, expect, it, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `nf-clusters-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
process.env.NF_DB_PATH = DB;

type DBMod = typeof import('../src/db/index.js');
let db: DBMod;

const principle = (id: string, ws: string, text: string, status = 'active') => ({
  id, workspaceId: ws, text, tier: 'L3_taste' as const,
  scope: { channel: null, person: null, topic: null, audience: null },
  status: status as 'active', evidenceEditIds: [], counterexamples: [], version: 1,
  fireCount: 0, overrideCount: 0, clusterId: null, createdAt: new Date(0).toISOString(),
});

beforeAll(async () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) try { fs.unlinkSync(f); } catch { /* ignore */ }
  db = await import('../src/db/index.js');
  db.ensureWorkspace('wsA');
  db.ensureWorkspace('wsB');
  db.insertPrinciple(principle('pA1', 'wsA', 'Cut throat-clearing openers.'));
  db.insertPrinciple(principle('pA2', 'wsA', 'No emoji in exec posts.'));
  db.insertPrinciple(principle('pB1', 'wsB', 'Other workspace principle.'));
});

describe('cluster CRUD + escape hatch', () => {
  it('creates, assigns, and computes disabled ids workspace-scoped', () => {
    const c = db.createCluster('wsA', 'Tone & voice', 'how it sounds');
    db.assignPrincipleCluster('wsA', 'pA1', c.id);
    db.assignPrincipleCluster('wsA', 'pA2', c.id);
    expect(db.clusterMemberCounts('wsA').get(c.id)).toBe(2);
    // enabled by default → not in disabled set
    expect(db.disabledClusterIds('wsA').has(c.id)).toBe(false);
    // toggle off = escape hatch engaged
    db.updateCluster('wsA', c.id, { enabled: false });
    expect(db.disabledClusterIds('wsA').has(c.id)).toBe(true);
    // toggling does NOT change principle status
    expect(db.getPrinciple('wsA', 'pA1')!.status).toBe('active');
    expect(db.getPrinciple('wsA', 'pA1')!.clusterId).toBe(c.id);
  });

  it('is workspace-isolated: wsB cannot see or assign into wsA clusters', () => {
    const cA = db.listClusters('wsA')[0]!;
    expect(db.listClusters('wsB').find((c) => c.id === cA.id)).toBeUndefined();
    expect(() => db.assignPrincipleCluster('wsB', 'pB1', cA.id)).toThrow(/not found/);
  });

  it('delete unassigns its principles (they are not deleted)', () => {
    const c = db.createCluster('wsA', 'Temp');
    db.assignPrincipleCluster('wsA', 'pA2', c.id);
    db.deleteCluster('wsA', c.id);
    expect(db.getCluster('wsA', c.id)).toBeNull();
    expect(db.getPrinciple('wsA', 'pA2')!.clusterId).toBeNull();
    expect(db.getPrinciple('wsA', 'pA2')!.status).toBe('active'); // principle survives
  });
});

describe('deleteSource cascade', () => {
  it('removes passages, embeddings, FTS, blob, and stale slated moments — workspace-scoped', () => {
    db.insertSource({ id: 'src1', workspaceId: 'wsA', kind: 'document', uri: 'x', title: 'Doc', recordedAt: null, consentBasis: 'uploaded_owner', admitted: true });
    db.insertUtterances([
      { id: 'u1', sourceId: 'src1', workspaceId: 'wsA', speaker: null, tStartSec: null, tEndSec: null, text: 'Deploy time dropped to 12 minutes after the rework.', seq: 0, locator: { kind: 'document' }, provenanceClass: 'owned_document' },
      { id: 'u2', sourceId: 'src1', workspaceId: 'wsA', speaker: null, tStartSec: null, tEndSec: null, text: 'Retention held at 118 percent this quarter.', seq: 1, locator: { kind: 'document' }, provenanceClass: 'owned_document' },
    ]);
    db.ftsUpsertPassages([{ id: 'u1', workspaceId: 'wsA', text: 'Deploy time dropped to 12 minutes after the rework.' }]);
    db.upsertEmbedding({ utteranceId: 'u1', workspaceId: 'wsA', model: 'm', dim: 2, vec: Float32Array.from([1, 2]) });
    db.insertSourceBlob({ sourceId: 'src1', workspaceId: 'wsA', filename: 'd.pdf', mime: 'application/pdf', size: 3, bytes: Buffer.from('pdf') });
    db.insertMoment({ id: 'mom1', workspaceId: 'wsA', utteranceIds: ['u1'], claim: 'x', judgment: { novelty: 0.5, credibility: 0.5, riskFlags: [], whyNow: '' }, score: 0.5, state: 'slated', rejectionChip: null });

    const r = db.deleteSource('wsA', 'src1');
    expect(r.deletedMoments).toBe(1);
    expect(db.listUtterances('wsA', 'src1').length).toBe(0);
    expect(db.getSourceBlob('wsA', 'src1')).toBeNull();
    expect(db.loadEmbeddings('wsA', 'm', 2).length).toBe(0);
    expect(db.ftsSearch('wsA', 'deploy', 10).length).toBe(0);
    expect(db.getMoment('wsA', 'mom1')).toBeNull();
    expect(db.listSources('wsA').find((s) => s.id === 'src1')).toBeUndefined();
  });

  it('does not touch another workspace on a colliding source id', () => {
    db.insertSource({ id: 'shared', workspaceId: 'wsB', kind: 'document', uri: 'x', title: 'B', recordedAt: null, consentBasis: 'uploaded_owner', admitted: true });
    db.insertUtterances([{ id: 'ub', sourceId: 'shared', workspaceId: 'wsB', speaker: null, tStartSec: null, tEndSec: null, text: 'B content here.', seq: 0, locator: { kind: 'document' }, provenanceClass: 'owned_document' }]);
    db.deleteSource('wsA', 'shared'); // wrong workspace — must be a no-op for wsB's data
    expect(db.listUtterances('wsB', 'shared').length).toBe(1);
  });
});
