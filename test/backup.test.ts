import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-bk-'));
const DB = path.join(TMP, 'novelfusion.db');
const BKDIR = path.join(TMP, 'backups');
// set before importing the module (config.dbPath is read from NF_DB_PATH)
process.env.NF_DB_PATH = DB;
process.env.NF_BACKUP_DIR = BKDIR;
process.env.NF_BACKUP_ALLOW_TMP = '1'; // test escape: let the backup logic run against a temp DB
process.env.NF_BACKUP_THROTTLE_MIN = '0';
process.env.NF_BACKUP_KEEP = '3';

type Backup = typeof import('../src/db/backup.js');
let bk: Backup;

// A minimal live DB at config.dbPath with just the tables dbHasData inspects.
function mkLive(): Database.Database {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) try { fs.unlinkSync(f); } catch { /* ignore */ }
  const d = new Database(DB);
  d.exec('CREATE TABLE workspaces(id TEXT); CREATE TABLE sources(id TEXT PRIMARY KEY); CREATE TABLE utterances(id TEXT); CREATE TABLE moments(id TEXT);');
  return d;
}
const clearBackups = () => { try { fs.rmSync(BKDIR, { recursive: true, force: true }); } catch { /* ignore */ } };

beforeAll(async () => { bk = await import('../src/db/backup.js'); });
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
beforeEach(clearBackups);

describe('isEphemeralPath (the isolation that stops verify cleanups from touching real data)', () => {
  it('flags temp / verify / memory paths; not a real data/ path', () => {
    expect(bk.isEphemeralPath(path.join(os.tmpdir(), 'x.db'))).toBe(true);
    expect(bk.isEphemeralPath('/Users/x/nf-wt-motion/data/verify.db')).toBe(true);
    expect(bk.isEphemeralPath(':memory:')).toBe(true);
    expect(bk.isEphemeralPath('/Users/x/novelfusion/data/novelfusion.db')).toBe(false);
  });
});

describe('backupDb', () => {
  it('does NOT back up an empty DB (never overwrite good backups with nothing)', async () => {
    const d = mkLive();
    expect(bk.dbHasData(d)).toBe(false);
    expect(await bk.backupDb(d, { force: true })).toBeNull();
    expect(bk.listBackups()).toHaveLength(0);
    d.close();
  });

  it('backs up a DB with data → a valid standalone copy with the same rows', async () => {
    const d = mkLive();
    d.prepare('INSERT INTO sources(id) VALUES (?)').run('s1');
    expect(bk.dbHasData(d)).toBe(true);
    const dest = await bk.backupDb(d, { force: true });
    d.close();
    expect(dest && fs.existsSync(dest)).toBeTruthy();
    const copy = new Database(dest!, { readonly: true });
    expect((copy.prepare('SELECT COUNT(*) c FROM sources').get() as { c: number }).c).toBe(1);
    copy.close();
  });

  it('rotation keeps only NF_BACKUP_KEEP newest', async () => {
    const d = mkLive();
    d.prepare('INSERT INTO sources(id) VALUES (?)').run('s1');
    for (let i = 0; i < 5; i++) { await bk.backupDb(d, { force: true }); await new Promise((r) => setTimeout(r, 3)); }
    d.close();
    expect(bk.listBackups().length).toBe(3); // KEEP=3
  });

  it('throttle skips a non-forced backup taken too soon after the last', async () => {
    process.env.NF_BACKUP_THROTTLE_MIN = '60';
    const d = mkLive();
    d.prepare('INSERT INTO sources(id) VALUES (?)').run('s1');
    expect(await bk.backupDb(d, { force: true })).toBeTruthy(); // first (forced) succeeds
    expect(await bk.backupDb(d, {})).toBeNull(); // second, not forced, within throttle → skipped
    d.close();
    process.env.NF_BACKUP_THROTTLE_MIN = '0';
  });
});

describe('assertNotUnexpectedlyEmpty (startup alarm)', () => {
  it('does not fire when the DB has data', () => {
    const d = mkLive();
    d.prepare('INSERT INTO sources(id) VALUES (?)').run('s1');
    expect(bk.assertNotUnexpectedlyEmpty(d)).toBe(false);
    d.close();
  });

  it('fires when the DB is empty but a backup with data exists', async () => {
    const d = mkLive();
    d.prepare('INSERT INTO sources(id) VALUES (?)').run('s1');
    await bk.backupDb(d, { force: true }); // a good backup now exists
    d.prepare('DELETE FROM sources').run(); // simulate loss
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fired = bk.assertNotUnexpectedlyEmpty(d);
    warn.mockRestore();
    d.close();
    expect(fired).toBe(true);
  });
});

describe('restoreFromBackup (reversible restore)', () => {
  it('restores rows from the latest backup and safety-copies the current DB first', async () => {
    const d = mkLive();
    d.prepare('INSERT INTO sources(id) VALUES (?)').run('s1');
    await bk.backupDb(d, { force: true });
    d.prepare('DELETE FROM sources').run(); // simulate loss
    d.close();

    const { restored, safetyCopy } = bk.restoreFromBackup();
    expect(fs.existsSync(restored)).toBe(true);
    expect(safetyCopy && fs.existsSync(safetyCopy)).toBeTruthy(); // previous DB preserved
    const check = new Database(DB);
    expect((check.prepare('SELECT COUNT(*) c FROM sources').get() as { c: number }).c).toBe(1);
    check.close();
  });

  it('throws when there is no backup to restore from', () => {
    expect(() => bk.restoreFromBackup()).toThrow(/no backup/i);
  });
});
