import { describe, expect, it, beforeAll, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `nf-discover-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
process.env.NF_DB_PATH = DB;

// Mock the external surfaces so the governance + dedup logic is testable offline.
const exaSearch = vi.fn();
const structured = vi.fn();
vi.mock('../src/llm/exa.js', () => ({ exaSearch: (...a: unknown[]) => exaSearch(...a) }));
vi.mock('../src/llm/client.js', () => ({ structured: (...a: unknown[]) => structured(...a) }));

type DBMod = typeof import('../src/db/index.js');
type Disc = typeof import('../src/pipeline/discover.js');
let db: DBMod;
let discover: Disc;

beforeAll(async () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) try { fs.unlinkSync(f); } catch { /* ignore */ }
  db = await import('../src/db/index.js');
  discover = await import('../src/pipeline/discover.js');
  db.ensureWorkspace('w');
});

describe('discoverSources — governance + dedup', () => {
  it('ingests results QUARANTINED (admitted=false) as public_web, deduping and skipping non-public URLs', async () => {
    structured.mockResolvedValueOnce({ queries: ['rate case timing'] }); // LLM expansion succeeds
    exaSearch.mockResolvedValueOnce([
      { url: 'https://example.com/a', title: 'A', text: 'A study found the median rate-case timeline is about eleven months across the dataset.' },
      { url: 'https://example.com/a', title: 'A dup', text: 'duplicate url — should be skipped' }, // dup within results
      { url: 'http://169.254.169.254/meta', title: 'SSRF', text: 'metadata endpoint — must be rejected by the guard' },
      { url: 'https://example.com/b', title: 'B', text: 'Settlement rates have risen materially over the past decade for major utilities.' },
    ]);

    const r = await discover.discoverSources('w', 'regulatory lag');
    expect(r.expanded).toBe(true);
    expect(r.created.length).toBe(2); // a and b; dup + SSRF skipped
    expect(r.skipped).toBe(2);

    const sources = db.listSources('w');
    const created = sources.filter((s) => r.created.some((c) => c.id === s.id));
    expect(created.every((s) => s.admitted === false)).toBe(true); // QUARANTINED — the governance guarantee
    expect(created.every((s) => s.kind === 'webpage')).toBe(true);
    expect(created.every((s) => s.consentBasis === 'public')).toBe(true);
    // passages carry public_web provenance
    const passages = db.listUtterances('w', created[0]!.id);
    expect(passages.every((p) => p.provenanceClass === 'public_web')).toBe(true);
  });

  it('dedups against the workspace\'s existing source URIs on a re-run', async () => {
    structured.mockResolvedValueOnce({ queries: ['q'] });
    exaSearch.mockResolvedValueOnce([
      { url: 'https://example.com/a', title: 'A again', text: 'already ingested above' }, // existing
      { url: 'https://example.com/c', title: 'C', text: 'A genuinely new source about grid modernization riders on bills.' },
    ]);
    const r = await discover.discoverSources('w', 'more');
    expect(r.created.length).toBe(1); // only c is new
    expect(r.created[0]!.url).toContain('/c');
  });

  it('degrades gracefully to the raw topic when the LLM is unavailable', async () => {
    structured.mockRejectedValueOnce(new Error('credit balance too low')); // e.g. billing out
    exaSearch.mockResolvedValueOnce([
      { url: 'https://example.com/d', title: 'D', text: 'Fallback path still discovers this source without the LLM.' },
    ]);
    const r = await discover.discoverSources('w', 'my exact topic');
    expect(r.expanded).toBe(false);
    expect(r.queries).toEqual(['my exact topic']); // raw topic used as the query
    expect(r.created.length).toBe(1);
  });
});
