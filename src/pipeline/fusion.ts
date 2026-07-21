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
import { synthesizeSpeech, type TtsVoice, type TtsModel } from '../llm/openai.js';
import { renderSceneFrame, SCENE_ANIM_SEC } from './fusion-visuals.js';
import {
  getTalkProposal,
  getTalkKit,
  getMoment,
  getUtterancesByIds,
  listUtterances,
  insertFusionVideo,
} from '../db/index.js';
import type { ClipFormat, StoryboardScene, FusionVideo, FusionTheme, Utterance } from '../domain/types.js';

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
  visual: z.enum(['title', 'bullets', 'stat', 'quote', 'chart', 'comparison', 'timeline', 'bignumbers', 'donut']).describe('what SHOWS on screen — pick the type that best fits the content'),
  title: z.string().describe('short on-screen headline (a few words)'),
  subtitle: z.string().optional().describe('title scenes only: one supporting line'),
  bullets: z.array(z.string()).optional().describe('bullets scenes: 2–5 SHORT phrases (not sentences)'),
  stat: z.object({ value: z.string(), label: z.string() }).optional().describe('stat scenes: ONE big number/value + its label'),
  quote: z.object({ text: z.string(), attribution: z.string().optional() }).optional().describe('quote scenes: a punchy line + who said it'),
  chart: z.object({ unit: z.string().optional(), bars: z.array(z.object({ label: z.string(), value: z.number() })).min(2).max(6) }).optional().describe('chart scenes: 2–6 labeled bars'),
  comparison: z.object({ left: z.object({ heading: z.string(), items: z.array(z.string()).min(1).max(4) }), right: z.object({ heading: z.string(), items: z.array(z.string()).min(1).max(4) }) }).optional().describe('comparison scenes: two sides (e.g. old vs new, us vs them)'),
  timeline: z.object({ steps: z.array(z.object({ label: z.string(), detail: z.string().optional() })).min(2).max(5) }).optional().describe('timeline scenes: an ordered sequence of steps'),
  bignumbers: z.object({ items: z.array(z.object({ value: z.string(), label: z.string() })).min(2).max(4) }).optional().describe('bignumbers scenes: 2–4 headline stats in a grid'),
  donut: z.object({ value: z.number().min(0).max(100), label: z.string(), unit: z.string().optional() }).optional().describe('donut scenes: ONE percentage (0–100) as a ring + label'),
});
const StoryboardSchema = z.object({
  title: z.string().describe('the video title'),
  scenes: z.array(SceneSchema).min(4).max(9),
});

const SYSTEM = `You are a world-class video director turning source material into a punchy, narrated explainer STORYBOARD (a sharp 45–90s social explainer). Output scenes; each has VOICEOVER narration (heard) and an on-screen VISUAL (seen) — they complement each other, they are not the same text.

The on-screen visual TYPES available — use a RICH VARIETY, pick each for its content:
- title: open/close hero — a headline + one supporting line.
- bullets: 2–5 SHORT key phrases (not sentences).
- stat: ONE big number that lands (e.g. "95%").
- bignumbers: 2–4 headline numbers side by side.
- chart: 2–6 comparable values as bars.
- donut: ONE percentage (0–100) as a ring.
- comparison: two sides — old vs new, us vs them, before/after.
- timeline: an ordered sequence of 2–5 steps.
- quote: a punchy line + who said it.

Rules:
- Open with a 'title' hook and build an arc → substance scenes → a closing takeaway ('title'). VARY the visual types across the arc; don't repeat one type back-to-back.
- Narration is spoken: natural, energetic, concise. On-screen text is terse: headlines and keywords, never paragraphs.
- Ground it in the source material — use its real claims, numbers, and language. Do not invent statistics; only use stat/chart/donut/bignumbers values the material actually supports. If there are no real numbers, prefer bullets/comparison/timeline/quote over inventing figures.
- 4–9 scenes. Every scene must have narration and a title, plus the field for its chosen visual type.`;

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

export type Transition = 'fade' | 'crossfade' | 'cut';
export type Motion = 'kenburns' | 'static';

export interface RenderFusionOpts {
  talkId?: string;
  momentId?: string;
  sourceId?: string;
  voice?: TtsVoice;
  voiceModel?: TtsModel;
  voiceInstructions?: string;
  speed?: number;
  theme?: FusionTheme;
  format?: ClipFormat;
  transition?: Transition;
  motion?: Motion;
  captions?: boolean;
  tone?: string;
}

const XFADE = 0.5; // crossfade overlap seconds
// subtitles filter path escaping (colons/backslashes/quotes) — our paths are random hex, escape defensively
const escFilter = (p: string) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
// outlined captions (readable on any theme, light or dark), modest size, docked near the bottom
const CAPTION_STYLE = "force_style='Alignment=2,FontSize=13,MarginV=44,MarginL=60,MarginR=60,PrimaryColour=&H00FFFFFF,OutlineColour=&HCC000000,BorderStyle=1,Outline=2,Shadow=1'";

