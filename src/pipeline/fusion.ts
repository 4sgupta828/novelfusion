// EXPERIMENTAL fusion-video generator (ngram-style). A talk / transcript / moment →
//   1. an LLM STORYBOARD (scenes: narration + on-screen visual),
//   2. per scene a canvas INFOGRAPHIC (fusion-visuals.ts) + an OpenAI TTS VOICEOVER,
//   3. ffmpeg assembly (ken-burns + fades per scene, then concat) → a final mp4.
// Synthetic by design (generated visuals + AI voice) — this is the creative/experimental path, NOT
// the provenance-clean clip_renders path, and it is NOT consent-gated. Behind NF_FLAG_FUSION_VIDEO.
//
// Rule 15 (subprocess + network): ffmpeg via execFile with argument ARRAYS (never a shell string);
// all files are process-generated random paths under our own dirs; TTS goes through the OpenAI
// chokepoint. Rule 18: the LLM owns the storyboard (meaning); code owns assembly (structure).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod/v4';
import { structured } from '../llm/client.js';
import { synthesizeSpeech, type TtsVoice } from '../llm/openai.js';
import { renderScene } from './fusion-visuals.js';
import {
  getTalkProposal,
  getTalkKit,
  getMoment,
  getUtterancesByIds,
  listUtterances,
  insertFusionVideo,
} from '../db/index.js';
import type { ClipFormat, StoryboardScene, FusionVideo, Utterance } from '../domain/types.js';

const exec = promisify(execFile);
const DIMS: Record<ClipFormat, [number, number]> = { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [1080, 1080] };
const FUSION_DIR = path.join(process.cwd(), 'data', 'fusion');
const FPS = 30;
const TAIL_SEC = 0.5;
const MIN_SCENE = 2.5;
const MAX_SCENE = 14;
const MAX_INPUT_CHARS = 14000;

export class FusionError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const SceneSchema = z.object({
  narration: z.string().describe('what the VOICEOVER says for this scene — 1–3 natural spoken sentences. This is heard, not shown.'),
  visual: z.enum(['title', 'bullets', 'stat', 'quote', 'chart']).describe('what SHOWS on screen'),
  title: z.string().describe('short on-screen headline (a few words)'),
  subtitle: z.string().optional().describe('title scenes only: one supporting line'),
  bullets: z.array(z.string()).optional().describe('bullets scenes: 2–5 SHORT phrases (not sentences)'),
  stat: z.object({ value: z.string(), label: z.string() }).optional().describe('stat scenes: a big number/value + its label'),
  quote: z.object({ text: z.string(), attribution: z.string().optional() }).optional().describe('quote scenes: a punchy line + who said it'),
  chart: z.object({ unit: z.string().optional(), bars: z.array(z.object({ label: z.string(), value: z.number() })).min(2).max(6) }).optional().describe('chart scenes: 2–6 labeled bars'),
});
const StoryboardSchema = z.object({
  title: z.string().describe('the video title'),
  scenes: z.array(SceneSchema).min(4).max(8),
});

const SYSTEM = `You are a video director turning source material into a punchy, narrated explainer STORYBOARD (think a sharp 60–90s social explainer). Output scenes; each has VOICEOVER narration (heard) and an on-screen VISUAL (seen) — they complement each other, they are not the same text.

Rules:
- Open with a 'title' scene and build an arc: hook → 2–5 substance scenes → a closing takeaway.
- Vary the visuals: use 'stat' for a number that lands, 'chart' when there are 2–6 comparable values, 'bullets' for a short list (SHORT phrases, not sentences), 'quote' for a punchy line, 'title' for the open/close.
- Narration is spoken: natural, energetic, concise. On-screen text is terse: headlines and keywords, never paragraphs.
- Ground it in the source material — use its real claims, numbers, and language. Do not invent statistics; only use a 'stat'/'chart' value if the material supports it.
- 4–8 scenes total. Every scene must have narration and a title.`;

type WsUtterance = Utterance & { workspaceId: string };
const sampleText = (utts: WsUtterance[]) => {
  let chars = 0;
  const out: string[] = [];
  for (const u of utts) {
    if (chars + u.text.length > MAX_INPUT_CHARS) break;
    out.push(`${u.speaker ? u.speaker + ': ' : ''}${u.text}`);
    chars += u.text.length;
  }
  return out.join('\n');
};

