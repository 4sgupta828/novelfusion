// Pure structural code (Rule 18: code owns structure). No LLM in this path.

import { createTwoFilesPatch, diffWords } from 'diff';

export function unifiedDiff(label: string, before: string, after: string): string {
  return createTwoFilesPatch(`${label}.orig`, `${label}.edited`, before, after, '', '');
}

/**
 * Normalized word-level edit distance in [0,1]:
 * (added + removed words) / max(words(a), words(b)).
 * Used for edit-recurrence measurement — cheap, deterministic, model-free.
 */
export function normalizedEditDistance(a: string, b: string): number {
  const parts = diffWords(a, b);
  let changed = 0;
  for (const p of parts) {
    if (p.added || p.removed) changed += p.value.split(/\s+/).filter(Boolean).length;
  }
  const denom = Math.max(
    a.split(/\s+/).filter(Boolean).length,
    b.split(/\s+/).filter(Boolean).length,
    1,
  );
  return Math.min(1, changed / denom);
}

/** A draft "changed" under a counterfactual if the normalized distance exceeds a small floor. */
export const CHANGE_FLOOR = 0.02;

export function materiallyChanged(before: string, after: string): boolean {
  return normalizedEditDistance(before, after) > CHANGE_FLOOR;
}

export interface BlastRadius {
  inScopeChanged: number;
  inScopeTotal: number;
  outOfScopeChanged: number;
  outOfScopeTotal: number;
  /** fraction of OUT-OF-SCOPE drafts that changed — the panel's kill metric. */
  radius: number;
}

export function blastRadius(results: { inScope: boolean; changed: boolean }[]): BlastRadius {
  const inS = results.filter((r) => r.inScope);
  const outS = results.filter((r) => !r.inScope);
  const outChanged = outS.filter((r) => r.changed).length;
  return {
    inScopeChanged: inS.filter((r) => r.changed).length,
    inScopeTotal: inS.length,
    outOfScopeChanged: outChanged,
    outOfScopeTotal: outS.length,
    radius: outS.length === 0 ? 0 : outChanged / outS.length,
  };
}
