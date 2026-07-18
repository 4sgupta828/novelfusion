import { describe, expect, it, beforeAll, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `nf-ideas-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
process.env.NF_DB_PATH = DB;
// corpusQuery flag off (default) → brainstorm uses a diverse sample, no OpenAI/retrieval call.

const structured = vi.fn();
vi.mock('../src/llm/client.js', () => ({ structured: (...a: unknown[]) => structured(...a), generate: vi.fn() }));

type DBMod = typeof import('../src/db/index.js');
type Ideas = typeof import('../src/pipeline/ideas.js');
let db: DBMod;
let ideas: Ideas;

const utt = (ws: string, sid: string, uid: string, text: string, seq: number) => ({
  id: uid, sourceId: sid, workspaceId: ws, speaker: null, tStartSec: null, tEndSec: null,
  text, seq, locator: { kind: 'document' as const }, provenanceClass: 'owned_document' as const,
});

beforeAll(async () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) try { fs.unlinkSync(f); } catch { /* ignore */ }
  db = await import('../src/db/index.js');
  ideas = await import('../src/pipeline/ideas.js');
  db.ensureWorkspace('w');
  db.insertSource({ id: 's1', workspaceId: 'w', kind: 'webpage', uri: 'blog', title: 'Blog', recordedAt: null, consentBasis: 'public', admitted: true });
  db.insertSource({ id: 's2', workspaceId: 'w', kind: 'upload', uri: 'call', title: 'Call', recordedAt: null, consentBasis: 'recorded_consent', admitted: true });
  db.insertUtterances([
    utt('w', 's1', 'a1', 'Governance is a moat, not a tax — the constitution compounds over time.', 0),
    utt('w', 's1', 'a2', 'Provenance turns every claim into something you can defend under scrutiny.', 1),
    utt('w', 's2', 'b1', 'Speed without memory means re-litigating the same edit forever.', 0),
    utt('w', 's2', 'b2', 'The best editors encode taste; they do not just apply it once.', 1),
  ]);
});

describe('generateIdeaClusters (grounding + grouping)', () => {
  it('drops fabricated utterance ids, persists open ideas grouped under their cluster', async () => {
    structured.mockResolvedValueOnce({
      clusters: [
        {
          title: 'Memory as moat',
          thesis: 'Governance + provenance combine into a compounding advantage.',
          ideas: [
            { text: 'Your edits are an appreciating asset.', rationale: 'taste compounds', novelty: 0.8, utteranceIds: ['a1', 'GHOST'] },
            { text: 'Defensibility is a feature you ship.', rationale: 'provenance', novelty: 0.7, utteranceIds: ['a2'] },
          ],
        },
        {
          // an idea with ONLY a fabricated id must be dropped entirely (fail-safe)
          title: 'Phantom',
          thesis: 'nothing real',
          ideas: [{ text: 'ungrounded', rationale: '', novelty: 0.9, utteranceIds: ['NOPE'] }],
        },
      ],
    });
    const created = await ideas.generateIdeaClusters('w');
    expect(created).toHaveLength(2); // the ungrounded idea is dropped
    const first = created.find((i) => i.text.startsWith('Your edits'))!;
    expect(first.sourceUtteranceIds).toEqual(['a1']); // GHOST removed
    expect(first.origin).toBe('cluster');
    expect(first.clusterTitle).toBe('Memory as moat');
    expect(first.status).toBe('open');

    const open = db.listIdeas('w', 'open');
    expect(open).toHaveLength(2);
    expect(open.every((i) => i.clusterTitle === 'Memory as moat')).toBe(true);
  });

  it('refuses to cluster with an empty corpus', async () => {
    db.ensureWorkspace('empty');
    await expect(ideas.generateIdeaClusters('empty')).rejects.toThrow(/corpus/i);
  });
});

describe('brainstormIdeas (expert lens + grounding)', () => {
  it('generates grounded ideas through a collaborator lens', async () => {
    const expert = db.createCollaborator('w', 'Dana Lee', 'category design');
    structured.mockResolvedValueOnce({
      ideas: [
        { text: 'Name the category before a competitor does.', rationale: 'category design', novelty: 0.75, utteranceIds: ['b1'] },
        { text: 'ungrounded filler', rationale: '', novelty: 0.6, utteranceIds: ['XX'] }, // dropped
      ],
    });
    const created = await ideas.brainstormIdeas('w', { prompt: 'angles on category leadership', authorId: expert.id });
    expect(created).toHaveLength(1);
    expect(created[0]!.origin).toBe('brainstorm');
    expect(created[0]!.authorId).toBe(expert.id);
    expect(created[0]!.sourceUtteranceIds).toEqual(['b1']);
    // the LLM was told to use the expert lens
    const userArg = (structured.mock.calls.at(-1)![0] as { user: string }).user;
    expect(userArg).toContain('Dana Lee');
  });

  it('requires a prompt', async () => {
    await expect(ideas.brainstormIdeas('w', { prompt: '   ' })).rejects.toThrow(/prompt/i);
  });
});

describe('promoteIdeaToMoment (the only path into the governed pipeline)', () => {
  it('promotes an open idea to a slated moment carrying its receipts, marks it promoted', async () => {
    const [idea] = db.listIdeas('w', 'open');
    const moment = ideas.promoteIdeaToMoment('w', idea.id);
    expect(moment.state).toBe('slated');
    expect(moment.claim).toBe(idea.text);
    expect(moment.utteranceIds).toEqual(idea.sourceUtteranceIds);
    expect(moment.judgment.novelty).toBe(idea.novelty);

    const after = db.getIdea('w', idea.id)!;
    expect(after.status).toBe('promoted');
    expect(after.promotedMomentId).toBe(moment.id);
    // it now shows on the slate
    expect(db.listMoments('w', 'slated').some((m) => m.id === moment.id)).toBe(true);
  });

  it('refuses to promote an already-promoted idea', async () => {
    const promoted = db.listIdeas('w').find((i) => i.status === 'promoted')!;
    expect(() => ideas.promoteIdeaToMoment('w', promoted.id)).toThrow(/already/i);
  });

  it('dismiss + delete work through the status lifecycle', () => {
    const open = db.listIdeas('w', 'open');
    const target = open[0]!;
    db.updateIdeaStatus('w', target.id, 'dismissed');
    expect(db.getIdea('w', target.id)!.status).toBe('dismissed');
    db.deleteIdea('w', target.id);
    expect(db.getIdea('w', target.id)).toBeNull();
  });
});

describe('listSlate — promoted moments pin above the ranked cutoff (never lost)', () => {
  it('surfaces a low-scored promoted moment ABOVE the top-N auto-mined moments', () => {
    db.ensureWorkspace('slate');
    db.insertSource({ id: 'ss', workspaceId: 'slate', kind: 'upload', uri: 'u', title: 'S', recordedAt: null, consentBasis: 'recorded_consent', admitted: true });
    db.insertUtterances([utt('slate', 'ss', 'z1', 'a grounded utterance for the promoted idea', 0)]);
    // Fill the slate with high-scored auto-mined moments (more than the top-N budget).
    for (let i = 0; i < 6; i++) {
      db.insertMoment({
        id: `hi_${i}`, workspaceId: 'slate', utteranceIds: ['z1'], claim: `high ${i}`,
        judgment: { novelty: 0.95, credibility: 0.95, riskFlags: [], whyNow: '' }, score: 0.95, state: 'slated', rejectionChip: null,
      });
    }
    // A promoted idea → a LOW-scored moment (neutral credibility prior) that would sink below top-5.
    const idea = db.insertIdea({
      workspaceId: 'slate', text: 'a promoted low-novelty idea', rationale: 'r', novelty: 0.2,
      sourceUtteranceIds: ['z1'], origin: 'brainstorm', clusterTitle: null, clusterThesis: null, authorId: null,
    });
    const promoted = ideas.promoteIdeaToMoment('slate', idea.id);
    expect(promoted.score).toBeLessThan(0.5); // would never make the top-5 on merit

    const slate = db.listSlate('slate', 5);
    // pinned FIRST despite the lowest score, and flagged
    expect(slate[0]!.id).toBe(promoted.id);
    expect(slate[0]!.promoted).toBe(true);
    // the ranked auto-mined moments still appear (top 5), none flagged promoted
    expect(slate.filter((m) => !m.promoted)).toHaveLength(5);
    expect(slate.filter((m) => !m.promoted).every((m) => m.score === 0.95)).toBe(true);
    // a promoted moment is never double-counted
    expect(slate.filter((m) => m.id === promoted.id)).toHaveLength(1);
  });
});