/** Gather the source material + a default title for the storyboard. */
function gatherMaterial(workspaceId: string, opts: RenderFusionOpts): { origin: string; originId: string | null; title: string; material: string } {
  if (opts.talkId) {
    const t = getTalkProposal(workspaceId, opts.talkId);
    if (!t) throw new FusionError('not_found', 'Talk not found.');
    const kit = getTalkKit(workspaceId, opts.talkId);
    const outline = t.outline.map((s) => `- ${s.title}: ${s.summary}`).join('\n');
    const points = kit ? '\n\nDeveloped points:\n' + kit.segments.flatMap((s) => s.points.filter((p) => p.zone === 'sourced').map((p) => `• ${p.text}`)).join('\n') : '';
    return { origin: 'talk', originId: t.id, title: t.title, material: `TALK: ${t.title}\nGOAL: ${t.goal} — ${t.outcome}\nTHESIS: ${t.thesis}\nAUDIENCE: ${t.audience}\n\nOUTLINE:\n${outline}${points}`.slice(0, MAX_INPUT_CHARS) };
  }
  if (opts.momentId) {
    const m = getMoment(workspaceId, opts.momentId);
    if (!m) throw new FusionError('not_found', 'Moment not found.');
    const receipts = sampleText(getUtterancesByIds(workspaceId, m.utteranceIds) as WsUtterance[]);
    return { origin: 'moment', originId: m.id, title: m.claim.slice(0, 80), material: `CLAIM: ${m.claim}\nWHY NOW: ${m.judgment.whyNow}\n\nSOURCE:\n${receipts}` };
  }
  if (opts.sourceId) {
    const utts = listUtterances(workspaceId, opts.sourceId, { admittedOnly: true }) as WsUtterance[];
    if (utts.length === 0) throw new FusionError('no_material', 'That source has no passages.');
    return { origin: 'source', originId: opts.sourceId, title: utts[0]?.sourceTitle || 'Untitled', material: `TRANSCRIPT:\n${sampleText(utts)}` };
  }
  throw new FusionError('no_input', 'Provide a talkId, momentId, or sourceId to generate a fusion video.');
}

async function probeDuration(file: string): Promise<number> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return parseFloat(stdout.trim()) || 0;
}

export interface RenderFusionOpts {
  talkId?: string;
  momentId?: string;
  sourceId?: string;
  voice?: TtsVoice;
  format?: ClipFormat;
}

/** Generate an experimental fusion video. Throws FusionError on bad input; OpenAI/ffmpeg errors
 *  propagate (the caller reports a failed render). */
export async function renderFusionVideo(workspaceId: string, opts: RenderFusionOpts): Promise<FusionVideo> {
  const voice: TtsVoice = opts.voice ?? 'alloy';
  const format: ClipFormat = opts.format ?? '16:9';
  const [w, h] = DIMS[format];
  const { origin, originId, title: defaultTitle, material } = gatherMaterial(workspaceId, opts);

  // 1. Storyboard.
  const board = await structured({
    stage: 'fusion-storyboard',
    system: SYSTEM,
    user: `Create a storyboard from this material:\n\n${material}`,
    schema: StoryboardSchema,
    maxTokens: 6000,
  });
  const scenes: StoryboardScene[] = board.scenes;
  if (scenes.length === 0) throw new FusionError('empty_storyboard', 'The storyboard came back empty.');

  fs.mkdirSync(FUSION_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-fusion-'));
  try {
    // 2. Per scene: infographic PNG + TTS voiceover → a scene clip.
    const sceneFiles: string[] = [];
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i]!;
      const png = path.join(tmp, `s${i}.png`);
      fs.writeFileSync(png, renderScene(scene, { width: w, height: h, index: i, total: scenes.length, brand: 'NovelFusion' }));

      const mp3 = path.join(tmp, `s${i}.mp3`);
      fs.writeFileSync(mp3, await synthesizeSpeech(scene.narration, voice));
      const dur = Math.min(MAX_SCENE, Math.max(MIN_SCENE, (await probeDuration(mp3)) + TAIL_SEC));

      const clip = path.join(tmp, `s${i}.mp4`);
      const frames = Math.round(dur * FPS);
      const fadeOut = Math.max(0, dur - 0.4);
      await exec('ffmpeg', [
        '-y', '-loop', '1', '-i', png, '-i', mp3,
        '-filter_complex', `[0:v]scale=${w}:${h},zoompan=z='min(zoom+0.0007,1.12)':d=${frames}:s=${w}x${h}:fps=${FPS},fade=t=in:st=0:d=0.4,fade=t=out:st=${fadeOut}:d=0.4,format=yuv420p[v]`,
        '-map', '[v]', '-map', '1:a', '-af', 'apad', '-t', String(dur),
        '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', clip,
      ], { maxBuffer: 1 << 27 });
      sceneFiles.push(clip);
    }

    // 3. Concat the scene clips (identical params → stream copy).
    const listFile = path.join(tmp, 'list.txt');
    fs.writeFileSync(listFile, sceneFiles.map((f) => `file '${f}'`).join('\n') + '\n');
    const outName = `${randomBytes(9).toString('hex')}.mp4`;
    const outFile = path.join(FUSION_DIR, outName);
    await exec('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', outFile], { maxBuffer: 1 << 27 });

    const durationSec = await probeDuration(outFile);
    const size = fs.statSync(outFile).size;
    return insertFusionVideo({
      workspaceId, title: board.title || defaultTitle, origin, originId, voice, format,
      scenes, durationSec, filename: outName, filePath: path.relative(process.cwd(), outFile), mime: 'video/mp4', size,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Absolute path to a fusion video's file (for streaming); null if gone. */
export function fusionFileAbsPath(v: FusionVideo): string | null {
  const abs = path.resolve(process.cwd(), v.filePath);
  return fs.existsSync(abs) ? abs : null;
}
