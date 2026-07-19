// Canvas infographics for the fusion-video generator — each storyboard scene rendered to a PNG with
// @napi-rs/canvas (headless Skia, no browser). Pure + deterministic: unit-testable, no DB/network.
// This is the "creative rendering" layer; motion (ken-burns, transitions) is added at the ffmpeg
// stage. Themed (5 looks) and multi-format (16:9 / 9:16 / 1:1). Scene types: title, bullets, stat,
// quote, chart, comparison, timeline, bignumbers, donut.

import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { StoryboardScene, FusionTheme } from '../domain/types.js';

interface Theme {
  mode: 'dark' | 'light';
  palette: string[]; // accent colors, rotated per scene
  ink: string;
  muted: string;
  panel: string; // translucent panel fill
  titleFace: string;
  bodyFace: string;
  titleWeight: number;
  bg(ctx: SKRSContext2D, w: number, h: number, accent: string): void;
}

function linearBg(stops: [number, string][]) {
  return (ctx: SKRSContext2D, w: number, h: number) => {
    const g = ctx.createLinearGradient(0, 0, w, h);
    for (const [o, c] of stops) g.addColorStop(o, c);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  };
}
function glow(ctx: SKRSContext2D, w: number, h: number, accent: string, cx = 0.82, cy = 0.12, a = '33') {
  const gl = ctx.createRadialGradient(w * cx, h * cy, 0, w * cx, h * cy, w * 0.55);
  gl.addColorStop(0, accent + a);
  gl.addColorStop(1, '#00000000');
  ctx.fillStyle = gl;
  ctx.fillRect(0, 0, w, h);
}

const THEMES: Record<FusionTheme, Theme> = {
  midnight: {
    mode: 'dark', palette: ['#2a78d6', '#008300', '#e87ba4', '#eda100'], ink: '#f4f6fb', muted: '#9aa4bd', panel: '#ffffff10',
    titleFace: 'Sans', bodyFace: 'Sans', titleWeight: 700,
    bg(ctx, w, h, accent) { linearBg([[0, '#0a0e1a'], [1, '#141d33']])(ctx, w, h); glow(ctx, w, h, accent); },
  },
  aurora: {
    mode: 'dark', palette: ['#7c5cff', '#22d3ee', '#f472b6', '#34d399'], ink: '#f5f3ff', muted: '#a9a6c9', panel: '#ffffff12',
    titleFace: 'Sans', bodyFace: 'Sans', titleWeight: 800,
    bg(ctx, w, h, accent) { linearBg([[0, '#0d0a1f'], [1, '#1a1140']])(ctx, w, h); glow(ctx, w, h, accent, 0.85, 0.1, '3a'); glow(ctx, w, h, '#22d3ee', 0.1, 0.9, '22'); },
  },
  editorial: {
    mode: 'light', palette: ['#b5432f', '#2f5d50', '#c98a1a', '#3d3a34'], ink: '#211d18', muted: '#6b6459', panel: '#00000008',
    titleFace: 'Georgia', bodyFace: 'Sans', titleWeight: 700,
    bg(ctx, w, h) { linearBg([[0, '#f7f2e8'], [1, '#efe7d6']])(ctx, w, h); },
  },
  noir: {
    mode: 'dark', palette: ['#f4c752', '#e5e5e5', '#f4c752', '#e5e5e5'], ink: '#f5f5f5', muted: '#8a8a8a', panel: '#ffffff0d',
    titleFace: 'Sans', bodyFace: 'Sans', titleWeight: 800,
    bg(ctx, w, h) { linearBg([[0, '#0a0a0a'], [1, '#161616']])(ctx, w, h); },
  },
  sunrise: {
    mode: 'dark', palette: ['#ffd166', '#ffffff', '#4cc9f0', '#ffe8a3'], ink: '#fff8ef', muted: '#ffe0c4', panel: '#ffffff1a',
    titleFace: 'Sans', bodyFace: 'Sans', titleWeight: 800,
    bg(ctx, w, h) { linearBg([[0, '#ff5f6d'], [0.55, '#ff7a45'], [1, '#c9184a']])(ctx, w, h); glow(ctx, w, h, '#ffd166', 0.8, 0.15, '55'); },
  },
};

