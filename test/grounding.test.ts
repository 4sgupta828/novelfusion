import { describe, expect, it } from 'vitest';
import { normalizeForSpan, verifySpan, verifySpanAny, numericGrounded } from '../src/pipeline/grounding.js';

describe('normalizeForSpan', () => {
  it('folds smart quotes, dashes, ellipsis; collapses whitespace; lowercases', () => {
    expect(normalizeForSpan('“Hello”—world…  now')).toBe('"hello"-world... now');
    expect(normalizeForSpan('a\n\tb   c')).toBe('a b c');
  });
});

describe('verifySpan (deterministic span-gate)', () => {
  const passage = 'Our net revenue retention held at 118 percent for the third consecutive quarter.';
  it('passes an exact (normalized) span', () => {
    expect(verifySpan(passage, 'net revenue retention held at 118 percent')).toMatchObject({ verified: true, method: 'exact' });
  });
  it('passes despite curly-quote / dash drift (fuzzy tier)', () => {
    const pdf = 'The board’s view — retention climbed to seventy‑two percent this year and holds.';
    // model re-quotes with straight quotes and hyphen; substring would false-fail, fuzzy catches it
    expect(verifySpan(pdf, "retention climbed to seventy-two percent this year").verified).toBe(true);
  });
  it('fails a too-short span (below min substance)', () => {
    expect(verifySpan(passage, 'held')).toMatchObject({ verified: false, method: 'too_short' });
  });
  it('fails an absent span', () => {
    expect(verifySpan(passage, 'our churn fell to single digits this year').verified).toBe(false);
  });
});

describe('verifySpanAny (per-cited-passage)', () => {
  it('verifies against any one cited passage', () => {
    const r = verifySpanAny(['unrelated text here about pricing', 'win rate climbed to 47 percent last quarter'], 'win rate climbed to 47 percent');
    expect(r.verified).toBe(true);
  });
  it('fails when present in no cited passage', () => {
    expect(verifySpanAny(['a passage', 'another passage'], 'a completely different sentence entirely').verified).toBe(false);
  });
});

describe('numericGrounded (computed-figure guard)', () => {
  it('passes when claim numbers appear in evidence', () => {
    expect(numericGrounded('Retention was 118% this quarter.', ['retention held at 118 percent'])).toMatchObject({ ok: true });
  });
  it('rejects a computed figure the evidence never printed', () => {
    // evidence has 5,000 and 7,000; claim asserts 40% (never stated)
    const r = numericGrounded('That is 40% growth.', ['grew from 5,000 to 7,000 users']);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('40');
  });
  it('ignores bare integers/years (only value-shaped tokens)', () => {
    expect(numericGrounded('In 2026 we shipped 3 features.', ['nothing numeric relevant'])).toMatchObject({ ok: true });
  });
  it('normalizes currency and commas', () => {
    expect(numericGrounded('We booked $1,234.56 in revenue.', ['revenue of $1,234.56 landed'])).toMatchObject({ ok: true });
  });
});
