// Canvas infographics for the fusion-video generator — each storyboard scene rendered to a PNG with
// @napi-rs/canvas (headless Skia, no browser). Pure + deterministic (given a scene): unit-testable,
// no DB, no network. This is the "creative rendering" layer; motion (ken-burns, fades) is added at
// the ffmpeg stage. Design system: dark gradient stage + a rotating accent from the validated
// dataviz palette, big typography, simple bar charts, progress dots.

import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { StoryboardScene } from '../domain/types.js';

const PALETTE = ['#2a78d6', '#008300', '#e87ba4', '#eda100']; // validated 4-slot dataviz palette
const INK = '#f4f6fb';
const MUTED = '#9aa4bd';

export interface SceneCtx {
  width: number;
  height: number;
  index: number;
  total: number;
  brand?: string;
}

const accentFor = (i: number) => PALETTE[i % PALETTE.length]!;

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Greedy word-wrap to a max width; returns the lines. */
function wrap(ctx: SKRSContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(test).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function background(ctx: SKRSContext2D, w: number, h: number, accent: string) {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#0a0e1a');
  g.addColorStop(1, '#141d33');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // accent glow, top-right
  const glow = ctx.createRadialGradient(w * 0.82, h * 0.12, 0, w * 0.82, h * 0.12, w * 0.5);
  glow.addColorStop(0, accent + '33');
  glow.addColorStop(1, '#00000000');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
}

function eyebrow(ctx: SKRSContext2D, sc: SceneCtx, accent: string, pad: number) {
  ctx.fillStyle = accent;
  ctx.font = `600 ${Math.round(sc.width * 0.018)}px Sans`;
  ctx.textBaseline = 'alphabetic';
  const label = `${sc.brand ? sc.brand.toUpperCase() + '  ·  ' : ''}${String(sc.index + 1).padStart(2, '0')} / ${String(sc.total).padStart(2, '0')}`;
  ctx.fillText(label, pad, pad + sc.width * 0.02);
}

function progressDots(ctx: SKRSContext2D, sc: SceneCtx, accent: string, pad: number) {
  const y = sc.height - pad * 0.7;
  const r = Math.max(3, sc.width * 0.004);
  const gap = r * 4;
  const startX = pad;
  for (let i = 0; i < sc.total; i++) {
    ctx.beginPath();
    ctx.arc(startX + i * gap, y, r, 0, Math.PI * 2);
    ctx.fillStyle = i === sc.index ? accent : '#ffffff22';
    ctx.fill();
  }
}

/** Render one scene to a PNG buffer. */
export function renderScene(scene: StoryboardScene, sc: SceneCtx): Buffer {
  const { width: w, height: h } = sc;
  const accent = accentFor(sc.index);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const pad = Math.round(w * 0.07);
  const contentW = w - pad * 2;

  background(ctx, w, h, accent);
  eyebrow(ctx, sc, accent, pad);

  // Title (all scene types get a headline).
  ctx.fillStyle = INK;
  ctx.textBaseline = 'top';
  const titleSize = Math.round(w * (scene.visual === 'title' ? 0.062 : 0.05));
  ctx.font = `700 ${titleSize}px Sans`;
  const titleLines = wrap(ctx, scene.title || '', contentW).slice(0, 3);
  let y = pad + titleSize * 1.4;
  for (const line of titleLines) {
    ctx.fillText(line, pad, y);
    y += titleSize * 1.15;
  }
  // accent underline
  ctx.fillStyle = accent;
  roundRect(ctx, pad, y + titleSize * 0.15, Math.min(contentW, w * 0.22), Math.max(4, w * 0.006), 4);
  ctx.fill();
  y += titleSize * 0.6;

  const bodyTop = y + w * 0.03;
  const bodySize = Math.round(w * 0.026);

  if (scene.visual === 'title') {
    if (scene.subtitle) {
      ctx.fillStyle = MUTED;
      ctx.font = `400 ${Math.round(w * 0.03)}px Sans`;
      let yy = bodyTop;
      for (const line of wrap(ctx, scene.subtitle, contentW).slice(0, 4)) {
        ctx.fillText(line, pad, yy);
        yy += w * 0.042;
      }
    }
  } else if (scene.visual === 'bullets') {
    let yy = bodyTop;
    ctx.font = `500 ${bodySize}px Sans`;
    for (const b of (scene.bullets ?? []).slice(0, 5)) {
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(pad + bodySize * 0.4, yy + bodySize * 0.55, bodySize * 0.28, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = INK;
      const lines = wrap(ctx, b, contentW - bodySize * 1.6);
      for (const line of lines) {
        ctx.fillText(line, pad + bodySize * 1.4, yy);
        yy += bodySize * 1.35;
      }
      yy += bodySize * 0.5;
    }
  } else if (scene.visual === 'stat') {
    const val = scene.stat?.value ?? '';
    ctx.fillStyle = accent;
    const statSize = Math.round(w * 0.14);
    ctx.font = `800 ${statSize}px Sans`;
    ctx.fillText(val, pad, bodyTop);
    ctx.fillStyle = MUTED;
    ctx.font = `400 ${Math.round(w * 0.028)}px Sans`;
    let yy = bodyTop + statSize * 1.1;
    for (const line of wrap(ctx, scene.stat?.label ?? '', contentW).slice(0, 3)) {
      ctx.fillText(line, pad, yy);
      yy += w * 0.04;
    }
  } else if (scene.visual === 'quote') {
    ctx.fillStyle = accent;
    ctx.font = `700 ${Math.round(w * 0.12)}px Georgia`;
    ctx.fillText('“', pad, bodyTop - w * 0.02);
    ctx.fillStyle = INK;
    ctx.font = `italic 600 ${Math.round(w * 0.038)}px Georgia`;
    let yy = bodyTop + w * 0.06;
    for (const line of wrap(ctx, scene.quote?.text ?? '', contentW).slice(0, 5)) {
      ctx.fillText(line, pad, yy);
      yy += w * 0.052;
    }
    if (scene.quote?.attribution) {
      ctx.fillStyle = MUTED;
      ctx.font = `500 ${Math.round(w * 0.024)}px Sans`;
      ctx.fillText(`— ${scene.quote.attribution}`, pad, yy + w * 0.02);
    }
  } else if (scene.visual === 'chart') {
    const bars = (scene.chart?.bars ?? []).slice(0, 6);
    const max = Math.max(1, ...bars.map((b) => b.value));
    const chartTop = bodyTop;
    const rowH = Math.min(w * 0.07, (h - chartTop - pad * 1.6) / Math.max(1, bars.length));
    const barMaxW = contentW * 0.62;
    const labelW = contentW * 0.3;
    ctx.textBaseline = 'middle';
    bars.forEach((b, i) => {
      const cy = chartTop + i * rowH + rowH * 0.5;
      ctx.fillStyle = MUTED;
      ctx.font = `500 ${Math.round(w * 0.02)}px Sans`;
      ctx.fillText(b.label.slice(0, 22), pad, cy);
      const bw = Math.max(6, (b.value / max) * barMaxW);
      const bx = pad + labelW;
      const bh = rowH * 0.5;
      const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
      grad.addColorStop(0, accentFor(i));
      grad.addColorStop(1, accentFor(i) + 'bb');
      ctx.fillStyle = grad;
      roundRect(ctx, bx, cy - bh / 2, bw, bh, bh / 2);
      ctx.fill();
      ctx.fillStyle = INK;
      ctx.font = `700 ${Math.round(w * 0.02)}px Sans`;
      ctx.fillText(`${b.value}${scene.chart?.unit ?? ''}`, bx + bw + w * 0.012, cy);
    });
    ctx.textBaseline = 'top';
  }

  progressDots(ctx, sc, accent, pad);
  return canvas.toBuffer('image/png');
}
