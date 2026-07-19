import { describe, expect, it, beforeAll, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `nf-talks-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
process.env.NF_DB_PATH = DB;

const structured = vi.fn();
vi.mock('../src/llm/client.js', () => ({ structured: (...a: unknown[]) => structured(...a), generate: vi.fn() }));

type DBMod = typeof import('../src/db/index.js');
type Talks = typeof import('../src/pipeline/talks.js');
let db: DBMod;
let talks: Talks;

const utt = (ws: string, sid: string, uid: string, text: string, seq: number) => ({
  id: uid, sourceId: sid, workspaceId: ws, speaker: null, tStartSec: null, tEndSec: null,
  text, seq, locator: { kind: 'document' as const }, provenanceClass: 'owned_document' as const,
});

beforeAll(async () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) try { fs.unlinkSync(f); } catch { /* ignore */ }
  db = await import('../src/db/index.js');
  talks = await import('../src/pipeline/talks.js');
  db.ensureWorkspace('w');
  db.insertSource({ id: 's1', workspaceId: 'w', kind: 'webpage', uri: 'blog', title: 'GTM Playbook Blog', recordedAt: null, consentBasis: 'public', admitted: true });
  db.insertSource({ id: 's2', workspaceId: 'w', kind: 'upload', uri: 'webinar', title: 'Q1 Webinar: Selling to Enterprise', recordedAt: null, consentBasis: 'recorded_consent', admitted: true });
  db.insertUtterances([
    utt('w', 's1', 'a1', 'Regulated verticals invert the risk calculus: buyers need proof, not vision.', 0),
    utt('w', 's1', 'a2', 'Forward-deployed engineers close deals that a demo never could.', 1),
    utt('w', 's2', 'b1', 'Our first enterprise deal closed on founder credibility, not features.', 0),
    utt('w', 's2', 'b2', 'The SOP-writing problem is the hidden killer of AI deployments.', 1),
  ]);
});

describe('proposeTalks (grounded outline + delivered-content awareness)', () => {
  it('drops fabricated ids per segment, drops talks without a grounded arc, persists the rest', async () => {
    structured.mockResolvedValueOnce({
      talks: [
        {
          title: 'Selling AI into Regulated Verticals',
          goal: 'sales_enablement',
          outcome: 'shortens enterprise cycles by pre-answering the proof objection',
          thesis: 'In regulated markets, proof beats vision',
          audience: 'B2B AE teams selling to regulated buyers',
          format: 'webinar',
          outline: [
            { title: 'The risk inversion', summary: 'why regulated buyers need proof', utteranceIds: ['a1', 'GHOST'] },
            { title: 'Forward-deployed selling', summary: 'engineers as closers', utteranceIds: ['a2'] },
          ],
          feasibility: 0.8, novelty: 0.7, rationale: 'timely', buildsOn: ['Q1 Webinar: Selling to Enterprise'],
        },
        {
          // only one grounded segment survives → must be dropped (needs >= 2)
          title: 'Thin talk',
          goal: 'education', outcome: 'x', thesis: 'y', audience: 'z', format: 'workshop',
          outline: [
            { title: 'seg', summary: 's', utteranceIds: ['a1'] },
            { title: 'ungrounded', summary: 's', utteranceIds: ['NOPE'] },
          ],
          feasibility: 0.3, novelty: 0.4, rationale: 'r', buildsOn: [],
        },
      ],
    });
    const created = await talks.proposeTalks('w');
    expect(created).toHaveLength(1); // thin talk dropped
    const t = created[0]!;
    expect(t.title).toBe('Selling AI into Regulated Verticals');
    expect(t.status).toBe('open');
    expect(t.goal).toBe('sales_enablement');
    // GHOST dropped from segment 1; receipts are the union of grounded segment ids
    expect(t.outline[0]!.utteranceIds).toEqual(['a1']);
    expect(t.sourceUtteranceIds.sort()).toEqual(['a1', 'a2']);
    expect(t.buildsOn).toContain('Q1 Webinar: Selling to Enterprise');

    // delivered-content inventory was passed to the model (novelty awareness)
    const userArg = (structured.mock.calls.at(-1)![0] as { user: string }).user;
    expect(userArg).toContain('DELIVERED / EXISTING CONTENT INVENTORY');
    expect(userArg).toContain('Q1 Webinar: Selling to Enterprise');
  });

  it('passes a goal focus through to the prompt', async () => {
    structured.mockResolvedValueOnce({ talks: [] });
    await talks.proposeTalks('w', { goal: 'recruiting' });
    const userArg = (structured.mock.calls.at(-1)![0] as { user: string }).user;
    expect(userArg).toContain('recruiting');
  });

  it('refuses to propose with an empty corpus', async () => {
    db.ensureWorkspace('empty');
    await expect(talks.proposeTalks('empty')).rejects.toThrow(/corpus/i);
  });
});

describe('talk proposal lifecycle', () => {
  it('plan and dismiss move status; delete removes', () => {
    const [t] = db.listTalkProposals('w', 'open');
    talks.planTalk('w', t.id);
    expect(db.getTalkProposal('w', t.id)!.status).toBe('planned');
    // planned proposals leave the open list
    expect(db.listTalkProposals('w', 'open').some((x) => x.id === t.id)).toBe(false);

    talks.dismissTalk('w', t.id);
    expect(db.getTalkProposal('w', t.id)!.status).toBe('dismissed');
    db.deleteTalkProposal('w', t.id);
    expect(db.getTalkProposal('w', t.id)).toBeNull();
  });

  it('plan/dismiss on a missing proposal throw', () => {
    expect(() => talks.planTalk('w', 'nope')).toThrow(/not found/i);
    expect(() => talks.dismissTalk('w', 'nope')).toThrow(/not found/i);
  });
});
