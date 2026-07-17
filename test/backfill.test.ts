import { describe, expect, it, beforeAll, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `nf-backfill-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
process.env.NF_DB_PATH = DB;
process.env.NF_FLAG_CORPUS_QUERY = 'true'; // worker is active only when retrieval is on
process.env.OPENAI_API_KEY = 'test-key';   // ...and a key is present

// Mock the OpenAI embedding call; keep the real EMBED_MODEL/EMBED_DIM constants.
const embedTexts = vi.fn(async (texts: string[]) => texts.map(() => Float32Array.from([0.1, 0.2, 0.3])));
vi.mock('../src/llm/embed.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, embedTexts: (...a: unknown[]) => embedTexts(...(a as [string[]])) };
});

type DBMod = typeof import('../src/db/index.js');
type Worker = typeof import('../src/pipeline/backfill.js');
let db: DBMod;
let worker: Worker;

beforeAll(async () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) try { fs.unlinkSync(f); } catch { /* ignore */ }
  db = await import('../src/db/index.js');
  worker = await import('../src/pipeline/backfill.js');
  db.ensureWorkspace('w');
  db.insertSource({ id: 's1', workspaceId: 'w', kind: 'webpage', uri: 'https://x/a', title: 'A', recordedAt: null, consentBasis: 'public', admitted: true });
  db.insertUtterances([
    { id: 'u1', sourceId: 's1', workspaceId: 'w', speaker: null, tStartSec: null, tEndSec: null, text: 'First admitted passage about rate cases.', seq: 0, locator: { kind: 'webpage', url: 'https://x/a', fetchedAt: '2020-01-01' }, provenanceClass: 'public_web' },
    { id: 'u2', sourceId: 's1', workspaceId: 'w', speaker: null, tStartSec: null, tEndSec: null, text: 'Second admitted passage about settlements.', seq: 1, locator: { kind: 'webpage', url: 'https://x/a', fetchedAt: '2020-01-01' }, provenanceClass: 'public_web' },
  ]);
  // A quarantined source that must NOT be embedded by the worker.
  db.insertSource({ id: 's2', workspaceId: 'w', kind: 'webpage', uri: 'https://x/b', title: 'B', recordedAt: null, consentBasis: 'public', admitted: false });
  db.insertUtterances([
    { id: 'q1', sourceId: 's2', workspaceId: 'w', speaker: null, tStartSec: null, tEndSec: null, text: 'Quarantined passage, not yet admitted.', seq: 0, locator: { kind: 'webpage', url: 'https://x/b', fetchedAt: '2020-01-01' }, provenanceClass: 'public_web' },
  ]);
});

describe('background backfill worker', () => {
  it('eagerly embeds + FTS-indexes admitted passages, skipping quarantined ones', async () => {
    const { EMBED_MODEL } = await import('../src/llm/embed.js');
    expect(db.listUnembeddedUtterances('w', EMBED_MODEL).map((u) => u.id).sort()).toEqual(['u1', 'u2']);

    await worker.processWorkspace('w');

    // admitted passages embedded; quarantined one left alone
    expect(db.listUnembeddedUtterances('w', EMBED_MODEL).length).toBe(0);
    expect(db.loadEmbeddings('w', EMBED_MODEL, 1536).map((r) => r.id).sort()).toEqual(['u1', 'u2']);
    // FTS covers the admitted passages, not the quarantined one
    expect(db.ftsSearch('w', 'settlements', 10)).toContain('u2');
    expect(db.ftsSearch('w', 'quarantined', 10)).not.toContain('q1');
  });

  it('the per-workspace in-flight lock prevents concurrent double-embedding', async () => {
    // re-arm: mark a fresh admitted passage as pending
    db.insertUtterances([{ id: 'u3', sourceId: 's1', workspaceId: 'w', speaker: null, tStartSec: null, tEndSec: null, text: 'Third admitted passage on riders.', seq: 2, locator: { kind: 'webpage', url: 'https://x/a', fetchedAt: '2020-01-01' }, provenanceClass: 'public_web' }]);
    embedTexts.mockClear();
    // two concurrent runs — the lock must let only one do the embedding work
    await Promise.all([worker.processWorkspace('w'), worker.processWorkspace('w')]);
    expect(embedTexts).toHaveBeenCalledTimes(1);
    const { EMBED_MODEL } = await import('../src/llm/embed.js');
    expect(db.listUnembeddedUtterances('w', EMBED_MODEL).length).toBe(0);
  });
});
