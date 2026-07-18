import { describe, expect, it } from 'vitest';
import { vizHasData } from '../src/pipeline/weave.js';

// The code-owned figure gate: a figure survives only if it carries real data in one of the
// supported shapes (series / table / points / groups). Empty figures are dropped regardless of
// what the model claimed — including the new market-map (points) and grouped/stacked (groups) kinds.
describe('vizHasData (figure emptiness gate)', () => {
  it('keeps series-based figures (bar/pie/line/stat)', () => {
    expect(vizHasData({ series: [{ label: 'a', value: 1 }] })).toBe(true);
  });
  it('keeps table figures', () => {
    expect(vizHasData({ table: { rows: [['x']] } })).toBe(true);
  });
  it('keeps scatter/quadrant figures (points)', () => {
    expect(vizHasData({ points: [{ label: 'Cursor', x: 1, y: 2 }] })).toBe(true);
  });
  it('keeps grouped/stacked bar figures (groups)', () => {
    expect(vizHasData({ groups: [{ label: '2024', values: [{ name: 'ent', value: 3 }] }] })).toBe(true);
  });
  it('drops an empty figure of any kind', () => {
    expect(vizHasData({})).toBe(false);
    expect(vizHasData({ series: [], table: { rows: [] }, points: [], groups: [] })).toBe(false);
  });
});
