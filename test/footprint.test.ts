import { describe, expect, it, beforeAll, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `nf-footprint-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
process.env.NF_DB_PATH = DB;

const exaSearch = vi.fn();
vi.mock('../src/llm/exa.js', () => ({ exaSearch: (...a: unknown[]) => exaSearch(...a) }));

type DBMod = typeof import('../src/db/index.js');
type FP = typeof import('../src/pipeline/footprint.js');
let db: DBMod;
let fp: FP;

beforeAll(async () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) try { fs.unlinkSync(f); } catch { /* ignore */ }
  db = await import('../src/db/index.js');
  fp = await import('../src/pipeline/footprint.js');
  db.ensureWorkspace('w');
});

describe('company footprint sweep', () => {
  it('ingests results ADMITTED + VOICE-tagged, deduped, with a 5y date window pushed to Exa', async () => {
    exaSearch.mockResolvedValue([
      { url: 'https://acme.com/blog/a', title: 'A', text: 'Acme believes in boring, reliable infrastructure over hype.' },
      { url: 'https://acme.com/blog/a', title: 'dup', text: 'duplicate url skipped' },
      { url: 'https://podcast.fm/acme-ceo', title: 'CEO interview', text: 'Our CEO on why discovery beats pitching in enterprise sales.' },
    ]);
    const r = await fp.sweepFootprint('w', 'Acme', { domain: 'https://www.acme.com/', years: 5 });

    // dedup within results (a appears twice)
    expect(r.created.length).toBe(2);
    expect(r.company).toBe('Acme');
    // every footprint source is admitted AND in the voice corpus
    const sources = db.listSources('w').filter((s) => r.created.some((c) => c.id === s.id));
    expect(sources.every((s) => s.admitted === true)).toBe(true);
    expect(sources.every((s) => s.isVoice === true)).toBe(true);
    // they show up in the voice corpus the persona distills from
    expect(db.listVoiceUtterances('w').length).toBeGreaterThan(0);

    // the domain-scoped query pushed includeDomains + a startPublishedDate to Exa
    const domainCall = exaSearch.mock.calls.find((c) => (c[1] as any)?.includeDomains);
    expect(domainCall).toBeTruthy();
    expect((domainCall![1] as any).includeDomains).toEqual(['acme.com']);
    expect((domainCall![1] as any).startPublishedDate).toBeTruthy();
    // ~5 years back
    expect(new Date((domainCall![1] as any).startPublishedDate).getFullYear()).toBe(new Date().getFullYear() - 5);
  });

  it('skips the domain-scoped query when no domain is given', async () => {
    exaSearch.mockClear();
    exaSearch.mockResolvedValue([]);
    const r = await fp.sweepFootprint('w', 'NoDomainCo', {});
    expect(exaSearch.mock.calls.every((c) => !(c[1] as any)?.includeDomains)).toBe(true);
    expect(r.queries.length).toBe(3); // the 3 non-domain queries only
  });

  it('dedups against the workspace\'s existing source URIs', async () => {
    exaSearch.mockClear();
    exaSearch.mockResolvedValue([
      { url: 'https://acme.com/blog/a', title: 'A again', text: 'already ingested above' },
      { url: 'https://acme.com/blog/new', title: 'New', text: 'A brand new footprint page about our latest launch.' },
    ]);
    const r = await fp.sweepFootprint('w', 'Acme', { domain: 'acme.com' });
    expect(r.created.length).toBe(1);
    expect(r.created[0]!.url).toContain('/blog/new');
  });
});
