import { describe, expect, it, beforeAll, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `nf-talkdev-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
process.env.NF_DB_PATH = DB;
// Pin corpusQuery OFF so this test is hermetic (no hybrid expansion, no OpenAI faithfulness judge) —
// set before any import triggers dotenv, which won't override an already-set var. Deterministic
// span+numeric+id gates only.
process.env.NF_FLAG_CORPUS_QUERY = 'false';

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

// verbatim spans copied from the passages below
const A1 = 'Regulated verticals invert the risk calculus: buyers need proof, not vision.';
const A2 = 'Forward-deployed engineers close deals that a demo never could.';

beforeAll(async () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) try { fs.unlinkSync(f); } catch { /* ignore */ }
  db = await import('../src/db/index.js');
  talks = await import('../src/pipeline/talks.js');
  db.ensureWorkspace('w');
  db.insertSource({ id: 's1', workspaceId: 'w', kind: 'upload', uri: 'u', title: 'Src', recordedAt: null, consentBasis: 'recorded_consent', admitted: true });
  db.insertUtterances([
    utt('w', 's1', 'a1', A1, 0),
    utt('w', 's1', 'a2', A2, 1),
    utt('w', 's1', 'b1', 'The SOP-writing problem is the hidden killer of AI deployments.', 2),
  ]);
});

describe('developTalk — grounding gates + attestation zones + coverage honesty', () => {
  it('keeps grounded sourced points, drops span/numeric/id failures, labels zones, marks a thin segment a gap', async () => {
    // a two-segment planned proposal
    const proposal = db.insertTalkProposal({
      workspaceId: 'w', title: 'Selling into Regulated Verticals', goal: 'sales_enablement',
      outcome: 'shorter cycles', thesis: 'proof beats vision', audience: 'AEs', format: 'webinar',
      outline: [
        { title: 'The risk inversion', summary: 'why proof beats vision', utteranceIds: ['a1', 'a2'] },
        { title: 'Unsupported segment', summary: 'nothing grounds this', utteranceIds: ['b1'] },
      ],
      sourceUtteranceIds: ['a1', 'a2', 'b1'], feasibility: 0.8, novelty: 0.7, rationale: 'r', buildsOn: [],
    });
    db.updateTalkProposalStatus('w', proposal.id, 'planned');

    // Segment 1: 1 valid sourced, 1 span-fail, 1 numeric-fail, 1 connective, 1 speaker_owned
    structured.mockResolvedValueOnce({
      points: [
        { zone: 'sourced', text: 'Regulated buyers need proof, not vision.', supportingSpan: 'buyers need proof, not vision', utteranceIds: ['a1'] },
        { zone: 'sourced', text: 'A fabricated claim.', supportingSpan: 'this span appears in no passage at all', utteranceIds: ['a1'] }, // span-fail → drop
        { zone: 'sourced', text: 'Forward-deployed engineers close $500M deals.', supportingSpan: 'Forward-deployed engineers close deals', utteranceIds: ['a2'] }, // $500M not in evidence → numeric-fail → drop
        { zone: 'sourced', text: 'Ghost id claim.', supportingSpan: 'buyers need proof, not vision', utteranceIds: ['NOPE'] }, // id-fail → drop
        { zone: 'connective', text: 'Now, why does this matter?', supportingSpan: '', utteranceIds: [] },
        { zone: 'speaker_owned', text: '[Open with your own deal story]', supportingSpan: '', utteranceIds: [] },
      ],
      speakerNotes: 'Slow down on the proof point.',
    });
    // Segment 2: every sourced point is ungrounded → segment collapses to a gap
    structured.mockResolvedValueOnce({
      points: [
        { zone: 'sourced', text: 'Invented stat.', supportingSpan: 'not present anywhere', utteranceIds: ['b1'] },
      ],
      speakerNotes: '',
    });

    const kit = await talks.developTalk('w', proposal.id);

    // --- segment 1: only the one truly grounded sourced point survives ---
    const seg1 = kit.segments[0]!;
    const sourced1 = seg1.points.filter((p) => p.zone === 'sourced');
    expect(sourced1).toHaveLength(1);
    expect(sourced1[0]!.text).toBe('Regulated buyers need proof, not vision.');
    expect(sourced1[0]!.utteranceIds).toEqual(['a1']);
    expect(sourced1[0]!.spanMethod).toBeDefined();
    // zones preserved
    expect(seg1.points.some((p) => p.zone === 'connective')).toBe(true);
    expect(seg1.points.some((p) => p.zone === 'speaker_owned')).toBe(true);
    // connective/speaker carry no receipts
    expect(seg1.points.filter((p) => p.zone !== 'sourced').every((p) => p.utteranceIds.length === 0)).toBe(true);
    expect(seg1.coverage).toBe('partial'); // exactly 1 sourced

    // --- segment 2: coverage collapse → thin + honest gap, no fabricated claim shown ---
    const seg2 = kit.segments[1]!;
    expect(seg2.points.filter((p) => p.zone === 'sourced')).toHaveLength(0);
    expect(seg2.coverage).toBe('thin');
    expect(seg2.gapNote).toBeTruthy();

    // --- grounding summary: 1 kept, 3 dropped in seg1 + 1 in seg2 = 4; faithfulness off (corpusQuery off) ---
    expect(kit.grounding.sourced).toBe(1);
    expect(kit.grounding.dropped).toBe(4);
    expect(kit.grounding.faithfulnessApplied).toBe(false);

    // persisted + retrievable
    expect(db.getTalkKit('w', proposal.id)!.id).toBe(kit.id);
  });

  it('regenerate replaces the prior kit (one current kit per talk)', async () => {
    const [t] = db.listTalkProposals('w', 'planned');
    structured.mockResolvedValueOnce({ points: [{ zone: 'speaker_owned', text: '[your take]', supportingSpan: '', utteranceIds: [] }], speakerNotes: '' });
    structured.mockResolvedValueOnce({ points: [{ zone: 'connective', text: 'transition', supportingSpan: '', utteranceIds: [] }], speakerNotes: '' });
    const kit2 = await talks.developTalk('w', t.id);
    const rows = db.getDb().prepare('SELECT COUNT(*) c FROM talk_kits WHERE workspace_id = ? AND talk_id = ?').get('w', t.id) as { c: number };
    expect(rows.c).toBe(1); // replaced, not appended
    expect(db.getTalkKit('w', t.id)!.id).toBe(kit2.id);
  });

  it('reopen moves a planned talk back to open; develop refuses a dismissed talk', async () => {
    const [t] = db.listTalkProposals('w', 'planned');
    talks.reopenTalk('w', t.id);
    expect(db.getTalkProposal('w', t.id)!.status).toBe('open');

    const d = db.insertTalkProposal({
      workspaceId: 'w', title: 'x', goal: 'education', outcome: '', thesis: '', audience: '', format: 'webinar',
      outline: [{ title: 's', summary: 's', utteranceIds: ['a1'] }], sourceUtteranceIds: ['a1'], feasibility: 0.5, novelty: 0.5, rationale: '', buildsOn: [],
    });
    db.updateTalkProposalStatus('w', d.id, 'dismissed');
    await expect(talks.developTalk('w', d.id)).rejects.toThrow(/dismissed/i);
  });
});
