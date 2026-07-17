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
    admitted: true, // manual transcript upload = deliberate; auto-admit
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
    locator: { kind: 'transcript' },
    provenanceClass: 'human_utterance',
  }));
  insertUtterances(utterances);
  return { source, utteranceCount: utterances.length };
}

// ---------- document ingester (Markdown / plain text) ----------

/** Split markdown/text into heading-anchored, paragraph-bounded segments.
 *  Each segment's locator carries the nearest heading — the doc receipt anchor. */
export function segmentDocument(raw: string): { heading: string | null; text: string }[] {
  const out: { heading: string | null; text: string }[] = [];
  let heading: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join(' ').replace(/\s+/g, ' ').trim();
    if (text.length >= 24) out.push({ heading, text });
    buf = [];
  };
  for (const line of raw.split(/\r?\n/)) {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      flush();
      heading = h[1]!.trim();
    } else if (line.trim() === '') {
      flush();
    } else {
      buf.push(line.trim());
    }
  }
  flush();
  return out;
}

export function ingestDocument(
  workspaceId: string,
  filePath: string,
  opts: { title?: string; admitted?: boolean } = {},
): { source: Source; segmentCount: number } {
  return ingestDocumentText(workspaceId, fs.readFileSync(filePath, 'utf-8'), {
    title: opts.title ?? path.basename(filePath),
    uri: path.resolve(filePath),
    admitted: opts.admitted,
  });
}

/** Persist a document source + its segments. `blocks` carry an optional page/heading
 *  locator anchor (the doc receipt). Shared by the text/PDF/DOCX ingesters. */
function insertDocument(
  workspaceId: string,
  blocks: { heading?: string; page?: number; text: string }[],
  opts: { title?: string; uri?: string; admitted?: boolean },
): { source: Source; segmentCount: number } {
  ensureWorkspace(workspaceId);
  if (blocks.length === 0) throw new Error('No text segments parsed from document');
  const source: Source = {
    id: newId('src'),
    workspaceId,
    kind: 'document',
    uri: opts.uri ?? 'pasted',
    title: opts.title ?? 'Untitled document',
    recordedAt: null,
    consentBasis: 'uploaded_owner',
    admitted: opts.admitted ?? true,
  };
  insertSource(source);
  const rows: Utterance[] = blocks.map((b, i) => ({
    id: newId('seg'),
    sourceId: source.id,
    workspaceId,
    speaker: null,
    tStartSec: null,
    tEndSec: null,
    text: b.text,
    seq: i,
    locator: { kind: 'document', heading: b.heading, page: b.page },
    provenanceClass: 'owned_document',
  }));
  insertUtterances(rows);
  return { source, segmentCount: rows.length };
}

/** Ingest a document from raw text (the web UI pastes text; the CLI reads a file). */
export function ingestDocumentText(
  workspaceId: string,
  raw: string,
  opts: { title?: string; uri?: string; admitted?: boolean } = {},
): { source: Source; segmentCount: number } {
  return insertDocument(workspaceId, segmentDocument(raw).map((s) => ({ heading: s.heading ?? undefined, text: s.text })), opts);
}

/** Route an uploaded file to the right document ingester by extension. */
export async function ingestUploadBuffer(
  workspaceId: string,
  filename: string,
  buffer: Buffer,
  opts: { title?: string; admitted?: boolean } = {},
): Promise<{ source: Source; segmentCount: number }> {
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  const o = { title: opts.title ?? filename, uri: `upload:${filename}`, admitted: opts.admitted };
  if (ext === 'pdf') return ingestPdfBuffer(workspaceId, buffer, o);
  if (ext === 'docx') return ingestDocxBuffer(workspaceId, buffer, o);
  if (ext === 'html' || ext === 'htm') {
    const { blocks } = extractReadable(buffer.toString('utf-8'));
    return insertDocument(workspaceId, blocks.map((b) => ({ heading: b.heading ?? undefined, text: b.text })), o);
  }
  if (ext === 'md' || ext === 'markdown' || ext === 'txt' || ext === '') {
    return ingestDocumentText(workspaceId, buffer.toString('utf-8'), o);
  }
  throw new Error(`Unsupported file type ".${ext}" — supported: pdf, docx, md, txt, html`);
}

