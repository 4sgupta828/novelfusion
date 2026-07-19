import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const DB = path.join(os.tmpdir(), `nf-clips-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
process.env.NF_DB_PATH = DB;
vi.mock('../src/llm/client.js', () => ({ structured: vi.fn(), generate: vi.fn() }));

type DBMod = typeof import('../src/db/index.js');
type Clips = typeof import('../src/pipeline/clips.js');
let db: DBMod;
let clips: Clips;
let ffmpegOk = true;

const utt = (over: Record<string, unknown>) => ({
  id: 'x', sourceId: 's1', workspaceId: 'w', speaker: 'Ada Lovelace', tStartSec: 1.0, tEndSec: 2.5,
  text: 'A grounded thing that was actually said on the record.', seq: 0,
  locator: { kind: 'transcript' as const }, provenanceClass: 'human_utterance' as const, ...over,
});

beforeAll(async () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) try { fs.unlinkSync(f); } catch { /* ignore */ }
  db = await import('../src/db/index.js');
  clips = await import('../src/pipeline/clips.js');
  db.ensureWorkspace('w');
  db.insertSource({ id: 's1', workspaceId: 'w', kind: 'upload', uri: 'talk.mp4', title: 'Recorded Talk', recordedAt: null, consentBasis: 'recorded_consent', admitted: true });
  db.insertSource({ id: 's2', workspaceId: 'w', kind: 'upload', uri: 'other', title: 'Other', recordedAt: null, consentBasis: 'recorded_consent', admitted: true });
  db.insertUtterances([
    utt({ id: 'u1', seq: 0, tStartSec: 1.0, tEndSec: 2.5 }),
    utt({ id: 'u2', seq: 1, tStartSec: 2.5, tEndSec: 4.0, text: 'And a second real line to caption.' }),
    utt({ id: 'u_nospk', seq: 2, speaker: null }), // unknown speaker
    utt({ id: 'u_nots', seq: 3, tStartSec: null, tEndSec: null }), // no timestamps
    utt({ id: 'u_s2', sourceId: 's2', seq: 0 }), // different source
  ]);

  // Generate a real 6s test video and attach it as the source recording.
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-clips-src-'));
    const src = path.join(tmp, 'src.mp4');
    await exec('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', src]);
    const bytes = fs.readFileSync(src);
    db.insertSourceBlob({ sourceId: 's1', workspaceId: 'w', filename: 'src.mp4', mime: 'video/mp4', size: bytes.length, bytes });
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    ffmpegOk = false;
  }
});

afterAll(() => {
  // clean any rendered files this test wrote
  const dir = path.join(process.cwd(), 'data', 'renders');
  for (const c of db.listRenderedClips('w')) { try { fs.unlinkSync(path.resolve(process.cwd(), c.filePath)); } catch { /* ignore */ } }
  try { if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* ignore */ }
});

describe('renderClip — gates (fail-closed, no ffmpeg needed)', () => {
  it('blocks when the speaker has no clip consent grant', async () => {
    await expect(clips.renderClip('w', { utteranceIds: ['u1', 'u2'], format: '9:16' })).rejects.toMatchObject({ code: 'consent_blocked' });
  });

  it('blocks material with no timestamps', async () => {
    // grant consent so we get past the consent gate to the timestamp check
    db.insertConsentGrant({ workspaceId: 'w', subjectLabel: 'Ada Lovelace', collaboratorId: null, scopes: ['clip'], channels: ['all'], survivesDeparture: false, evidence: 'release', grantedAt: null });
    await expect(clips.renderClip('w', { utteranceIds: ['u_nots'] })).rejects.toMatchObject({ code: 'no_timestamps' });
  });

  it('blocks an unknown speaker (cannot verify consent)', async () => {
    await expect(clips.renderClip('w', { utteranceIds: ['u_nospk'] })).rejects.toMatchObject({ code: 'unknown_speaker' });
  });

  it('blocks a clip spanning two recordings', async () => {
    await expect(clips.renderClip('w', { utteranceIds: ['u1', 'u_s2'] })).rejects.toMatchObject({ code: 'mixed_source' });
  });

  it('blocks when the source has no attached recording', async () => {
    db.insertSource({ id: 's3', workspaceId: 'w', kind: 'upload', uri: 'n', title: 'No media', recordedAt: null, consentBasis: 'recorded_consent', admitted: true });
    db.insertUtterances([utt({ id: 'u_s3', sourceId: 's3', seq: 0, speaker: 'Ada Lovelace' })]);
    await expect(clips.renderClip('w', { utteranceIds: ['u_s3'] })).rejects.toMatchObject({ code: 'no_media' });
  });
});

describe('renderClip — real ffmpeg render (integration)', () => {
  it('renders a valid mp4 at the requested aspect once consent covers the speaker', async () => {
    if (!ffmpegOk) { console.warn('ffmpeg unavailable — skipping real render'); return; }
    // Ada already has a clip grant (added above).
    const clip = await clips.renderClip('w', { utteranceIds: ['u1', 'u2'], format: '9:16', channel: 'li_post' });
    expect(clip.speakers).toEqual(['Ada Lovelace']);
    expect(clip.consentGrantIds.length).toBeGreaterThan(0); // records WHICH grant authorized it
    expect(clip.format).toBe('9:16');
    // the file exists and is a real video at 720x1280
    const abs = path.resolve(process.cwd(), clip.filePath);
    expect(fs.existsSync(abs)).toBe(true);
    expect(clip.size).toBeGreaterThan(1000);
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', abs]);
    expect(stdout.trim()).toBe('720,1280');
    // persisted + retrievable
    expect(db.getRenderedClip('w', clip.id)!.id).toBe(clip.id);
  }, 30000);

  it('renders from START-ONLY timestamps (deriving segment ends from the next start) — the real-corpus shape', async () => {
    if (!ffmpegOk) return;
    // transcript segments with a start but NO end time (like the actual corpus)
    db.insertUtterances([
      utt({ id: 'so1', sourceId: 's1', seq: 10, speaker: 'Ada Lovelace', tStartSec: 0.5, tEndSec: null, text: 'Start-only caption one.' }),
      utt({ id: 'so2', sourceId: 's1', seq: 11, speaker: 'Ada Lovelace', tStartSec: 2.0, tEndSec: null, text: 'Start-only caption two.' }),
    ]);
    const clip = await clips.renderClip('w', { utteranceIds: ['so1', 'so2'], format: '1:1' });
    expect(clip.durationSec).toBeGreaterThan(1); // end derived from next start + fallback
    const abs = path.resolve(process.cwd(), clip.filePath);
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', abs]);
    expect(stdout.trim()).toBe('720,720');
  }, 30000);

  it('revoking the grant re-blocks the render (consent is live)', async () => {
    if (!ffmpegOk) return;
    const g = db.activeGrantsForSubject('w', 'Ada Lovelace')[0]!;
    db.revokeConsentGrant('w', g.id);
    await expect(clips.renderClip('w', { utteranceIds: ['u1', 'u2'] })).rejects.toMatchObject({ code: 'consent_blocked' });
  });
});
