import { describe, expect, it } from 'vitest';
import { blastRadius, materiallyChanged, normalizedEditDistance } from '../src/util/diff.js';

describe('normalizedEditDistance', () => {
  it('is 0 for identical text', () => expect(normalizedEditDistance('a b c', 'a b c')).toBe(0));
  it('is 1-ish for total rewrite', () => expect(normalizedEditDistance('a b c', 'x y z')).toBeGreaterThan(0.9));
  it('is proportional for partial edits', () => {
    const d = normalizedEditDistance('the quick brown fox jumps', 'the quick red fox jumps');
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(0.5);
  });
});

describe('materiallyChanged', () => {
  it('ignores whitespace-level noise', () => expect(materiallyChanged('a b c d e f g h i j', 'a b c d e f g h i j')).toBe(false));
  it('detects real changes', () => expect(materiallyChanged('a b c d e', 'a b c d completely-new')).toBe(true));
});

describe('blastRadius', () => {
  it('computes out-of-scope change fraction', () => {
    const r = blastRadius([
      { inScope: true, changed: true },
      { inScope: true, changed: false },
      { inScope: false, changed: true },
      { inScope: false, changed: false },
      { inScope: false, changed: false },
      { inScope: false, changed: false },
    ]);
    expect(r.inScopeChanged).toBe(1);
    expect(r.outOfScopeChanged).toBe(1);
    expect(r.radius).toBeCloseTo(0.25);
  });
  it('is 0 with no out-of-scope samples', () => {
    expect(blastRadius([{ inScope: true, changed: true }]).radius).toBe(0);
  });
});
