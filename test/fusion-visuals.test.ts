import { describe, expect, it } from 'vitest';
import { renderScene } from '../src/pipeline/fusion-visuals.js';
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
