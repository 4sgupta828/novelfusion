import { describe, expect, it } from 'vitest';
import { renderScene } from '../src/pipeline/fusion-visuals.js';
import type { StoryboardScene } from '../src/domain/types.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const isPng = (b: Buffer) => b.subarray(0, 4).equals(PNG_MAGIC);

const scenes: Record<string, StoryboardScene> = {
  title: { visual: 'title', title: 'The GTM Machine', subtitle: 'Owned conversations into pipeline', narration: 'n' },
  bullets: { visual: 'bullets', title: 'Three shifts', bullets: ['Reach at scale', 'Personalization at scale', 'Trust is scarce'], narration: 'n' },
  stat: { visual: 'stat', title: 'The number', stat: { value: '95%', label: 'of pilots show no P&L impact' }, narration: 'n' },
  quote: { visual: 'quote', title: 'On the record', quote: { text: 'Hype is a tax on trust.', attribution: 'A founder' }, narration: 'n' },
  chart: { visual: 'chart', title: 'AI spend', chart: { unit: '%', bars: [{ label: 'PLG', value: 27 }, { label: 'Sales', value: 44 }, { label: 'Services', value: 29 }] }, narration: 'n' },
};

describe('fusion-visuals renderScene', () => {
  for (const [name, scene] of Object.entries(scenes)) {
    it(`renders a valid PNG for a "${name}" scene (16:9)`, () => {
      const buf = renderScene(scene, { width: 1280, height: 720, index: 0, total: 5, brand: 'NovelFusion' });
      expect(isPng(buf)).toBe(true);
      expect(buf.length).toBeGreaterThan(2000); // a real rendered frame, not an empty canvas
    });
  }

  it('renders vertical (9:16) and square (1:1) without error', () => {
    expect(isPng(renderScene(scenes.chart!, { width: 720, height: 1280, index: 2, total: 5 }))).toBe(true);
    expect(isPng(renderScene(scenes.stat!, { width: 1080, height: 1080, index: 1, total: 3 }))).toBe(true);
  });

  it('handles missing optional fields gracefully (bullets/stat/chart absent)', () => {
    const bare: StoryboardScene = { visual: 'bullets', title: 'Empty', narration: 'n' };
    expect(isPng(renderScene(bare, { width: 1280, height: 720, index: 0, total: 1 }))).toBe(true);
  });
});
