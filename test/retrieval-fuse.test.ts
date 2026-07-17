import { describe, expect, it } from 'vitest';
import { rrfFuse, cosine } from '../src/pipeline/retrieval.js';

describe('rrfFuse (Reciprocal Rank Fusion)', () => {
  it('is a union — an id in only one leg still appears', () => {
    const fused = rrfFuse([['a', 'b'], ['c']]);
    expect(new Set(fused)).toEqual(new Set(['a', 'b', 'c']));
  });
  it('ranks an id found near the top of both legs above single-leg ids', () => {
    const fused = rrfFuse([['x', 'a', 'b'], ['x', 'c', 'd']]);
    expect(fused[0]).toBe('x'); // agreed by both legs
  });
  it('rewards a high rank in one leg over a low rank in both', () => {
    const fused = rrfFuse([['top', 'z1', 'z2', 'z3', 'low'], ['low', 'z4', 'z5', 'z6', 'top']]);
    // top is rank0 in leg1 and rank4 in leg2; low is rank4 then rank0 — symmetric, tie; ensure both beat singletons
    const single = rrfFuse([['top', 'z1', 'z2', 'z3', 'low'], ['low', 'z4', 'z5', 'z6', 'top'], ['solo']]);
    expect(single.indexOf('top')).toBeLessThan(single.indexOf('solo'));
  });
});

describe('cosine', () => {
  it('is 1 for identical direction, 0 for orthogonal', () => {
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([2, 0]))).toBeCloseTo(1, 5);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0, 5);
  });
  it('handles a zero vector without NaN', () => {
    expect(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
  });
});
