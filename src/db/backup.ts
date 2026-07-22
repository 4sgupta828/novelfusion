// Data safeguards for the local SQLite corpus (the only copy of everything: sources, utterances,
// moments, constitution, consent grants, media blobs). Two protections:
//   1. Rotating ONLINE backups (better-sqlite3 .backup(), consistent even while open) written OUTSIDE
//      the repo (~/.novelfusion/backups by default) — so a stray `rm -rf` inside the checkout can't
//      take the backups with it. Empty/ephemeral (temp) DBs are never backed up, so an accident can
//      never overwrite good backups with an empty snapshot.
//   2. A startup alarm: if the live DB is unexpectedly empty but backups with data exist, warn loudly
//      with the restore command instead of silently serving an empty database.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';

// Config is read dynamically (not captured at import) so it's deterministic under tests and reacts to
// env set before a call.
export const backupDir = (): string =>
  process.env.NF_BACKUP_DIR || path.join(os.homedir(), '.novelfusion', 'backups');
const keep = () => Math.max(1, Number(process.env.NF_BACKUP_KEEP || 20));
const throttleMs = () => Math.max(0, Number(process.env.NF_BACKUP_THROTTLE_MIN || 5)) * 60_000;
const disabled = () => process.env.NF_DISABLE_BACKUP === 'true' || process.env.NF_DISABLE_BACKUP === '1';
// Test-only escape: allow backing up a temp DB (so the backup logic itself is testable).
const allowTmp = () => process.env.NF_BACKUP_ALLOW_TMP === '1';

/** Test/verify DBs live under the system temp dir (or are named verify.db) — never back those up (and
 *  never let them touch the real backups). This isolation is exactly what prevents a verify cleanup
 *  from harming real data. Pure function of the path (no env), so it is directly testable. */
export function isEphemeralPath(dbPath: string): boolean {
  const real = path.resolve(dbPath);
  return real.startsWith(path.resolve(os.tmpdir())) || /(^|\/)verify\.db$/.test(real) || real === path.resolve(':memory:');
}
// An ephemeral (temp/verify) DB is only backup-able under the explicit test escape AND an explicit
// backup dir — so other test files (which set neither) can never write real backups to ~/.novelfusion.
const skipForDb = () => isEphemeralPath(config.dbPath) && !(allowTmp() && !!process.env.NF_BACKUP_DIR);

/** Rough "does this DB hold real content?" — sum of the core corpus tables. Tolerant of missing tables. */
export function dbHasData(db: Database.Database): boolean {
  try {
    const q = (t: string) => {
      try { return (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c; } catch { return 0; }
    };
    return q('workspaces') + q('sources') + q('utterances') + q('moments') > 0;
  } catch {
    return false;
  }
}

export interface BackupInfo { file: string; path: string; size: number; mtime: Date; }

export function listBackups(): BackupInfo[] {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('novelfusion-') && f.endsWith('.db'))
    .map((f) => { const p = path.join(dir, f); const s = fs.statSync(p); return { file: f, path: p, size: s.size, mtime: s.mtime }; })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

function prune(): void {
  const extra = listBackups().slice(keep());
  for (const b of extra) try { fs.unlinkSync(b.path); } catch { /* ignore */ }
}

const stamp = () => new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').replace('Z', ''); // ms-unique

/** Create a consistent online backup of `db`. Returns the backup path, or null when skipped
 *  (disabled, ephemeral DB, empty DB, or throttled). Never throws — a backup failure must not break
 *  the app. */
export async function backupDb(db: Database.Database, opts: { force?: boolean; reason?: string } = {}): Promise<string | null> {
  if (disabled()) return null;
  if (skipForDb()) return null; // never back up test/verify DBs
  if (!dbHasData(db)) return null; // NEVER back up an empty DB (nothing to save; force only bypasses throttle)
  const latest = listBackups()[0];
  if (!opts.force && latest && Date.now() - latest.mtime.getTime() < throttleMs()) return null;
  try {
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `novelfusion-${stamp()}.db`);
    await db.backup(dest); // online, consistent (checkpoints internally → a standalone single file)
    prune();
    return dest;
  } catch (e) {
    console.warn(`[backup] failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Startup guard: if the real DB is empty but good backups exist, this is almost certainly data loss —
 *  warn loudly rather than silently serving an empty database. Returns true if the alarm fired. */
export function assertNotUnexpectedlyEmpty(db: Database.Database): boolean {
  if (skipForDb()) return false;
  if (dbHasData(db)) return false;
  const latest = listBackups()[0];
  if (!latest) return false;
  console.warn(
    `\n⚠️  DATABASE APPEARS EMPTY — but a backup with data exists.\n` +
    `   Live DB:  ${config.dbPath}\n` +
    `   Latest backup: ${latest.file} (${(latest.size / 1e6).toFixed(1)} MB, ${latest.mtime.toISOString()})\n` +
    `   If this is unexpected, restore with:  npm run nf -- restore\n`,
  );
  return true;
}

/** Restore the live DB from a backup (latest if unspecified). Safety-copies the CURRENT db first
 *  (so restore is itself reversible) and clears stale -wal/-shm so the restored file is authoritative. */
export function restoreFromBackup(file?: string): { restored: string; safetyCopy: string | null } {
  const chosen = file
    ? (path.isAbsolute(file) ? file : path.join(backupDir(), file))
    : listBackups()[0]?.path;
  if (!chosen || !fs.existsSync(chosen)) throw new Error('No backup found to restore from.');

  const dest = config.dbPath;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // safety-copy current db (if any) before overwriting
  let safetyCopy: string | null = null;
  if (fs.existsSync(dest)) {
    safetyCopy = `${dest}.pre-restore-${stamp()}`;
    fs.copyFileSync(dest, safetyCopy);
  }
  fs.copyFileSync(chosen, dest);
  for (const sidecar of [`${dest}-wal`, `${dest}-shm`]) try { fs.unlinkSync(sidecar); } catch { /* none */ }
  return { restored: chosen, safetyCopy };
}
