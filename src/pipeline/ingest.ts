// Transcript ingestion — pure structural parsing (Rule 18: code owns structure).
// Supported formats:
//   1. Timestamped speaker lines:  "[00:14:32] Priya Sharma: text..."
//   2. Speaker lines without time: "Priya Sharma: text..."
//   3. WebVTT (.vtt) with "<v Speaker>text" voice tags or "Speaker: text" cues
// Consecutive lines by the same speaker merge into one utterance.

import fs from 'node:fs';
import path from 'node:path';
import type { Source, Utterance } from '../domain/types.js';
import { ensureWorkspace, insertSource, insertUtterances, newId } from '../db/index.js';

export interface ParsedLine {
  speaker: string;
  tStartSec: number | null;
  text: string;
}

export function parseTimestamp(ts: string): number | null {
  const m = ts.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!m) return null;
  const [, h, mm, ss, ms] = m;
  return (h ? parseInt(h, 10) * 3600 : 0) + parseInt(mm!, 10) * 60 + parseInt(ss!, 10) + (ms ? parseInt(ms.padEnd(3, '0'), 10) / 1000 : 0);
}

export function parseTranscript(raw: string, defaultSpeaker = 'Unknown Speaker'): ParsedLine[] {
  const lines = raw.split(/\r?\n/);
  const out: ParsedLine[] = [];
  const isVtt = lines[0]?.trim() === 'WEBVTT';

  let pendingStart: number | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'WEBVTT' || /^\d+$/.test(trimmed)) continue;

    // VTT cue timing: 00:00:12.000 --> 00:00:15.000
    const cue = trimmed.match(/^([\d:.]+)\s+-->\s+([\d:.]+)/);
    if (cue) {
      pendingStart = parseTimestamp(cue[1]!);
      continue;
    }

    // VTT voice tag: <v Speaker Name>text
    const voice = trimmed.match(/^<v\s+([^>]+)>(.*)$/);
    if (voice) {
      out.push({ speaker: voice[1]!.trim(), tStartSec: pendingStart, text: voice[2]!.replace(/<\/v>/g, '').trim() });
      pendingStart = null;
      continue;
    }

    // [00:14:32] Speaker Name: text
    const stamped = trimmed.match(/^\[([\d:.]+)\]\s*([^:]{1,60}):\s*(.+)$/);
    if (stamped) {
      out.push({ speaker: stamped[2]!.trim(), tStartSec: parseTimestamp(stamped[1]!), text: stamped[3]!.trim() });
      pendingStart = null;
      continue;
    }

    // Speaker Name: text  (speaker heuristic: short prefix before first colon)
    const plain = trimmed.match(/^([^:]{1,60}):\s*(.+)$/);
    if (plain && !isVtt && /^[A-Za-z][\w .'-]*$/.test(plain[1]!.trim())) {
      out.push({ speaker: plain[1]!.trim(), tStartSec: pendingStart, text: plain[2]!.trim() });
      pendingStart = null;
      continue;
    }

    // Continuation or bare text — attach to previous speaker or default.
    const prev = out[out.length - 1];
    if (prev && pendingStart === null) {
      prev.text += ' ' + trimmed;
    } else {
      out.push({ speaker: defaultSpeaker, tStartSec: pendingStart, text: trimmed });
      pendingStart = null;
    }
  }

  // Merge consecutive same-speaker lines.
  const merged: ParsedLine[] = [];
  for (const l of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.speaker === l.speaker && l.tStartSec === null) {
      prev.text += ' ' + l.text;
    } else {
      merged.push({ ...l });
    }
  }
  return merged;
}

export function ingestFile(workspaceId: string, filePath: string, opts: { speaker?: string; title?: string } = {}): {
  source: Source;
  utteranceCount: number;
} {
  ensureWorkspace(workspaceId);
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = parseTranscript(raw, opts.speaker ?? 'Unknown Speaker');
  if (parsed.length === 0) throw new Error(`No utterances parsed from ${filePath}`);

  const source: Source = {
    id: newId('src'),
    workspaceId,
    kind: 'upload',
    uri: path.resolve(filePath),
    title: opts.title ?? path.basename(filePath),
    recordedAt: null,
    consentBasis: 'uploaded_owner',
  };
  insertSource(source);

  const utterances: Utterance[] = parsed.map((l, i) => ({
    id: newId('utt'),
    sourceId: source.id,
    workspaceId,
    speaker: l.speaker,
    tStartSec: l.tStartSec,
    tEndSec: null,
    text: l.text,
    seq: i,
  }));
  insertUtterances(utterances);
  return { source, utteranceCount: utterances.length };
}
