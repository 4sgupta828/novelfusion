import { describe, expect, it, beforeAll, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `nf-advisor-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
process.env.NF_DB_PATH = DB;

const structured = vi.fn();
vi.mock('../src/llm/client.js', () => ({ structured: (...a: unknown[]) => structured(...a) }));

type DBMod = typeof import('../src/db/index.js');
type Adv = typeof import('../src/pipeline/template-advisor.js');
let db: DBMod;
let adv: Adv;

const utt = (id: string, transcript: boolean) => ({
  id, sourceId: transcript ? 'sT' : 'sD', workspaceId: 'w', speaker: transcript ? 'Alex' : null,
  tStartSec: transcript ? 0 : null, tEndSec: null, text: `passage ${id}`, seq: 0,
  locator: transcript ? { kind: 'transcript' as const } : { kind: 'document' as const },
  provenanceClass: transcript ? ('human_utterance' as const) : ('owned_document' as const),
});

beforeAll(async () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) try { fs.unlinkSync(f); } catch { /* ignore */ }
  db = await import('../src/db/index.js');
  adv = await import('../src/pipeline/template-advisor.js');
  db.ensureWorkspace('w');
  db.insertSource({ id: 'sT', workspaceId: 'w', kind: 'upload', uri: 'x', title: 'T', recordedAt: null, consentBasis: 'recorded_consent', admitted: true });
  db.insertSource({ id: 'sD', workspaceId: 'w', kind: 'document', uri: 'x', title: 'D', recordedAt: null, consentBasis: 'uploaded_owner', admitted: true });
  db.insertUtterances([utt('uT', true), utt('uD', false)]);
  const mk = (id: string, uids: string[]) => db.insertMoment({ id, workspaceId: 'w', utteranceIds: uids, claim: 'c', judgment: { novelty: 0.5, credibility: 0.5, riskFlags: [], whyNow: 'now' }, score: 0.5, state: 'slated', rejectionChip: null });
  mk('mT', ['uT']); // all transcript
  mk('mD', ['uD']); // has a non-transcript passage
});

describe('suggestTemplate — code-owned validation (Rule 18 allowlist)', () => {
  it('passes through a valid recommendation', async () => {
    structured.mockResolvedValueOnce({ template: 'data_drop', format: 'li_post', reasoning: 'lead with the number' });
    const s = await adv.suggestTemplate('w', 'mT');
    expect(s).toMatchObject({ template: 'data_drop', format: 'li_post' });
  });

  it('falls back to freeform/li_post when the model returns off-list ids', async () => {
    structured.mockResolvedValueOnce({ template: 'listicle', format: 'tweetstorm', reasoning: 'x' });
    const s = await adv.suggestTemplate('w', 'mT');
    expect(s.template).toBe('freeform');
    expect(s.format).toBe('li_post');
  });

  it('forbids clip_spec when the moment is not all transcript-grounded (enforced in code)', async () => {
    structured.mockResolvedValueOnce({ template: 'freeform', format: 'clip_spec', reasoning: 'x' });
    const s = await adv.suggestTemplate('w', 'mD'); // has a document passage
    expect(s.format).toBe('li_post'); // downgraded — clip_spec needs video timing
  });

  it('allows clip_spec when every passage is transcript', async () => {
    structured.mockResolvedValueOnce({ template: 'freeform', format: 'clip_spec', reasoning: 'x' });
    const s = await adv.suggestTemplate('w', 'mT');
    expect(s.format).toBe('clip_spec');
  });
});