/** Ingest a PDF buffer — per-page text with page-numbered locators. */
export async function ingestPdfBuffer(
  workspaceId: string,
  data: Buffer,
  opts: { title?: string; uri?: string; admitted?: boolean } = {},
): Promise<{ source: Source; segmentCount: number }> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data });
  const result = await parser.getText();
  const blocks: { heading?: string; page?: number; text: string }[] = [];
  for (const pg of result.pages ?? []) {
    for (const s of segmentDocument(pg.text)) blocks.push({ heading: s.heading ?? undefined, page: pg.num, text: s.text });
  }
  if (blocks.length === 0) {
    for (const s of segmentDocument(result.text ?? '')) blocks.push({ heading: s.heading ?? undefined, text: s.text });
  }
  return insertDocument(workspaceId, blocks, opts);
}

/** Ingest a DOCX buffer — mammoth → HTML → heading-anchored segments. */
export async function ingestDocxBuffer(
  workspaceId: string,
  buffer: Buffer,
  opts: { title?: string; uri?: string; admitted?: boolean } = {},
): Promise<{ source: Source; segmentCount: number }> {
  const mammoth = await import('mammoth');
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const { blocks } = extractReadable(html);
  return insertDocument(workspaceId, blocks.map((b) => ({ heading: b.heading ?? undefined, text: b.text })), opts);
}

// ---------- web page ingester (external link) ----------

/** SSRF guard: only public http(s); block localhost, private ranges, and non-web schemes. */
export function assertPublicUrl(u: string): URL {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    throw new Error(`Invalid URL: ${u}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed');
  const host = url.hostname;
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error(`Refusing to fetch non-public host: ${host}`);
  }
  return url;
}

/** Strip HTML to readable text + a title. Deliberately simple (no external deps);
 *  drops script/style/nav/header/footer, decodes common entities, keeps headings. */
export function extractReadable(html: string): { title: string | null; blocks: { heading: string | null; text: string }[] } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]!.trim()) : null;
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ');
  // Convert headings/paragraphs to markers, then strip remaining tags.
  body = body
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_m, t) => `\n## ${stripTags(t)}\n`)
    .replace(/<\/(p|div|li|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body);
  return { title, blocks: segmentDocument(text) };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
}

export async function ingestUrl(
  workspaceId: string,
  rawUrl: string,
  opts: { title?: string; admitted?: boolean } = {},
): Promise<{ source: Source; segmentCount: number }> {
  ensureWorkspace(workspaceId);
  const url = assertPublicUrl(rawUrl);
  const res = await fetch(url.toString(), {
    redirect: 'follow',
    headers: { 'User-Agent': 'NovelFusion/0.1 (+content ingester)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  const html = await res.text();
  const { title, blocks } = extractReadable(html);
  if (blocks.length === 0) throw new Error(`No readable text extracted from ${url}`);
  const fetchedAt = new Date().toISOString();
  const source: Source = {
    id: newId('src'),
    workspaceId,
    kind: 'webpage',
    uri: url.toString(),
    title: opts.title ?? title ?? url.hostname,
    recordedAt: null,
    consentBasis: 'public',
    admitted: opts.admitted ?? true,
  };
  insertSource(source);
  const rows: Utterance[] = blocks.map((b, i) => ({
    id: newId('seg'),
    sourceId: source.id,
    workspaceId,
    speaker: null,
    tStartSec: null,
    tEndSec: null,
    text: b.text,
    seq: i,
    locator: { kind: 'webpage', url: url.toString(), anchor: b.heading ?? undefined, fetchedAt },
    provenanceClass: 'public_web',
  }));
  insertUtterances(rows);
  return { source, segmentCount: rows.length };
}
