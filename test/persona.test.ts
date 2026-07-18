import { describe, expect, it, beforeAll, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `nf-persona-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
process.env.NF_DB_PATH = DB;

const structured = vi.fn();
vi.mock('../src/llm/client.js', () => ({ structured: (...a: unknown[]) => structured(...a), generate: vi.fn() }));

type DBMod = typeof import('../src/db/index.js');
type Persona = typeof import('../src/pipeline/persona.js');
let db: DBMod;
let persona: Persona;

const utt = (ws: string, sid: string, uid: string, text: string, seq: number) => ({
  id: uid, sourceId: sid, workspaceId: ws, speaker: null, tStartSec: null, tEndSec: null,
  text, seq, locator: { kind: 'document' as const }, provenanceClass: 'owned_document' as const,
});

beforeAll(async () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) try { fs.unlinkSync(f); } catch { /* ignore */ }
  db = await import('../src/db/index.js');
  persona = await import('../src/pipeline/persona.js');
  db.ensureWorkspace('w');
  // sV = published voice source (marked voice); sF = fact source (not voice)
  db.insertSource({ id: 'sV', workspaceId: 'w', kind: 'webpage', uri: 'blog', title: 'Blog', recordedAt: null, consentBasis: 'public', admitted: true });
  db.insertSource({ id: 'sF', workspaceId: 'w', kind: 'upload', uri: 'call', title: 'Call', recordedAt: null, consentBasis: 'recorded_consent', admitted: true });
  db.insertUtterances([
    utt('w', 'sV', 'v1', 'We build boring infrastructure on purpose. Reliability is a feature, not a footnote.', 0),
    utt('w', 'sV', 'v2', 'Hype is a tax on trust. We would rather ship one dull thing that works.', 1),
    utt('w', 'sF', 'f1', 'On the call the customer said churn was up 9 percent.', 0),
  ]);
  db.setSourceVoice('w', 'sV', true);
});

describe('voice corpus tagging', () => {
  it('listVoiceUtterances returns only voice-tagged, admitted passages', () => {
    expect(db.listVoiceUtterances('w').map((u) => u.id).sort()).toEqual(['v1', 'v2']); // not f1
  });
  it('untagging removes a source from the voice corpus', () => {
    db.setSourceVoice('w', 'sV', false);
    expect(db.listVoiceUtterances('w')).toEqual([]);
    db.setSourceVoice('w', 'sV', true); // restore
  });
});

describe('persona distillation (grounding + versioning)', () => {
  it('drops fabricated example ids and keeps real ones; persists as v1 enabled', async () => {
    structured.mockResolvedValueOnce({
      summary: 'A reliability-obsessed anti-hype infra brand',
      register: 'plain, dry, confident',
      rhetoric: 'contrarian; leads with the unglamorous truth',
      lexicon: { embraces: ['boring', 'reliability'], avoids: ['revolutionary', 'game-changing'], signaturePhrases: ['a tax on trust'] },
      beliefs: [{ statement: 'Hype erodes trust', exampleUtteranceIds: ['v2', 'GHOST'] }], // GHOST must be dropped
      obsessions: ['reliability'],
      dos: [{ rule: 'State the dull truth plainly', exampleUtteranceIds: ['v1'] }],
      donts: [{ rule: 'Never use hype words', exampleUtteranceIds: ['NOPE'] }], // dropped
    });
    const r = await persona.distillPersona('w');
    expect(r.version).toBe(1);
    expect(r.beliefs[0]!.exampleUtteranceIds).toEqual(['v2']); // GHOST removed
    expect(r.donts[0]!.exampleUtteranceIds).toEqual([]); // NOPE removed

    const saved = db.getActiveVoicePersona('w')!;
    expect(saved.enabled).toBe(true);
    expect(saved.version).toBe(1);
    expect(saved.profile.lexicon.avoids).toContain('revolutionary');
  });

  it('re-distill creates v2 (the new active version)', async () => {
    structured.mockResolvedValueOnce({
      summary: 'v2 summary', register: 'r', rhetoric: 'r',
      lexicon: { embraces: [], avoids: [], signaturePhrases: [] },
      beliefs: [], obsessions: [], dos: [], donts: [],
    });
    const r = await persona.distillPersona('w');
    expect(r.version).toBe(2);
    expect(db.getActiveVoicePersona('w')!.version).toBe(2);
  });

  it('the enabled toggle flips the active persona (the voice-layer switch)', () => {
    db.setVoicePersonaEnabled('w', false);
    expect(db.getActiveVoicePersona('w')!.enabled).toBe(false);
    db.setVoicePersonaEnabled('w', true);
    expect(db.getActiveVoicePersona('w')!.enabled).toBe(true);
  });

  it('refuses to distill with no voice corpus', async () => {
    db.ensureWorkspace('empty');
    await expect(persona.distillPersona('empty')).rejects.toThrow(/voice corpus/i);
  });
});
