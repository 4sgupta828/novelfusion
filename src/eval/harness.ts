// Eval harness — built FIRST, on purpose (SYNTHESIS.md: the harness is the
// product; ratification depends on it). Phase 0 measures:
//
//   RECURRENCE: on HOLDOUT draft/edit pairs, regenerate the draft with the
//   active constitution vs. without, and compare each to the human-edited
//   final. If ratified principles capture real policy, the constitution-on
//   regeneration should land measurably closer to what the human wanted.
//   Distance is structural (word-level, code). Holdouts never feed exemplars
//   or distillation (Rule 5), so this is a genuine generalization test.
//
//   Provenance-resolution is also checked, but it is provenance, not
//   correctness (Rule 6) — reported separately, never as the headline.

import { execSync } from 'node:child_process';
import { config } from '../config.js';
import {
  constitutionVersion,
  getDraft,
  insertEvalRun,
  listEdits,
  listPrinciples,
  newId,
} from '../db/index.js';
import { weaveDraft } from '../pipeline/weave.js';
import { normalizedEditDistance } from '../util/diff.js';

export interface RecurrenceResult {
  pairs: number;
  meanDistanceBaseline: number;
  meanDistanceConstitution: number;
  /** positive = constitution helped; the Phase 0 gate wants ≥ 0.30 */
  reductionFraction: number;
  perPair: { draftId: string; baseline: number; constitution: number }[];
}

function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

export async function runRecurrenceEval(workspaceId: string, maxPairs = 10): Promise<RecurrenceResult> {
  const holdoutEdits = listEdits(workspaceId, { holdout: true }).slice(-maxPairs);
  if (holdoutEdits.length === 0) {
    throw new Error(
      `No holdout edit pairs in workspace ${workspaceId}. Weave drafts (some are auto-marked holdout) and capture edits on them first.`,
    );
  }
  const activeCount = listPrinciples(workspaceId, 'active').length;
  if (activeCount === 0) {
    throw new Error('No active principles — accept + promote at least one before running the recurrence eval.');
  }

  const perPair: RecurrenceResult['perPair'] = [];
  for (const edit of holdoutEdits) {
    const original = getDraft(workspaceId, edit.draftId);
    if (!original) continue;
    const humanFinal = edit.editedContent;

    // Regenerate the same weave twice: baseline (no constitution) vs. constitution-on.
    // Both regenerations are marked holdout so they can never leak into exemplars.
    const baseline = await weaveDraft(workspaceId, original.momentId, original.format, original.angle, {
      holdout: true,
      withConstitution: false,
    });
    const conditioned = await weaveDraft(workspaceId, original.momentId, original.format, original.angle, {
      holdout: true,
      withConstitution: true,
    });

    perPair.push({
      draftId: original.id,
      baseline: normalizedEditDistance(baseline.content, humanFinal),
      constitution: normalizedEditDistance(conditioned.content, humanFinal),
    });
  }
  if (perPair.length === 0) throw new Error('No evaluable pairs.');

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanBaseline = mean(perPair.map((p) => p.baseline));
  const meanConstitution = mean(perPair.map((p) => p.constitution));
  const result: RecurrenceResult = {
    pairs: perPair.length,
    meanDistanceBaseline: meanBaseline,
    meanDistanceConstitution: meanConstitution,
    reductionFraction: meanBaseline === 0 ? 0 : (meanBaseline - meanConstitution) / meanBaseline,
    perPair,
  };

  insertEvalRun({
    id: newId('evl'),
    workspaceId,
    kind: 'recurrence',
    configJson: JSON.stringify({
      model: config.model,
      constitutionVersion: constitutionVersion(workspaceId),
      activePrinciples: activeCount,
      gitSha: gitSha(),
      holdoutPairs: holdoutEdits.map((e) => e.id),
    }),
    resultsJson: JSON.stringify(result),
    createdAt: new Date().toISOString(),
  });
  return result;
}
