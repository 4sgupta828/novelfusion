// The distiller: edit events → scoped candidate principles.
// This is the riskiest bet of the product (SYNTHESIS.md). Containment:
//   - candidates only; NOTHING goes live without counterfactual-diff ratification
//   - scope defaults to the NARROWEST observed context
//   - every candidate must carry counterexamples (where it should NOT apply)
//   - holdout edits are never distilled (Rule 5)

import { z } from 'zod/v4';
import { structured } from '../llm/client.js';
import { getDraft, insertPrinciple, listEdits, newId } from '../db/index.js';
import type { Principle } from '../domain/types.js';

const CandidateSchema = z.object({
  candidates: z.array(
    z.object({
      text: z.string().describe('The principle, stated as a testable editorial rule — concrete, not vibes'),
      tier: z.enum(['L1_brand', 'L2_channel', 'L3_taste']).describe('L0 compliance rules are authored by humans, never distilled'),
      scope: z.object({
        channel: z.enum(['li_post', 'x_thread', 'blog', 'clip_spec']).nullable().describe('null only if evidence spans multiple channels'),
        person: z.string().nullable(),
        topic: z.string().nullable(),
        audience: z.string().nullable(),
      }),
      evidenceEditIds: z.array(z.string()).describe('IDs of the edits (verbatim from input) that support this rule'),
      counterexamples: z.array(z.string()).describe('Contexts where this rule should NOT apply — at least one'),
      confidence: z.number().describe('0-1: how confident this is a durable rule vs. one-off taste'),
    }),
  ),
  unexplainedEditIds: z.array(z.string()).describe('Edits that look like one-off taste or factual fixes, not generalizable policy'),
});

const SYSTEM = `You are the distillation stage of an editorial governance system. You receive a set of human editor corrections (unified diffs with reason tags) made to AI drafts, and you propose durable EDITORIAL PRINCIPLES the edits express.

Critical discipline — the known failure mode of systems like you is OVER-GENERALIZATION:
- Human edits are multi-causal: one edit may fix a fact, tighten a sentence, AND express taste. Only recurring, cross-instance patterns are policy. A single edit is a hypothesis, not a rule.
- Scope every principle to the NARROWEST context the evidence supports (a rule seen only in LinkedIn posts gets channel=li_post, not null).
- Every principle needs at least one counterexample: a context where applying it would be wrong.
- Edits that are one-off (a factual correction, a typo, mood) go in unexplainedEditIds — do NOT force them into rules.
- Prefer few, sharp, testable principles over many vague ones. "Be more concise" is not a principle; "cut throat-clearing openers; start with the claim itself" is.`;

export async function distill(workspaceId: string): Promise<Principle[]> {
  const edits = listEdits(workspaceId, { holdout: false });
  if (edits.length === 0) throw new Error(`No non-holdout edits in workspace ${workspaceId} — capture edits first.`);
  const validIds = new Set(edits.map((e) => e.id));

  const input = edits
    .map((e) => {
      const draft = getDraft(workspaceId, e.draftId);
      return `=== edit ${e.id} (reason: ${e.reasonChip ?? 'unspecified'}; channel: ${draft?.format ?? 'unknown'}) ===\n${e.diff.slice(0, 3000)}`;
    })
    .join('\n\n');

  const result = await structured({
    stage: 'distill',
    system: SYSTEM,
    user: `Editor corrections:\n\n${input}\n\nPropose candidate principles.`,
    schema: CandidateSchema,
    maxTokens: 16000,
  });

  const created: Principle[] = [];
  for (const c of result.candidates) {
    const evidence = c.evidenceEditIds.filter((id) => validIds.has(id));
    // Containment in code: no evidence → no candidate; no counterexample → no candidate.
    if (evidence.length === 0 || c.counterexamples.length === 0) continue;
    const p: Principle = {
      id: newId('prn'),
      workspaceId,
      text: c.text,
      tier: c.tier,
      scope: c.scope,
      status: 'candidate',
      evidenceEditIds: evidence,
      counterexamples: c.counterexamples,
      version: 1,
      fireCount: 0,
      overrideCount: 0,
      createdAt: new Date().toISOString(),
    };
    insertPrinciple(p);
    created.push(p);
  }
  return created;
}
