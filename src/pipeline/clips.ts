// Real-footage clip rendering (SYNTHESIS §8 slice 2) — cut a provenance-clean clip from a source's
// retained recording (source_blobs) at a moment's timestamps, with burned captions and a target
// aspect. NOT synthetic: a real person verifiably saying the real thing. Rendering is BLOCKED by the
// consent gate unless every on-screen speaker has a covering `clip` grant — the first real consumer
// of the consent ledger (slice 1).
//
// Rule 15 (new subprocess exec path): ffmpeg is invoked via execFile with an ARGUMENT ARRAY (never a
// shell string), all file paths are process-generated random names under our own dirs, and caption
// TEXT lives in an SRT file (never on the command line) — so no user string reaches a shell or the
// ffmpeg argv as an option. Rule 18: consent + timestamp checks are deterministic code, not a model.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  getUtterancesByIds,
  getSourceBlob,
  getMoment,
  consentGate,
  insertRenderedClip,
} from '../db/index.js';
import type { ClipFormat, RenderedClip, Utterance } from '../domain/types.js';

const exec = promisify(execFile);

const DIMS: Record<ClipFormat, [number, number]> = { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [720, 720] };
const LEAD_SEC = 0.3; // padding before the first utterance
const TAIL_SEC = 0.5; // padding after the last
const FALLBACK_SEG = 6; // assumed spoken duration when a segment has a start but no end time
const RENDERS_DIR = path.join(process.cwd(), 'data', 'renders');
const EXT_BY_MIME: Record<string, string> = {
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'weba', 'audio/ogg': 'ogg',
};

export type ClipErrorCode = 'no_utterances' | 'mixed_source' | 'no_timestamps' | 'no_media' | 'unsupported_media' | 'unknown_speaker' | 'consent_blocked';
export class ClipError extends Error {
  code: ClipErrorCode;
  detail?: unknown;
  constructor(code: ClipErrorCode, message: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

const rand = () => randomBytes(9).toString('hex');
const fmtTs = (sec: number) => {
  const s = Math.max(0, sec);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60), ms = Math.round((s - Math.floor(s)) * 1000);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(hh)}:${p2(mm)}:${p2(ss)},${String(ms).padStart(3, '0')}`;
};

/** Build an SRT from utterances, timed relative to the clip start. */
function buildSrt(cues: { start: number; end: number; text: string }[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${fmtTs(c.start)} --> ${fmtTs(Math.max(c.end, c.start + 0.5))}\n${c.text.replace(/\r?\n/g, ' ').trim()}\n`)
    .join('\n');
}

async function hasVideoStream(file: string): Promise<boolean> {
  try {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]);
    return stdout.trim().startsWith('video');
  } catch {
    return false;
  }
}

/** ffmpeg's subtitles filter takes a filename inside a filtergraph; escape the chars the parser treats
 *  specially. Our paths are random hex under our own dir (no quotes/colons in practice), but escape
 *  defensively so a stray char can't break out of the filter argument. */
const escapeForFilter = (p: string) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");

export interface RenderClipOpts {
  utteranceIds?: string[];
  momentId?: string;
  format?: ClipFormat;
  channel?: string;
}

/** Render a real-footage clip. Throws ClipError with a code for every gate (fail-closed on consent /
 *  missing media / missing timestamps / unknown speaker). */
