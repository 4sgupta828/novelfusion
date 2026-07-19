import { describe, expect, it, beforeAll, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { decideConsent, channelCovers } from '../src/domain/consent.js';
import type { ConsentGrant } from '../src/domain/types.js';

// ---- pure gate logic (no DB) ----
const grant = (over: Partial<ConsentGrant> = {}): ConsentGrant => ({
  id: 'g1', workspaceId: 'w', subject: 'ada lovelace', subjectLabel: 'Ada Lovelace', collaboratorId: null,
  scopes: ['clip'], channels: ['all'], survivesDeparture: false, evidence: 'signed release',
  grantedAt: '2026-01-01', revokedAt: null, createdAt: '2026-01-01', ...over,
});

describe('decideConsent — deterministic, fail-closed', () => {
  it('covers when scope + channel match', () => {
    const d = decideConsent([grant({ scopes: ['clip'], channels: ['all'] })], { scope: 'clip', channel: 'li_post' });
    expect(d.covered).toBe(true);
    expect(d.grantId).toBe('g1');
  });

  it('fails closed with no grants', () => {
    expect(decideConsent([], { scope: 'clip', channel: 'li_post' }).covered).toBe(false);
  });

  it('does NOT cascade scopes — a likeness grant does not cover clip', () => {
    const d = decideConsent([grant({ scopes: ['likeness'] })], { scope: 'clip', channel: 'li_post' });
    expect(d.covered).toBe(false);
    expect(d.reason).toMatch(/no consent grant for scope "clip"/);
  });

  it('a revoked grant never covers', () => {
    const d = decideConsent([grant({ scopes: ['clip'], revokedAt: '2026-02-01' })], { scope: 'clip', channel: 'li_post' });
    expect(d.covered).toBe(false);
  });

  it('channel scoping: a grant for one channel does not cover another', () => {
    const d = decideConsent([grant({ scopes: ['voice_clone'], channels: ['x_thread'] })], { scope: 'voice_clone', channel: 'li_post' });
    expect(d.covered).toBe(false);
    expect(d.reason).toMatch(/not for channel/);
  });

  it('synthetic presenter needs BOTH likeness and voice_clone (separately gated)', () => {
    const grants = [grant({ id: 'gl', scopes: ['likeness'] })]; // has likeness, not voice
    expect(decideConsent(grants, { scope: 'likeness', channel: 'li_post' }).covered).toBe(true);
    expect(decideConsent(grants, { scope: 'voice_clone', channel: 'li_post' }).covered).toBe(false);
  });

  it('channelCovers handles all vs specific', () => {
    expect(channelCovers(grant({ channels: ['all'] }), 'anything')).toBe(true);
    expect(channelCovers(grant({ channels: ['blog'] }), 'blog')).toBe(true);
    expect(channelCovers(grant({ channels: ['blog'] }), 'li_post')).toBe(false);
  });
});

// ---- DB-backed gate + ledger ----
const DB = path.join(os.tmpdir(), `nf-consent-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
process.env.NF_DB_PATH = DB;
vi.mock('../src/llm/client.js', () => ({ structured: vi.fn(), generate: vi.fn() }));
type DBMod = typeof import('../src/db/index.js');
let db: DBMod;

beforeAll(async () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) try { fs.unlinkSync(f); } catch { /* ignore */ }
  db = await import('../src/db/index.js');
  db.ensureWorkspace('w');
});

describe('consent ledger + gate (DB)', () => {
  it('insert normalizes the subject key; gate matches by normalized name', () => {
    const g = db.insertConsentGrant({
      workspaceId: 'w', subjectLabel: '  Grace   Hopper ', collaboratorId: null,
      scopes: ['clip', 'quote'], channels: ['all'], survivesDeparture: true, evidence: 'email consent', grantedAt: null,
    });
    expect(g.subject).toBe('grace hopper'); // normalized
    // gate matches regardless of the caller's casing/spacing
    expect(db.consentGate('w', { subjectLabel: 'grace hopper', scope: 'clip', channel: 'li_post' }).covered).toBe(true);
    expect(db.consentGate('w', { subjectLabel: 'GRACE  HOPPER', scope: 'quote', channel: 'blog' }).covered).toBe(true);
    // a scope she didn't grant is blocked (fail-closed) — synthetic likeness NOT covered by a clip grant
    expect(db.consentGate('w', { subjectLabel: 'Grace Hopper', scope: 'likeness', channel: 'li_post' }).covered).toBe(false);
  });

  it('revocation is soft and immediately blocks the gate; the row is retained (audit trail)', () => {
    const g = db.insertConsentGrant({
      workspaceId: 'w', subjectLabel: 'Alan Turing', collaboratorId: null,
      scopes: ['voice_clone'], channels: ['all'], survivesDeparture: false, evidence: 'call', grantedAt: null,
    });
    expect(db.consentGate('w', { subjectLabel: 'Alan Turing', scope: 'voice_clone', channel: 'li_post' }).covered).toBe(true);
    db.revokeConsentGrant('w', g.id);
    expect(db.consentGate('w', { subjectLabel: 'Alan Turing', scope: 'voice_clone', channel: 'li_post' }).covered).toBe(false);
    // still present in the full listing (not hard-deleted), absent from active
    expect(db.listConsentGrants('w').some((x) => x.id === g.id)).toBe(true);
    expect(db.listConsentGrants('w', { activeOnly: true }).some((x) => x.id === g.id)).toBe(false);
  });

  it('an unknown person is fail-closed', () => {
    expect(db.consentGate('w', { subjectLabel: 'Nobody Here', scope: 'clip', channel: 'li_post' }).covered).toBe(false);
  });
});