const srtTime = (s: number) => {
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60), ms = Math.round((s - Math.floor(s)) * 1000);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)},${p(ms, 3)}`;
};

/** Generate an experimental fusion video. Throws FusionError on bad input; OpenAI/ffmpeg errors
 *  propagate (the caller reports a failed render). */
export async function renderFusionVideo(workspaceId: string, opts: RenderFusionOpts): Promise<FusionVideo> {
  const voice: TtsVoice = opts.voice ?? 'alloy';
  const theme: FusionTheme = opts.theme ?? 'midnight';
  const format: ClipFormat = opts.format ?? '16:9';
  const transition: Transition = opts.transition ?? 'fade';
  void (opts.motion); // motion kept in the API for compat; the animated frame path is the motion now
  const captions = opts.captions ?? false;
  const [w, h] = DIMS[format];
  const { origin, originId, title: defaultTitle, material } = gatherMaterial(workspaceId, opts);

  // 1. Storyboard.
  const toneLine = opts.tone ? `\n\nTONE: make the narration and framing feel ${opts.tone}.` : '';
  const board = await structured({
    stage: 'fusion-storyboard',
    system: SYSTEM,
    user: `Create a storyboard from this material:\n\n${material}${toneLine}`,
    schema: StoryboardSchema,
    maxTokens: 7000,
  });
  const scenes: StoryboardScene[] = board.scenes;
  if (scenes.length === 0) throw new FusionError('empty_storyboard', 'The storyboard came back empty.');

  fs.mkdirSync(FUSION_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-fusion-'));
  try {
    // 2. Per scene: infographic PNG + TTS voiceover → a scene clip.
    const sceneFiles: string[] = [];
    const durations: number[] = [];
    const perSceneFades = transition === 'fade'; // crossfade/cut clips carry no built-in fades
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i]!;
      const mp3 = path.join(tmp, `s${i}.mp3`);
      fs.writeFileSync(mp3, await synthesizeSpeech(scene.narration, { voice, model: opts.voiceModel, instructions: opts.voiceInstructions, speed: opts.speed }));
      const dur = Math.min(MAX_SCENE, Math.max(MIN_SCENE, (await probeDuration(mp3)) + TAIL_SEC));
      durations.push(dur);

      // Render the scene as an ANIMATED frame sequence — but only the ENTRANCE frames (the draw is
      // identical once animations settle). ffmpeg's tpad then freeze-clones the last frame for the
      // hold, so we write ~SCENE_ANIM_SEC×fps PNGs per scene instead of the full duration.
      const frameDir = path.join(tmp, `s${i}`);
      fs.mkdirSync(frameDir, { recursive: true });
      const sceneCtx = { width: w, height: h, index: i, total: scenes.length, theme, brand: 'NovelFusion' } as const;
      const totalFrames = Math.round(dur * FPS);
      const animFrames = Math.min(totalFrames - 1, Math.round(SCENE_ANIM_SEC * FPS));
      for (let f = 0; f <= animFrames; f++) {
        fs.writeFileSync(path.join(frameDir, `f_${String(f).padStart(5, '0')}.png`), renderSceneFrame(scene, sceneCtx, f / FPS));
      }
      const holdSec = Math.max(0, dur - (animFrames + 1) / FPS);

      const fadeOut = Math.max(0, dur - 0.4);
      // Internal element animation IS the motion (no ffmpeg ken-burns on the animated path). tpad
      // holds the settled frame for the remainder of the scene.
      let vf = `[0:v]fps=${FPS},tpad=stop_mode=clone:stop_duration=${holdSec.toFixed(3)}`;
      if (perSceneFades) vf += `,fade=t=in:st=0:d=0.4,fade=t=out:st=${fadeOut}:d=0.4`;
      if (captions) {
        const srt = path.join(tmp, `s${i}.srt`);
        fs.writeFileSync(srt, `1\n${srtTime(0)} --> ${srtTime(dur)}\n${scene.narration.replace(/\r?\n/g, ' ').trim()}\n`);
        vf += `,subtitles='${escFilter(srt)}':${CAPTION_STYLE}`;
      }
      vf += `,format=yuv420p[v]`;

      const clip = path.join(tmp, `s${i}.mp4`);
      await exec('ffmpeg', [
        '-y', '-framerate', String(FPS), '-i', path.join(frameDir, 'f_%05d.png'), '-i', mp3,
        '-filter_complex', vf,
        '-map', '[v]', '-map', '1:a', '-af', 'apad', '-t', String(dur),
        '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', clip,
      ], { maxBuffer: 1 << 27 });
      sceneFiles.push(clip);
    }

    // 3. Assemble.
    const outName = `${randomBytes(9).toString('hex')}.mp4`;
    const outFile = path.join(FUSION_DIR, outName);
    if (transition === 'crossfade' && sceneFiles.length > 1) {
      // xfade video + acrossfade audio, chained with accumulating offsets.
      const inputs: string[] = [];
      for (const f of sceneFiles) inputs.push('-i', f);
      const vparts: string[] = [];
      const aparts: string[] = [];
      let vlabel = '[0:v]';
      let alabel = '[0:a]';
      let prevLen = durations[0]!;
      for (let k = 1; k < sceneFiles.length; k++) {
        const offset = Math.max(0, prevLen - XFADE);
        const vout = k === sceneFiles.length - 1 ? '[v]' : `[v${k}]`;
        const aout = k === sceneFiles.length - 1 ? '[a]' : `[a${k}]`;
        vparts.push(`${vlabel}[${k}:v]xfade=transition=fade:duration=${XFADE}:offset=${offset.toFixed(3)}${vout}`);
        aparts.push(`${alabel}[${k}:a]acrossfade=d=${XFADE}${aout}`);
        vlabel = vout; alabel = aout;
        prevLen = prevLen + durations[k]! - XFADE;
      }
      await exec('ffmpeg', ['-y', ...inputs, '-filter_complex', [...vparts, ...aparts].join(';'),
        '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', outFile], { maxBuffer: 1 << 27 });
    } else {
      // fade / cut: concat demuxer (identical params → stream copy).
      const listFile = path.join(tmp, 'list.txt');
      fs.writeFileSync(listFile, sceneFiles.map((f) => `file '${f}'`).join('\n') + '\n');
      await exec('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', outFile], { maxBuffer: 1 << 27 });
    }

    const durationSec = await probeDuration(outFile);
    const size = fs.statSync(outFile).size;
    return insertFusionVideo({
      workspaceId, title: board.title || defaultTitle, origin, originId, voice, theme, format,
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
