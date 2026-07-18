import { describe, expect, it, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `nf-collab-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
process.env.NF_DB_PATH = DB;

type DBMod = typeof import('../src/db/index.js');
type Edits = typeof import('../src/pipeline/edits.js');
let db: DBMod;
let edits: Edits;

beforeAll(async () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) try { fs.unlinkSync(f); } catch { /* ignore */ }
  db = await import('../src/db/index.js');
  edits = await import('../src/pipeline/edits.js');
  db.ensureWorkspace('wsA');
  db.ensureWorkspace('wsB');
  db.insertMoment({ id: 'm1', workspaceId: 'wsA', utteranceIds: [], claim: 'c', judgment: { novelty: 0.5, credibility: 0.5, riskFlags: [], whyNow: '' }, score: 0.5, state: 'woven', rejectionChip: null });
  db.insertDraft({ id: 'd1', workspaceId: 'wsA', momentId: 'm1', format: 'li_post', angle: 'default', template: 'freeform', content: 'The original draft content here.', sections: [], viz: [], infographic: null, provenance: [], constitutionVersion: 0, holdout: false, state: 'draft', createdAt: new Date(0).toISOString() });
});

describe('collaborators + attributed versions', () => {
  it('creates collaborators, workspace-scoped', () => {
    const c = db.createCollaborator('wsA', 'Priya Rao', 'Regulatory strategy');
    expect(db.listCollaborators('wsA').map((x) => x.name)).toContain('Priya Rao');
    expect(db.listCollaborators('wsB')).toEqual([]); // isolated
    expect(db.getCollaborator('wsB', c.id)).toBeNull();
  });

  it('attributes a captured version to a collaborator', () => {
    const c = db.listCollaborators('wsA')[0]!;
    const e = edits.captureEditContent('wsA', 'd1', 'A revised draft with Priya\'s edits.', 'off-voice', c.id);
    expect(e.authorId).toBe(c.id);
    const stored = db.listEdits('wsA').find((x) => x.id === e.id)!;
    expect(stored.authorId).toBe(c.id); // persisted
  });

  it('a house edit (no author) records null', () => {
    const e = edits.captureEditContent('wsA', 'd1', 'A different house revision of the draft.', 'style', null);
    expect(e.authorId).toBeNull();
  });

  it('deleting a collaborator keeps their versions but detaches authorship (never destroys history)', () => {
    const c = db.listCollaborators('wsA')[0]!;
    const before = db.listEdits('wsA').filter((e) => e.authorId === c.id).length;
    expect(before).toBeGreaterThan(0);
    db.deleteCollaborator('wsA', c.id);
    expect(db.getCollaborator('wsA', c.id)).toBeNull();
    expect(db.listEdits('wsA').filter((e) => e.authorId === c.id).length).toBe(0); // detached
    // the edit rows themselves survive (author_id → null)
    expect(db.listEdits('wsA').length).toBeGreaterThanOrEqual(2);
  });
});