export async function renderClip(workspaceId: string, opts: RenderClipOpts): Promise<RenderedClip> {
  const format: ClipFormat = opts.format ?? '16:9';
  const channel = opts.channel ?? 'all';
  const momentId = opts.momentId ?? null;

  let ids = opts.utteranceIds ?? [];
  if (momentId && ids.length === 0) {
    const m = getMoment(workspaceId, momentId);
    if (!m) throw new ClipError('no_utterances', 'Moment not found.');
    ids = m.utteranceIds;
  }
  const utts = getUtterancesByIds(workspaceId, ids) as (Utterance & { workspaceId: string })[];
  if (utts.length === 0) throw new ClipError('no_utterances', 'No utterances to render.');

  // A clip comes from ONE recording.
  const sourceId = utts[0]!.sourceId;
  if (!utts.every((u) => u.sourceId === sourceId)) throw new ClipError('mixed_source', 'A clip must come from a single recording.');

  // Only spoken (timestamped) material can be cut. A start time is required; end times are often
  // absent in transcripts, so we derive them from the next segment's start (see below).
  if (!utts.every((u) => u.tStartSec != null)) {
    throw new ClipError('no_timestamps', 'These segments have no timestamps — only spoken (transcript) sources with real timing can be clipped.');
  }

  // The real recording must be attached.
  const blob = getSourceBlob(workspaceId, sourceId);
  if (!blob) throw new ClipError('no_media', 'No recording is attached to this source. Attach the original audio/video to render a real-footage clip.');
  const ext = EXT_BY_MIME[blob.mime];
  if (!ext) throw new ClipError('unsupported_media', `The attached media type (${blob.mime}) isn't a supported audio/video format.`);

  // Consent gate — every on-screen speaker needs a covering `clip` grant. Fail-closed on unknowns.
  const speakers = [...new Set(utts.map((u) => u.speaker).filter((s): s is string => !!s))];
  if (utts.some((u) => !u.speaker) || speakers.length === 0) {
    throw new ClipError('unknown_speaker', 'The speaker is unknown for part of this clip — consent cannot be verified, so it will not render.');
  }
  const grantIds: string[] = [];
  const blocked: { speaker: string; reason: string }[] = [];
  for (const sp of speakers) {
    const d = consentGate(workspaceId, { subjectLabel: sp, scope: 'clip', channel });
    if (!d.covered) blocked.push({ speaker: sp, reason: d.reason });
    else if (d.grantId) grantIds.push(d.grantId);
  }
  if (blocked.length) {
    throw new ClipError('consent_blocked', `Consent blocks this render — no active "clip" grant for: ${blocked.map((b) => b.speaker).join(', ')}. Add a clip consent grant in the Consent ledger.`, blocked);
  }

  // Derive a per-segment [start, end] window. End times are often null in transcripts, so fall back
  // to the NEXT segment's start (in seq order), and for the last segment to start + FALLBACK_SEG.
  const ordered = [...utts].sort((a, b) => a.tStartSec! - b.tStartSec!);
  const windows = ordered.map((u, i) => {
    const start = u.tStartSec!;
    const nextStart = ordered[i + 1]?.tStartSec ?? null;
    const end = u.tEndSec ?? (nextStart != null ? nextStart : start + FALLBACK_SEG);
    return { start, end: Math.max(end, start + 0.5), text: u.text };
  });

  // Timing (clamped, padded) — from the derived windows.
  const startSec = Math.max(0, windows[0]!.start - LEAD_SEC);
  const endSec = Math.max(...windows.map((w) => w.end)) + TAIL_SEC;
  const durationSec = Math.max(0.2, endSec - startSec);

  // Stage input + captions in a private temp dir; output under data/renders.
  fs.mkdirSync(RENDERS_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-clip-'));
  try {
    const inFile = path.join(tmp, `in.${ext}`);
    fs.writeFileSync(inFile, blob.bytes);
    const srtFile = path.join(tmp, 'cap.srt');
    fs.writeFileSync(srtFile, buildSrt(windows.map((w) => ({ start: w.start - startSec, end: w.end - startSec, text: w.text }))));

    const [w, h] = DIMS[format];
    const outName = `${rand()}.mp4`;
    const outFile = path.join(RENDERS_DIR, outName);
    const sub = `subtitles='${escapeForFilter(srtFile)}':force_style='Alignment=2,FontSize=22,MarginV=40,PrimaryColour=&H00FFFFFF,Outline=1,Shadow=1'`;

    let args: string[];
    if (await hasVideoStream(inFile)) {
      // Real video: fast-seek, cut, scale+pad to aspect, burn captions.
      args = ['-y', '-ss', String(startSec), '-i', inFile, '-t', String(durationSec),
        '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,${sub}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', outFile];
    } else {
      // Audio-only: solid card at the target size carries the audio + burned captions.
      args = ['-y', '-f', 'lavfi', '-i', `color=c=0x111417:s=${w}x${h}`, '-ss', String(startSec), '-i', inFile, '-t', String(durationSec),
        '-vf', sub, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', outFile];
    }
    await exec('ffmpeg', args, { maxBuffer: 1 << 27 });
    const size = fs.statSync(outFile).size;

    return insertRenderedClip({
      workspaceId, sourceId, momentId, utteranceIds: ids, speakers, consentGrantIds: grantIds,
      format, channel, startSec, endSec, durationSec,
      filename: outName, filePath: path.relative(process.cwd(), outFile), mime: 'video/mp4', size,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Absolute path to a rendered clip's file (for streaming); null if the record/file is gone. */
export function clipFileAbsPath(clip: RenderedClip): string | null {
  const abs = path.resolve(process.cwd(), clip.filePath);
  return fs.existsSync(abs) ? abs : null;
}
