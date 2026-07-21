// Canvas infographics for the fusion-video generator — each storyboard scene rendered to a PNG with
// @napi-rs/canvas (headless Skia, no browser). Pure + deterministic: unit-testable, no DB/network.
// ANIMATED: renderSceneFrame(scene, sc, tSec) draws the scene at time t, so elements enter with
// staggered easing and data animates (bars grow, donut sweeps, numbers count up, timeline draws) —
// the fusion.ts pipeline emits a frame sequence per scene. Themed (5 looks) + multi-format.

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

// Longest entrance a scene animates over; after this a scene is fully settled (bounds frame work).
// Slightly longer than the entrances so emphasis pulses (which fire after data settles) complete.
export const SCENE_ANIM_SEC = 1.8;

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

// ---------- animation toolkit ----------

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const easeOut = (p: number) => { const q = clamp(p, 0, 1); return 1 - Math.pow(1 - q, 3); };
/** Eased 0..1 progress for an element that starts at `start`s and animates over `dur`s. */
const reveal = (t: number, start: number, dur: number) => easeOut((t - start) / dur);

/** Interpolate the leading number in a value string toward its target (odometer count-up). */
function countUp(value: string, p: number): string {
  const m = value.match(/\d[\d,]*\.?\d*/);
  if (!m) return value;
  const raw = m[0].replace(/,/g, '');
  const num = parseFloat(raw);
  if (!isFinite(num)) return value;
  const cur = num * clamp(p, 0, 1);
  const shown = raw.includes('.') ? cur.toFixed(1) : String(Math.round(cur));
  return value.replace(m[0], shown);
}

/** Draw `fn` faded in (alpha=r) and slid up from `slideY`px. Skips entirely while invisible. */
function withReveal(ctx: SKRSContext2D, r: number, slideY: number, fn: () => void) {
  if (r <= 0.002) return;
  ctx.save();
  ctx.globalAlpha = Math.min(1, r);
  if (slideY) ctx.translate(0, (1 - Math.min(1, r)) * slideY);
  fn();
  ctx.restore();
}

/** Emphasis beat: a one-shot scale bump (1 → ~1.14 → 1) starting at `at`s — fires after data settles. */
const pulse = (t: number, at: number, dur = 0.34) => {
  const p = (t - at) / dur;
  return p <= 0 || p >= 1 ? 1 : 1 + 0.14 * Math.sin(p * Math.PI);
};
/** Draw `fn` scaled by `s` about (cx, cy). */
function withScale(ctx: SKRSContext2D, cx: number, cy: number, s: number, fn: () => void) {
  if (s === 1) { fn(); return; }
  ctx.save();
  ctx.translate(cx, cy); ctx.scale(s, s); ctx.translate(-cx, -cy);
  fn();
  ctx.restore();
}

// ---------- render ----------

