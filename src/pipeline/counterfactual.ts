// Counterfactual engine: "under this principle, N of your last M drafts would
// have changed like this." Ratification is gated on these diffs — the editor
// accepts BEHAVIOR, not prose (SYNTHESIS.md: ratify diffs, not sentences).
//
// Blast radius = fraction of OUT-OF-SCOPE drafts that changed. >10% blocks
// one-click ratification; >25% across candidates is a Phase 0 kill signal.

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { generate } from '../llm/client.js';
import {
  getPrinciple,
  insertCounterfactual,
  listCounterfactuals,
  listDrafts,
  newId,
} from '../db/index.js';
import { blastRadius, materiallyChanged, unifiedDiff, type BlastRadius } from '../util/diff.js';
import type { Draft, Principle } from '../domain/types.js';

function principleInScope(p: Principle, d: Draft): boolean {
  return p.scope.channel === null || p.scope.channel === d.format;
}

const REVISE_SYSTEM = `You apply ONE editorial principle to an existing draft, minimally.
- If the draft already complies with the principle, or the principle does not apply to this draft's context, return the draft EXACTLY unchanged.
- If it violates the principle, return a minimally revised version — change only what the principle requires.
Return ONLY the draft text, nothing else.`;

export interface RatificationReport {
  principle: Principle;
  blast: BlastRadius;
  sampleDiffs: { draftId: string; inScope: boolean; diff: string }[];
  reportPath: string;
}

export async function runCounterfactual(
  workspaceId: string,
  principleId: string,
  maxDrafts = 12,
): Promise<RatificationReport> {
  const principle = getPrinciple(workspaceId, principleId);
  if (!principle) throw new Error(`Principle ${principleId} not found in workspace ${workspaceId}`);

  // Deliberate mix: in-scope drafts (does it do what we want?) AND out-of-scope
  // drafts (does it bleed?). Holdout status is irrelevant here — counterfactuals
  // are not training data.
  const all = listDrafts(workspaceId);
  const inScope = all.filter((d) => principleInScope(principle, d)).slice(-Math.ceil(maxDrafts * 0.6));
  const outScope = all.filter((d) => !principleInScope(principle, d)).slice(-Math.floor(maxDrafts * 0.4));
  const sample = [...inScope, ...outScope];
  if (sample.length === 0) throw new Error('No drafts available for counterfactual — weave some drafts first.');

  const results: { draftId: string; inScope: boolean; changed: boolean; diff: string }[] = [];
  for (const d of sample) {
    const revised = (
      await generate({
        stage: 'counterfactual-revise',
        system: REVISE_SYSTEM,
        user: `Principle (scope: ${JSON.stringify(principle.scope)}):\n${principle.text}\n\nDraft (context: ${d.format}, angle: ${d.angle}):\n${d.content}`,
      })
    ).trim();
    const changed = materiallyChanged(d.content, revised);
    const diff = changed ? unifiedDiff(d.id, d.content, revised) : '';
    results.push({ draftId: d.id, inScope: principleInScope(principle, d), changed, diff });
    insertCounterfactual({
      id: newId('cfr'),
      workspaceId,
      principleId,
      draftId: d.id,
      inScope: principleInScope(principle, d),
      changed,
      diff,
    });
  }

  const blast = blastRadius(results);
  const reportPath = writeReport(workspaceId, principle, blast, results);
  return {
    principle,
    blast,
    sampleDiffs: results.filter((r) => r.changed).map(({ draftId, inScope: s, diff }) => ({ draftId, inScope: s, diff })),
    reportPath,
  };
}

function writeReport(
  workspaceId: string,
  principle: Principle,
  blast: BlastRadius,
  results: { draftId: string; inScope: boolean; changed: boolean; diff: string }[],
): string {
  fs.mkdirSync(config.reportsDir, { recursive: true });
  const p = path.join(config.reportsDir, `ratify-${principle.id}.md`);
  const changedIn = results.filter((r) => r.inScope && r.changed);
  const changedOut = results.filter((r) => !r.inScope && r.changed);

  const lines: string[] = [
    `# Ratification report — ${principle.id}`,
    '',
    `> **${principle.text}**`,
    '',
    `- Tier: ${principle.tier} · Scope: \`${JSON.stringify(principle.scope)}\` · Evidence: ${principle.evidenceEditIds.length} edit(s)`,
    `- Counterexamples: ${principle.counterexamples.map((c) => `“${c}”`).join(' · ')}`,
    '',
    `## Blast radius`,
    '',
    `| | changed | total |`,
    `|---|---|---|`,
    `| in scope | ${blast.inScopeChanged} | ${blast.inScopeTotal} |`,
    `| **out of scope** | **${blast.outOfScopeChanged}** | ${blast.outOfScopeTotal} |`,
    '',
    blast.radius > 0.1
      ? `⛔ **Out-of-scope blast radius ${(blast.radius * 100).toFixed(0)}% exceeds 10% — do NOT ratify as-is. Narrow the scope or reject.**`
      : `✅ Out-of-scope blast radius ${(blast.radius * 100).toFixed(0)}% (≤10%).`,
    '',
    `## Counterfactual diffs (${changedIn.length} in scope, ${changedOut.length} out of scope)`,
    '',
  ];
  for (const r of results.filter((x) => x.changed)) {
    lines.push(`### ${r.draftId} ${r.inScope ? '(in scope)' : '⚠️ (OUT OF SCOPE — this is scope bleed)'}`, '', '```diff', r.diff.trim(), '```', '');
  }
  lines.push(
    '---',
    `Decide: \`nf accept ${principle.id}\` (→ shadow) · \`nf reject ${principle.id}\` · rescope by editing and re-running \`nf ratify\`.`,
  );
  fs.writeFileSync(p, lines.join('\n'));
  return p;
}

export function latestBlastRadius(workspaceId: string, principleId: string): BlastRadius {
  return blastRadius(listCounterfactuals(workspaceId, principleId));
}