export interface SceneCtx {
  width: number;
  height: number;
  index: number;
  total: number;
  theme: FusionTheme;
  brand?: string;
}

// ---------- primitives ----------

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function wrap(ctx: SKRSContext2D, text: string, maxW: number): string[] {
  const words = (text || '').split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const test = cur ? `${cur} ${word}` : word;
    if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = word; } else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}

// ---------- render ----------

export function renderScene(scene: StoryboardScene, sc: SceneCtx): Buffer {
  const { width: w, height: h } = sc;
  const th = THEMES[sc.theme] ?? THEMES.midnight;
  const accent = th.palette[sc.index % th.palette.length]!;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const pad = Math.round(w * 0.07);
  const contentW = w - pad * 2;

  th.bg(ctx, w, h, accent);

  // eyebrow
  ctx.fillStyle = accent;
  ctx.font = `600 ${Math.round(w * 0.018)}px ${th.bodyFace}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${sc.brand ? sc.brand.toUpperCase() + '  ·  ' : ''}${String(sc.index + 1).padStart(2, '0')} / ${String(sc.total).padStart(2, '0')}`, pad, pad + w * 0.02);

  // title (all scenes)
  ctx.textBaseline = 'top';
  ctx.fillStyle = th.ink;
  const titleSize = Math.round(w * (scene.visual === 'title' ? 0.062 : 0.048));
  ctx.font = `${th.titleWeight} ${titleSize}px ${th.titleFace}`;
  let y = pad + titleSize * 1.3;
  for (const line of wrap(ctx, scene.title, contentW).slice(0, 3)) { ctx.fillText(line, pad, y); y += titleSize * 1.14; }
  ctx.fillStyle = accent;
  roundRect(ctx, pad, y + titleSize * 0.12, Math.min(contentW, w * 0.22), Math.max(4, w * 0.006), 4);
  ctx.fill();
  const bodyTop = y + titleSize * 0.7 + w * 0.03;
  const bodyW = contentW;

  const drawList = (items: string[], top: number, x: number, colW: number, accentColor: string, max = 5) => {
    let yy = top;
    const size = Math.round(w * 0.024);
    ctx.font = `500 ${size}px ${th.bodyFace}`;
    for (const b of (items ?? []).slice(0, max)) {
      ctx.fillStyle = accentColor;
      ctx.beginPath();
      ctx.arc(x + size * 0.35, yy + size * 0.55, size * 0.26, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = th.ink;
      for (const line of wrap(ctx, b, colW - size * 1.5)) { ctx.fillText(line, x + size * 1.3, yy); yy += size * 1.3; }
      yy += size * 0.5;
    }
  };

  switch (scene.visual) {
    case 'title':
      if (scene.subtitle) {
        ctx.fillStyle = th.muted;
        ctx.font = `400 ${Math.round(w * 0.03)}px ${th.bodyFace}`;
        let yy = bodyTop;
        for (const line of wrap(ctx, scene.subtitle, bodyW).slice(0, 4)) { ctx.fillText(line, pad, yy); yy += w * 0.042; }
      }
      break;
    case 'bullets':
      drawList(scene.bullets ?? [], bodyTop, pad, bodyW, accent);
      break;
    case 'stat': {
      ctx.fillStyle = accent;
      const statSize = Math.round(w * 0.14);
      ctx.font = `800 ${statSize}px ${th.titleFace}`;
      ctx.fillText(scene.stat?.value ?? '', pad, bodyTop);
      ctx.fillStyle = th.muted;
      ctx.font = `400 ${Math.round(w * 0.028)}px ${th.bodyFace}`;
      let yy = bodyTop + statSize * 1.05;
      for (const line of wrap(ctx, scene.stat?.label ?? '', bodyW).slice(0, 3)) { ctx.fillText(line, pad, yy); yy += w * 0.04; }
      break;
    }
    case 'quote': {
      ctx.fillStyle = accent;
      ctx.font = `700 ${Math.round(w * 0.12)}px Georgia`;
      ctx.fillText('“', pad, bodyTop - w * 0.02);
      ctx.fillStyle = th.ink;
      ctx.font = `italic 600 ${Math.round(w * 0.038)}px Georgia`;
      let yy = bodyTop + w * 0.06;
      for (const line of wrap(ctx, scene.quote?.text ?? '', bodyW).slice(0, 5)) { ctx.fillText(line, pad, yy); yy += w * 0.052; }
      if (scene.quote?.attribution) {
        ctx.fillStyle = th.muted;
        ctx.font = `500 ${Math.round(w * 0.024)}px ${th.bodyFace}`;
        ctx.fillText(`— ${scene.quote.attribution}`, pad, yy + w * 0.02);
      }
      break;
    }
    case 'chart': {
      const bars = (scene.chart?.bars ?? []).slice(0, 6);
      const max = Math.max(1, ...bars.map((b) => b.value));
      const rowH = Math.min(w * 0.07, (h - bodyTop - pad * 1.6) / Math.max(1, bars.length));
      const barMaxW = bodyW * 0.6;
      const labelW = bodyW * 0.3;
      ctx.textBaseline = 'middle';
      bars.forEach((b, i) => {
        const cy = bodyTop + i * rowH + rowH * 0.5;
        ctx.fillStyle = th.muted;
        ctx.font = `500 ${Math.round(w * 0.02)}px ${th.bodyFace}`;
        ctx.fillText(b.label.slice(0, 24), pad, cy);
        const bw = Math.max(6, (b.value / max) * barMaxW);
        const bx = pad + labelW;
        const bh = rowH * 0.5;
        const cAcc = th.palette[i % th.palette.length]!;
        const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
        grad.addColorStop(0, cAcc); grad.addColorStop(1, cAcc + 'bb');
        ctx.fillStyle = grad;
        roundRect(ctx, bx, cy - bh / 2, bw, bh, bh / 2); ctx.fill();
        ctx.fillStyle = th.ink;
        ctx.font = `700 ${Math.round(w * 0.02)}px ${th.bodyFace}`;
        ctx.fillText(`${b.value}${scene.chart?.unit ?? ''}`, bx + bw + w * 0.012, cy);
      });
      ctx.textBaseline = 'top';
      break;
    }
    case 'comparison': {
      const c = scene.comparison;
      const colW = (bodyW - w * 0.04) / 2;
      const cols = [{ d: c?.left, x: pad, ac: th.palette[0]! }, { d: c?.right, x: pad + colW + w * 0.04, ac: th.palette[2 % th.palette.length]! }];
      const panelH = h - bodyTop - pad * 1.4;
      for (const col of cols) {
        ctx.fillStyle = th.panel;
        roundRect(ctx, col.x, bodyTop, colW, panelH, w * 0.014); ctx.fill();
        ctx.fillStyle = col.ac;
        ctx.font = `700 ${Math.round(w * 0.026)}px ${th.bodyFace}`;
        ctx.fillText((col.d?.heading ?? '').slice(0, 24), col.x + w * 0.025, bodyTop + w * 0.028);
        drawList(col.d?.items ?? [], bodyTop + w * 0.09, col.x + w * 0.025, colW - w * 0.05, col.ac, 4);
      }
      break;
    }
    case 'timeline': {
      const steps = (scene.timeline?.steps ?? []).slice(0, 5);
      const gapY = Math.min(w * 0.11, (h - bodyTop - pad * 1.2) / Math.max(1, steps.length));
      const railX = pad + w * 0.02;
      ctx.strokeStyle = th.muted + '66';
      ctx.lineWidth = Math.max(2, w * 0.003);
      ctx.beginPath(); ctx.moveTo(railX, bodyTop + gapY * 0.5); ctx.lineTo(railX, bodyTop + gapY * (steps.length - 0.5)); ctx.stroke();
      steps.forEach((s, i) => {
        const cy = bodyTop + gapY * (i + 0.5);
        const ac = th.palette[i % th.palette.length]!;
        ctx.fillStyle = ac;
        ctx.beginPath(); ctx.arc(railX, cy, w * 0.014, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = th.mode === 'light' ? '#fff' : '#0a0a0a';
        ctx.font = `700 ${Math.round(w * 0.014)}px ${th.bodyFace}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), railX, cy + w * 0.001);
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillStyle = th.ink;
        ctx.font = `700 ${Math.round(w * 0.024)}px ${th.bodyFace}`;
        ctx.fillText((s.label ?? '').slice(0, 40), railX + w * 0.04, cy - w * 0.024);
        if (s.detail) {
          ctx.fillStyle = th.muted;
          ctx.font = `400 ${Math.round(w * 0.018)}px ${th.bodyFace}`;
          ctx.fillText(wrap(ctx, s.detail, bodyW - w * 0.06)[0] ?? '', railX + w * 0.04, cy + w * 0.004);
        }
      });
      break;
    }
    case 'bignumbers': {
      const items = (scene.bignumbers?.items ?? []).slice(0, 4);
      const n = items.length || 1;
      const cols = n >= 3 ? 2 : n;
      const rows = Math.ceil(n / cols);
      const cellW = (bodyW - w * 0.04 * (cols - 1)) / cols;
      const cellH = Math.min(w * 0.22, (h - bodyTop - pad * 1.2 - w * 0.04 * (rows - 1)) / rows);
      items.forEach((it, i) => {
        const cx = pad + (i % cols) * (cellW + w * 0.04);
        const cy = bodyTop + Math.floor(i / cols) * (cellH + w * 0.04);
        const ac = th.palette[i % th.palette.length]!;
        ctx.fillStyle = th.panel;
        roundRect(ctx, cx, cy, cellW, cellH, w * 0.014); ctx.fill();
        ctx.fillStyle = ac;
        ctx.font = `800 ${Math.round(w * 0.058)}px ${th.titleFace}`;
        ctx.fillText((it.value ?? '').slice(0, 8), cx + w * 0.025, cy + cellH * 0.14);
        ctx.fillStyle = th.muted;
        ctx.font = `400 ${Math.round(w * 0.02)}px ${th.bodyFace}`;
        ctx.fillText(wrap(ctx, it.label ?? '', cellW - w * 0.05)[0] ?? '', cx + w * 0.025, cy + cellH * 0.7);
      });
      break;
    }
    case 'donut': {
      const val = Math.max(0, Math.min(100, scene.donut?.value ?? 0));
      const cx = w * 0.72, cy = bodyTop + (h - bodyTop - pad) * 0.42;
      const rad = Math.min(w, h) * 0.16;
      const lw = rad * 0.38;
      ctx.lineWidth = lw; ctx.lineCap = 'round';
      ctx.strokeStyle = th.muted + '33';
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = accent;
      ctx.beginPath(); ctx.arc(cx, cy, rad, -Math.PI / 2, -Math.PI / 2 + (val / 100) * Math.PI * 2); ctx.stroke();
      ctx.fillStyle = th.ink;
      ctx.font = `800 ${Math.round(rad * 0.6)}px ${th.titleFace}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(`${scene.donut?.value ?? 0}${scene.donut?.unit ?? '%'}`, cx, cy);
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillStyle = th.muted;
      ctx.font = `500 ${Math.round(w * 0.026)}px ${th.bodyFace}`;
      let yy = bodyTop + rad * 0.2;
      for (const line of wrap(ctx, scene.donut?.label ?? '', bodyW * 0.44).slice(0, 4)) { ctx.fillText(line, pad, yy); yy += w * 0.04; }
      break;
    }
  }

  // progress dots
  const dy = h - pad * 0.7;
  const dr = Math.max(3, w * 0.004);
  for (let i = 0; i < sc.total; i++) {
    ctx.beginPath();
    ctx.arc(pad + i * dr * 4, dy, dr, 0, Math.PI * 2);
    ctx.fillStyle = i === sc.index ? accent : (th.mode === 'light' ? '#00000022' : '#ffffff22');
    ctx.fill();
  }
  return canvas.toBuffer('image/png');
}