/** Render one scene AT time `tSec` (0 = scene start). Elements enter staggered/eased; data animates. */
export function renderSceneFrame(scene: StoryboardScene, sc: SceneCtx, tSec: number): Buffer {
  const t = tSec;
  const { width: w, height: h } = sc;
  const th = THEMES[sc.theme] ?? THEMES.midnight;
  const accent = th.palette[sc.index % th.palette.length]!;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const pad = Math.round(w * 0.07);
  const contentW = w - pad * 2;
  const slide = w * 0.02;

  th.bg(ctx, w, h, accent);

  // eyebrow
  withReveal(ctx, reveal(t, 0, 0.4), slide * 0.6, () => {
    ctx.fillStyle = accent;
    ctx.font = `600 ${Math.round(w * 0.018)}px ${th.bodyFace}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${sc.brand ? sc.brand.toUpperCase() + '  ·  ' : ''}${String(sc.index + 1).padStart(2, '0')} / ${String(sc.total).padStart(2, '0')}`, pad, pad + w * 0.02);
  });

  // title (staggered per line) + accent underline (draws its width)
  ctx.textBaseline = 'top';
  const titleSize = Math.round(w * (scene.visual === 'title' ? 0.062 : 0.048));
  ctx.font = `${th.titleWeight} ${titleSize}px ${th.titleFace}`;
  const titleLines = wrap(ctx, scene.title, contentW).slice(0, 3);
  let y = pad + titleSize * 1.3;
  titleLines.forEach((line, i) => {
    withReveal(ctx, reveal(t, 0.05 + i * 0.07, 0.45), slide, () => {
      ctx.fillStyle = th.ink;
      ctx.font = `${th.titleWeight} ${titleSize}px ${th.titleFace}`;
      ctx.textBaseline = 'top';
      ctx.fillText(line, pad, y);
    });
    y += titleSize * 1.14;
  });
  const ulW = Math.min(contentW, w * 0.22) * reveal(t, 0.35, 0.5);
  if (ulW > 1) { ctx.fillStyle = accent; roundRect(ctx, pad, y + titleSize * 0.12, ulW, Math.max(4, w * 0.006), 4); ctx.fill(); }
  const bodyTop = y + titleSize * 0.7 + w * 0.03;
  const bodyW = contentW;

  const BODY_START = 0.5, STAGGER = 0.13, ITEM_DUR = 0.42;

  // animated staggered list (bullets / comparison columns)
  const drawList = (items: string[], top: number, x: number, colW: number, accentColor: string, start: number, max = 5) => {
    const size = Math.round(w * 0.024);
    let yy = top;
    (items ?? []).slice(0, max).forEach((b, i) => {
      const r = reveal(t, start + i * STAGGER, ITEM_DUR);
      const lines = wrap(ctx, b, colW - size * 1.5);
      const blockY = yy;
      withReveal(ctx, r, slide, () => {
        ctx.font = `500 ${size}px ${th.bodyFace}`;
        ctx.textBaseline = 'top';
        ctx.fillStyle = accentColor;
        ctx.beginPath();
        ctx.arc(x + size * 0.35, blockY + size * 0.55, size * 0.26, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = th.ink;
        let ly = blockY;
        for (const line of lines) { ctx.fillText(line, x + size * 1.3, ly); ly += size * 1.3; }
      });
      yy += lines.length * size * 1.3 + size * 0.5;
    });
  };

  switch (scene.visual) {
    case 'title':
      if (scene.subtitle) {
        withReveal(ctx, reveal(t, 0.5, 0.5), slide, () => {
          ctx.fillStyle = th.muted;
          ctx.font = `400 ${Math.round(w * 0.03)}px ${th.bodyFace}`;
          ctx.textBaseline = 'top';
          let yy = bodyTop;
          for (const line of wrap(ctx, scene.subtitle!, bodyW).slice(0, 4)) { ctx.fillText(line, pad, yy); yy += w * 0.042; }
        });
      }
      break;
    case 'bullets':
      drawList(scene.bullets ?? [], bodyTop, pad, bodyW, accent, BODY_START);
      break;
    case 'stat': {
      const p = reveal(t, 0.4, 0.85);
      const statSize = Math.round(w * 0.14);
      withReveal(ctx, reveal(t, 0.35, 0.4), slide, () => {
        // emphasis: a scale pop right after the count-up finishes (~1.25s)
        withScale(ctx, pad + w * 0.09, bodyTop + statSize * 0.5, pulse(t, 1.3), () => {
          ctx.fillStyle = accent;
          ctx.font = `800 ${statSize}px ${th.titleFace}`;
          ctx.textBaseline = 'top';
          ctx.fillText(countUp(scene.stat?.value ?? '', p), pad, bodyTop);
        });
      });
      withReveal(ctx, reveal(t, 0.7, 0.5), slide, () => {
        ctx.fillStyle = th.muted;
        ctx.font = `400 ${Math.round(w * 0.028)}px ${th.bodyFace}`;
        ctx.textBaseline = 'top';
        let yy = bodyTop + Math.round(w * 0.14) * 1.05;
        for (const line of wrap(ctx, scene.stat?.label ?? '', bodyW).slice(0, 3)) { ctx.fillText(line, pad, yy); yy += w * 0.04; }
      });
      break;
    }
    case 'quote': {
      withReveal(ctx, reveal(t, 0.3, 0.4), 0, () => {
        ctx.fillStyle = accent;
        ctx.font = `700 ${Math.round(w * 0.12)}px Georgia`;
        ctx.textBaseline = 'top';
        ctx.fillText('“', pad, bodyTop - w * 0.02);
      });
      const lines = wrap(ctx, scene.quote?.text ?? '', bodyW).slice(0, 5);
      let yy = bodyTop + w * 0.06;
      lines.forEach((line, i) => {
        const ly = yy;
        withReveal(ctx, reveal(t, 0.5 + i * 0.1, 0.4), slide, () => {
          ctx.fillStyle = th.ink;
          ctx.font = `italic 600 ${Math.round(w * 0.038)}px Georgia`;
          ctx.textBaseline = 'top';
          ctx.fillText(line, pad, ly);
        });
        yy += w * 0.052;
      });
      if (scene.quote?.attribution) {
        withReveal(ctx, reveal(t, 0.5 + lines.length * 0.1 + 0.15, 0.4), slide, () => {
          ctx.fillStyle = th.muted;
          ctx.font = `500 ${Math.round(w * 0.024)}px ${th.bodyFace}`;
          ctx.textBaseline = 'top';
          ctx.fillText(`— ${scene.quote!.attribution}`, pad, yy + w * 0.02);
        });
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
        const grow = reveal(t, 0.5 + i * 0.1, 0.6);
        const fade = reveal(t, 0.5 + i * 0.1, 0.35);
        ctx.save();
        ctx.globalAlpha = Math.min(1, fade);
        ctx.fillStyle = th.muted;
        ctx.font = `500 ${Math.round(w * 0.02)}px ${th.bodyFace}`;
        ctx.fillText(b.label.slice(0, 24), pad, cy);
        const bw = Math.max(2, (b.value / max) * barMaxW * grow);
        const bx = pad + labelW;
        const bh = rowH * 0.5;
        const cAcc = th.palette[i % th.palette.length]!;
        const grad = ctx.createLinearGradient(bx, 0, bx + Math.max(bw, 1), 0);
        grad.addColorStop(0, cAcc); grad.addColorStop(1, cAcc + 'bb');
        ctx.fillStyle = grad;
        roundRect(ctx, bx, cy - bh / 2, bw, bh, bh / 2); ctx.fill();
        ctx.fillStyle = th.ink;
        ctx.font = `700 ${Math.round(w * 0.02)}px ${th.bodyFace}`;
        ctx.fillText(`${Math.round(b.value * grow)}${scene.chart?.unit ?? ''}`, bx + bw + w * 0.012, cy);
        ctx.restore();
      });
      ctx.textBaseline = 'top';
      break;
    }
    case 'comparison': {
      const c = scene.comparison;
      const colW = (bodyW - w * 0.04) / 2;
      const cols = [{ d: c?.left, x: pad, ac: th.palette[0]!, s: 0.4 }, { d: c?.right, x: pad + colW + w * 0.04, ac: th.palette[2 % th.palette.length]!, s: 0.55 }];
      const panelH = h - bodyTop - pad * 1.4;
      for (const col of cols) {
        withReveal(ctx, reveal(t, col.s, 0.45), slide, () => {
          ctx.fillStyle = th.panel;
          roundRect(ctx, col.x, bodyTop, colW, panelH, w * 0.014); ctx.fill();
          ctx.fillStyle = col.ac;
          ctx.font = `700 ${Math.round(w * 0.026)}px ${th.bodyFace}`;
          ctx.textBaseline = 'top';
          ctx.fillText((col.d?.heading ?? '').slice(0, 24), col.x + w * 0.025, bodyTop + w * 0.028);
        });
        drawList(col.d?.items ?? [], bodyTop + w * 0.09, col.x + w * 0.025, colW - w * 0.05, col.ac, col.s + 0.25, 4);
      }
      break;
    }
    case 'timeline': {
      const steps = (scene.timeline?.steps ?? []).slice(0, 5);
      const gapY = Math.min(w * 0.11, (h - bodyTop - pad * 1.2) / Math.max(1, steps.length));
      const railX = pad + w * 0.02;
      const railTop = bodyTop + gapY * 0.5, railBot = bodyTop + gapY * (steps.length - 0.5);
      const railP = reveal(t, 0.4, 0.6);
      ctx.strokeStyle = th.muted + '66';
      ctx.lineWidth = Math.max(2, w * 0.003);
      ctx.beginPath(); ctx.moveTo(railX, railTop); ctx.lineTo(railX, railTop + (railBot - railTop) * railP); ctx.stroke();
      steps.forEach((s, i) => {
        const cy = bodyTop + gapY * (i + 0.5);
        const ac = th.palette[i % th.palette.length]!;
        withReveal(ctx, reveal(t, 0.5 + i * 0.14, 0.42), slide, () => {
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
        const start = 0.5 + i * 0.12;
        withReveal(ctx, reveal(t, start, 0.4), slide, () => {
          ctx.fillStyle = th.panel;
          roundRect(ctx, cx, cy, cellW, cellH, w * 0.014); ctx.fill();
          ctx.fillStyle = ac;
          ctx.font = `800 ${Math.round(w * 0.058)}px ${th.titleFace}`;
          ctx.textBaseline = 'top';
          ctx.fillText(countUp((it.value ?? '').slice(0, 8), reveal(t, start + 0.05, 0.6)), cx + w * 0.025, cy + cellH * 0.14);
          ctx.fillStyle = th.muted;
          ctx.font = `400 ${Math.round(w * 0.02)}px ${th.bodyFace}`;
          ctx.fillText(wrap(ctx, it.label ?? '', cellW - w * 0.05)[0] ?? '', cx + w * 0.025, cy + cellH * 0.7);
        });
      });
      break;
    }
    case 'donut': {
      const val = Math.max(0, Math.min(100, scene.donut?.value ?? 0));
      const cx = w * 0.72, cy = bodyTop + (h - bodyTop - pad) * 0.42;
      const rad = Math.min(w, h) * 0.16;
      const lw = rad * 0.38;
      const sweep = reveal(t, 0.5, 0.9);
      withScale(ctx, cx, cy, pulse(t, 1.45), () => { // emphasis pop once the ring finishes sweeping
        ctx.lineWidth = lw; ctx.lineCap = 'round';
        ctx.strokeStyle = th.muted + '33';
        ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
        if (sweep > 0.001) {
          ctx.strokeStyle = accent;
          ctx.beginPath(); ctx.arc(cx, cy, rad, -Math.PI / 2, -Math.PI / 2 + (val / 100) * Math.PI * 2 * sweep); ctx.stroke();
        }
        ctx.fillStyle = th.ink;
        ctx.font = `800 ${Math.round(rad * 0.6)}px ${th.titleFace}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(`${Math.round(val * sweep)}${scene.donut?.unit ?? '%'}`, cx, cy);
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      });
      withReveal(ctx, reveal(t, 0.6, 0.5), slide, () => {
        ctx.fillStyle = th.muted;
        ctx.font = `500 ${Math.round(w * 0.026)}px ${th.bodyFace}`;
        ctx.textBaseline = 'top';
        let yy = bodyTop + rad * 0.2;
        for (const line of wrap(ctx, scene.donut?.label ?? '', bodyW * 0.44).slice(0, 4)) { ctx.fillText(line, pad, yy); yy += w * 0.04; }
      });
      break;
    }
    case 'pictograph': {
      // unit chart (data-humanism): a grid of `total` icons, `filled` of them highlighted, filling
      // in staggered. Large totals normalize to a ≤50-dot grid preserving the ratio.
      const rawTotal = Math.max(1, Math.round(scene.pictograph?.total ?? 10));
      const rawFilled = clamp(Math.round(scene.pictograph?.filled ?? 0), 0, rawTotal);
      const N = Math.min(rawTotal, 50);
      const filledN = Math.round((rawFilled / rawTotal) * N);
      const cols = Math.min(10, N);
      const rows = Math.ceil(N / cols);
      const cell = Math.min(w * 0.062, (bodyW) / cols, (h - bodyTop - pad * 1.6) / rows);
      const dotR = cell * 0.32;
      const gx = pad, gy = bodyTop + w * 0.01;
      for (let k = 0; k < N; k++) {
        const col = k % cols, row = Math.floor(k / cols);
        const dx = gx + col * cell + cell * 0.5, dy2 = gy + row * cell + cell * 0.5;
        const on = k < filledN;
        const r = reveal(t, 0.5 + k * 0.035, 0.35); // staggered fill-in
        withScale(ctx, dx, dy2, on ? pulse(t, 0.5 + k * 0.035 + 0.28, 0.28) : 1, () => {
          ctx.save();
          ctx.globalAlpha = Math.min(1, on ? r : 0.28 + r * 0.0);
          ctx.beginPath(); ctx.arc(dx, dy2, dotR, 0, Math.PI * 2);
          if (on) { ctx.fillStyle = accent; ctx.globalAlpha = Math.min(1, r); ctx.fill(); }
          else { ctx.strokeStyle = th.muted + '66'; ctx.lineWidth = Math.max(1.5, w * 0.002); ctx.globalAlpha = Math.min(1, reveal(t, 0.5, 0.6)); ctx.stroke(); }
          ctx.restore();
        });
      }
      withReveal(ctx, reveal(t, 0.7, 0.5), slide, () => {
        ctx.fillStyle = th.muted;
        ctx.font = `500 ${Math.round(w * 0.026)}px ${th.bodyFace}`;
        ctx.textBaseline = 'top';
        const ly = gy + rows * cell + w * 0.02;
        for (const line of wrap(ctx, scene.pictograph?.label ?? '', bodyW).slice(0, 2)) { ctx.fillText(line, pad, ly); }
      });
      break;
    }
  }

  // progress dots (fade in)
  ctx.save();
  ctx.globalAlpha = Math.min(1, reveal(t, 0.1, 0.3));
  const dy = h - pad * 0.7;
  const dr = Math.max(3, w * 0.004);
  for (let i = 0; i < sc.total; i++) {
    ctx.beginPath();
    ctx.arc(pad + i * dr * 4, dy, dr, 0, Math.PI * 2);
    ctx.fillStyle = i === sc.index ? accent : (th.mode === 'light' ? '#00000022' : '#ffffff22');
    ctx.fill();
  }
  ctx.restore();

  return canvas.toBuffer('image/png');
}

/** Fully-settled frame (all animations complete) — for static use and unit tests. */
export function renderScene(scene: StoryboardScene, sc: SceneCtx): Buffer {
  return renderSceneFrame(scene, sc, 1e6);
}
