import { describe, expect, it } from 'vitest';
import { assertPrincipleTransition } from '../src/domain/lifecycle.js';

describe('assertPrincipleTransition (shadow-before-live has no bypass)', () => {
  it('allows candidate → shadow (accept)', () => {
    expect(() => assertPrincipleTransition('candidate', 'accept')).not.toThrow();
  });
  it('blocks accept from any non-candidate status', () => {
    for (const s of ['shadow', 'active', 'rejected', 'retired', 'decaying'] as const) {
      expect(() => assertPrincipleTransition(s, 'accept')).toThrow(/Cannot accept/);
    }
  });
  it('allows shadow → active (promote) and nothing else', () => {
    expect(() => assertPrincipleTransition('shadow', 'promote')).not.toThrow();
    for (const s of ['candidate', 'active', 'rejected', 'retired', 'decaying'] as const) {
      expect(() => assertPrincipleTransition(s, 'promote')).toThrow(/Cannot promote/);
    }
  });
  it('allows reject only from candidate/shadow', () => {
    expect(() => assertPrincipleTransition('candidate', 'reject')).not.toThrow();
    expect(() => assertPrincipleTransition('shadow', 'reject')).not.toThrow();
    for (const s of ['active', 'rejected', 'retired', 'decaying'] as const) {
      expect(() => assertPrincipleTransition(s, 'reject')).toThrow(/Cannot reject/);
    }
  });
});
