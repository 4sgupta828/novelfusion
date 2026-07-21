import { describe, expect, it } from 'vitest';
import { renderScene, renderSceneFrame } from '../src/pipeline/fusion-visuals.js';
import type { StoryboardScene, FusionTheme } from '../src/domain/types.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const isPng = (b: Buffer) => b.subarray(0, 4).equals(PNG_MAGIC);

const scenes: Record<string, StoryboardScene> = {
  title: { visual: 'title', title: 'The GTM Machine', subtitle: 'Owned conversations into pipeline', narration: 'n' },
  bullets: { visual: 'bullets', title: 'Three shifts', bullets: ['Reach at scale', 'Personalization at scale', 'Trust is scarce'], narration: 'n' },
  stat: { visual: 'stat', title: 'The number', stat: { value: '95%', label: 'of pilots show no P&L impact' }, narration: 'n' },
  quote: { visual: 'quote', title: 'On the record', quote: { text: 'Hype is a tax on trust.', attribution: 'A founder' }, narration: 'n' },
  chart: { visual: 'chart', title: 'AI spend', chart: { unit: '%', bars: [{ label: 'PLG', value: 27 }, { label: 'Sales', value: 44 }, { label: 'Services', value: 29 }] }, narration: 'n' },
  comparison: { visual: 'comparison', title: 'Old vs new', comparison: { left: { heading: 'Bottoms-up', items: ['Sell to ICs', 'Free tier'] }, right: { heading: 'Top-down', items: ['Sell to buyers', 'Proof first'] } }, narration: 'n' },
  timeline: { visual: 'timeline', title: 'How it closed', timeline: { steps: [{ label: '85 interviews', detail: 'first' }, { label: 'Cold email' }, { label: '$300K deal' }] }, narration: 'n' },
  bignumbers: { visual: 'bignumbers', title: 'The numbers', bignumbers: { items: [{ value: '95%', label: 'no impact' }, { value: '$37B', label: 'spend' }, { value: '10x', label: 'per employee' }, { value: '18mo', label: 'to $10M' }] }, narration: 'n' },
  donut: { visual: 'donut', title: 'Adoption', donut: { value: 73, label: 'of teams use AI in GTM', unit: '%' }, narration: 'n' },
  pictograph: { visual: 'pictograph', title: 'The failure rate', pictograph: { filled: 95, total: 100, label: 'of pilots show no P&L impact' }, narration: 'n' },
};

const THEMES: FusionTheme[] = ['midnight', 'aurora', 'editorial', 'noir', 'sunrise'];

describe('fusion-visuals renderScene — all scene types × all themes', () => {
  for (const theme of THEMES) {
    for (const [name, scene] of Object.entries(scenes)) {
      it(`renders a valid PNG: ${theme} / ${name}`, () => {
        const buf = renderScene(scene, { width: 1280, height: 720, index: 1, total: 5, theme, brand: 'NovelFusion' });
        expect(isPng(buf)).toBe(true);
        expect(buf.length).toBeGreaterThan(2000);
      });
    }
  }

  it('renders vertical (9:16) and square (1:1) across scene types', () => {
    expect(isPng(renderScene(scenes.comparison!, { width: 720, height: 1280, index: 2, total: 5, theme: 'aurora' }))).toBe(true);
    expect(isPng(renderScene(scenes.bignumbers!, { width: 1080, height: 1080, index: 1, total: 3, theme: 'noir' }))).toBe(true);
    expect(isPng(renderScene(scenes.donut!, { width: 720, height: 1280, index: 0, total: 4, theme: 'sunrise' }))).toBe(true);
  });

  it('handles missing optional fields gracefully (no crash on empty scenes)', () => {
    for (const v of ['bullets', 'comparison', 'timeline', 'bignumbers', 'donut', 'chart', 'stat', 'quote'] as const) {
      const bare: StoryboardScene = { visual: v, title: 'Empty', narration: 'n' };
      expect(isPng(renderScene(bare, { width: 1280, height: 720, index: 0, total: 1, theme: 'midnight' }))).toBe(true);
    }
  });
});

describe('fusion-visuals renderSceneFrame — animation over time', () => {
  const animated: StoryboardScene[] = [
    scenes.chart!, scenes.donut!, scenes.bignumbers!, scenes.stat!, scenes.bullets!, scenes.timeline!, scenes.comparison!, scenes.pictograph!,
  ];
  for (const scene of animated) {
    it(`renders a valid frame at t = 0 / 0.7 / 1.5 (settled): ${scene.visual}`, () => {
      for (const t of [0, 0.7, 1.5, 5]) {
        const buf = renderSceneFrame(scene, { width: 1280, height: 720, index: 1, total: 5, theme: 'aurora' }, t);
        expect(isPng(buf)).toBe(true);
        expect(buf.length).toBeGreaterThan(1000);
      }
    });
  }

  it('the early frame differs from the settled frame (motion is actually happening)', () => {
    const sc = { width: 1280, height: 720, index: 0, total: 4, theme: 'midnight' as FusionTheme };
    const early = renderSceneFrame(scenes.chart!, sc, 0.55);
    const settled = renderSceneFrame(scenes.chart!, sc, 5);
    expect(early.equals(settled)).toBe(false); // bars mid-grow ≠ fully grown
  });

  it('renderScene equals a fully-settled frame', () => {
    const sc = { width: 1280, height: 720, index: 0, total: 4, theme: 'noir' as FusionTheme };
    expect(renderScene(scenes.bignumbers!, sc).equals(renderSceneFrame(scenes.bignumbers!, sc, 1e6))).toBe(true);
  });

  it('emphasis pulse produces a distinct frame mid-pop (stat scales) vs before it', () => {
    const sc = { width: 1280, height: 720, index: 0, total: 4, theme: 'aurora' as FusionTheme };
    const beforePulse = renderSceneFrame(scenes.stat!, sc, 1.0); // counted up, not yet pulsing
    const midPulse = renderSceneFrame(scenes.stat!, sc, 1.47); // ~peak of the pulse at ~1.3+dur/2
    expect(beforePulse.equals(midPulse)).toBe(false);
  });

  it('pictograph normalizes a large total to a bounded grid without crashing', () => {
    const big: StoryboardScene = { visual: 'pictograph', title: 'Scale', pictograph: { filled: 8500, total: 10000, label: 'x' }, narration: 'n' };
    for (const theme of THEMES) expect(isPng(renderSceneFrame(big, { width: 1280, height: 720, index: 0, total: 2, theme }, 5))).toBe(true);
  });
});
