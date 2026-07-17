import { describe, expect, it, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Set a fresh temp DB BEFORE importing the db module (config reads NF_DB_PATH at load).
const DB = path.join(os.tmpdir(), `nf-retrieval-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
process.env.NF_DB_PATH = DB;

type DBMod = typeof import('../src/db/index.js');
let db: DBMod;

const mkUtt = (ws: string, sid: string, uid: string, text: string, seq: number) => ({
  id: uid, sourceId: sid, workspaceId: ws, speaker: null, tStartSec: null, tEndSec: null,
  text, seq, locator: { kind: 'document' as const }, provenanceClass: 'owned_document' as const,
});

beforeAll(async () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) try { fs.unlinkSync(f); } catch { /* ignore */ }
  db = await import('../src/db/index.js');
  db.ensureWorkspace('wsA');
  db.ensureWorkspace('wsB');
  db.insertSource({ id: 'sA', workspaceId: 'wsA', kind: 'document', uri: 'x', title: 'A', recordedAt: null, consentBasis: 'uploaded_owner', admitted: true });
  db.insertSource({ id: 'sB', workspaceId: 'wsB', kind: 'document', uri: 'x', title: 'B', recordedAt: null, consentBasis: 'uploaded_owner', admitted: true });
  db.insertSource({ id: 'sQ', workspaceId: 'wsA', kind: 'document', uri: 'x', title: 'Q', recordedAt: null, consentBasis: 'uploaded_owner', admitted: false });
  db.insertUtterances([
    mkUtt('wsA', 'sA', 'uA1', 'Net revenue retention held at 118 percent this quarter.', 0),
    mkUtt('wsA', 'sA', 'uA2', 'Win rate against incumbents climbed to 47 percent.', 1),
    // byte-identical text planted in workspace B — the cross-tenant trap
    mkUtt('wsB', 'sB', 'uB1', 'Net revenue retention held at 118 percent this quarter.', 0),
    mkUtt('wsA', 'sQ', 'uQ1', 'Quarantined secret about retention margins.', 0),
  ]);
  db.ftsUpsertPassages([
    { id: 'uA1', workspaceId: 'wsA', text: 'Net revenue retention held at 118 percent this quarter.' },
    { id: 'uA2', workspaceId: 'wsA', text: 'Win rate against incumbents climbed to 47 percent.' },
    { id: 'uB1', workspaceId: 'wsB', text: 'Net revenue retention held at 118 percent this quarter.' },
    { id: 'uQ1', workspaceId: 'wsA', text: 'Quarantined secret about retention margins.' },
  ]);
});

describe('workspace isolation (sev-1)', () => {
  it('FTS never returns another workspace passage, even with identical text', () => {
    expect(db.ftsSearch('wsA', 'retention', 10)).toEqual(['uA1']); // NOT uB1
    expect(db.ftsSearch('wsB', 'retention', 10)).toEqual(['uB1']);
  });
  it('the hydration choke-point drops foreign and unknown ids, preserving caller order', () => {
    const out = db.getUtterancesByIdsOrdered('wsA', ['uA2', 'uA1', 'uB1', 'ghost']).map((u) => u.id);
    expect(out).toEqual(['uA2', 'uA1']); // uB1 (wsB) + ghost dropped; order preserved
  });
  it('a wsB caller cannot hydrate a wsA passage', () => {
    expect(db.getUtterancesByIdsOrdered('wsB', ['uA1']).length).toBe(0);
  });
  it('embeddings load is workspace + model + dim scoped', () => {
    db.upsertEmbedding({ utteranceId: 'uA1', workspaceId: 'wsA', model: 'm', dim: 3, vec: Float32Array.from([1, 2, 3]) });
    db.upsertEmbedding({ utteranceId: 'uB1', workspaceId: 'wsB', model: 'm', dim: 3, vec: Float32Array.from([4, 5, 6]) });
    expect(db.loadEmbeddings('wsA', 'm', 3).map((r) => r.id)).toEqual(['uA1']);
    expect(db.loadEmbeddings('wsA', 'm', 99)).toEqual([]); // wrong dim → empty (no cross-space)
  });
});

describe('consent / quarantine gating', () => {
  it('FTS excludes passages from an unadmitted source', () => {
    // "retention" also appears in the quarantined uQ1, but it must never surface
    expect(db.ftsSearch('wsA', 'retention', 10)).not.toContain('uQ1');
  });
  it('unembedded list excludes quarantined passages', () => {
    expect(db.listUnembeddedUtterances('wsA', 'm').map((r) => r.id)).not.toContain('uQ1');
  });
});

describe('source blob retention', () => {
  it('round-trips bytes and is workspace-scoped', () => {
    const bytes = Buffer.from('PDFDATA\x00\x01binary');
    db.insertSourceBlob({ sourceId: 'sA', workspaceId: 'wsA', filename: 'a.pdf', mime: 'application/pdf', size: bytes.length, bytes });
    const got = db.getSourceBlob('wsA', 'sA');
    expect(got?.bytes.equals(bytes)).toBe(true);
    expect(got?.filename).toBe('a.pdf');
    expect(db.getSourceBlob('wsB', 'sA')).toBeNull(); // wrong workspace → nothing
  });
});
