// Phase 0 gate report — computes the pre-registered proceed/kill metrics
// (SYNTHESIS.md §4) from the database. Honest by construction: metrics that
// cannot be computed yet are reported as MISSING, never guessed.

import { listCounterfactuals, listEdits, listEvalRuns, listPrinciples } from '../db/index.js';
import { blastRadius } from '../util/diff.js';
import type { RecurrenceResult } from '../eval/harness.js';

export interface GateMetric {
  name: string;
  value: string;
  threshold: string;
  status: 'PASS' | 'FAIL' | 'MISSING';
}

export function gateReport(workspaceId: string): GateMetric[] {
  const metrics: GateMetric[] = [];
  const principles = listPrinciples(workspaceId);
  const candidates = principles.filter((p) => p.status === 'candidate');
  const decided = principles.filter((p) => ['shadow', 'active', 'rejected'].includes(p.status));
  const accepted = principles.filter((p) => ['shadow', 'active'].includes(p.status));

  // 1. Ratification precision: accepted / decided (proxy for "ratified without rewriting").
  if (decided.length >= 5) {
    const precision = accepted.length / decided.length;
    metrics.push({
      name: 'Ratification precision',
      value: `${(precision * 100).toFixed(0)}% (${accepted.length}/${decided.length})`,
      threshold: '≥60%',
      status: precision >= 0.6 ? 'PASS' : 'FAIL',
    });
  } else {
    metrics.push({
      name: 'Ratification precision',
      value: `${decided.length} decided (need ≥5); ${candidates.length} candidates pending`,
      threshold: '≥60%',
      status: 'MISSING',
    });
  }

  // 2. Edit recurrence reduction: latest recurrence eval run.
  const recurrenceRuns = listEvalRuns(workspaceId, 'recurrence');
  if (recurrenceRuns.length > 0) {
    const latest = JSON.parse(recurrenceRuns[0]!.resultsJson) as RecurrenceResult;
    metrics.push({
      name: 'Edit-recurrence reduction',
      value: `${(latest.reductionFraction * 100).toFixed(0)}% over ${latest.pairs} holdout pair(s)`,
      threshold: '≥30%',
      status: latest.reductionFraction >= 0.3 ? 'PASS' : 'FAIL',
    });
  } else {
    metrics.push({ name: 'Edit-recurrence reduction', value: 'no eval run yet (nf regress)', threshold: '≥30%', status: 'MISSING' });
  }

  // 3. Blast radius: worst-case across principles with counterfactual runs.
  const radii = principles
    .map((p) => ({ p, results: listCounterfactuals(workspaceId, p.id) }))
    .filter(({ results }) => results.length > 0)
    .map(({ p, results }) => ({ id: p.id, radius: blastRadius(results).radius }));
  if (radii.length > 0) {
    const worst = radii.reduce((a, b) => (b.radius > a.radius ? b : a));
    metrics.push({
      name: 'Blast radius (worst principle)',
      value: `${(worst.radius * 100).toFixed(0)}% (${worst.id})`,
      threshold: '<10% (kill >25%)',
      status: worst.radius < 0.1 ? 'PASS' : 'FAIL',
    });
  } else {
    metrics.push({ name: 'Blast radius', value: 'no counterfactual runs yet (nf ratify)', threshold: '<10%', status: 'MISSING' });
  }

  // 4. Coverage: fraction of non-holdout edits cited as evidence by some candidate/accepted principle.
  const edits = listEdits(workspaceId, { holdout: false });
  if (edits.length >= 5 && principles.length > 0) {
    const cited = new Set(principles.flatMap((p) => p.evidenceEditIds));
    const coverage = edits.filter((e) => cited.has(e.id)).length / edits.length;
    metrics.push({
      name: 'Edit→principle coverage',
      value: `${(coverage * 100).toFixed(0)}% (${edits.length} edits)`,
      threshold: '≥50%',
      status: coverage >= 0.5 ? 'PASS' : 'FAIL',
    });
  } else {
    metrics.push({ name: 'Edit→principle coverage', value: `${edits.length} non-holdout edits (need ≥5)`, threshold: '≥50%', status: 'MISSING' });
  }

  return metrics;
}

export function renderGateReport(workspaceId: string): string {
  const metrics = gateReport(workspaceId);
  const rows = metrics.map((m) => `| ${m.status === 'PASS' ? '✅' : m.status === 'FAIL' ? '❌' : '⬜'} ${m.name} | ${m.value} | ${m.threshold} |`);
  return [
    `# Phase 0 gate — workspace ${workspaceId}`,
    '',
    '| metric | value | threshold |',
    '|---|---|---|',
    ...rows,
    '',
    '⬜ = not yet measurable. Gate decision requires ALL metrics measured (SYNTHESIS.md §4);',
    'blind exec preference (≥65%) and zero cross-client leaks are verified manually with the design partner.',
  ].join('\n');
}
