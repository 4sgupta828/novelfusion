// Weaving: moment → stubs → constitution-conditioned draft.
// Conditioning = in-scope active principles in-context (≤ config cap)
//              + exemplar edits retrieved as few-shot (NEVER holdouts — Rule 5)
//              + a critique-and-revise pass against the same principles.

import { z } from 'zod/v4';
import { config } from '../config.js';
import { generate, structured } from '../llm/client.js';
import {
  constitutionVersion,
  getMoment,
  getUtterancesByIds,
  insertDraft,
  listEdits,
  listPrinciples,
  listUtterances,
  newId,
  updateMomentState,
} from '../db/index.js';
import type { AssetFormat, Draft, Principle, Utterance, WeaveStub } from '../domain/types.js';

const StubSchema = z.object({
  stubs: z.array(
    z.object({
      angle: z.string().describe('The editorial angle, e.g. "contrarian take", "customer story", "tactical how-to"'),
      format: z.enum(['li_post', 'x_thread', 'blog', 'clip_spec']),
      audience: z.string(),
      stub: z.string().describe('ONE sentence pitching this weaving — max ~20 words'),
    }),
  ),
});

const DraftSchema = z.object({
  content: z.string().describe('The complete asset, ready to publish'),
  provenance: z.array(
    z.object({
      quote: z.string().describe('A claim-bearing span of the draft'),
      utteranceIds: z.array(z.string()).describe('Source utterance IDs (verbatim from input) grounding that span'),
    }),
  ),
});

const STUB_SYSTEM = `You are the weaving stage of an editorial pipeline. Given one grounded "moment" (a real insight a real person said), propose distinct ways to weave it into content: angle x format x audience.
Each proposal is ONE sentence (a pitch, not a draft). Proposals must stay faithful to what was actually said — no invented facts, no exaggeration of the claim.`;

function draftSystem(principles: Principle[]): string {
  const principleBlock =
    principles.length > 0
      ? `\n\nEDITORIAL CONSTITUTION (ratified rules — follow them; they override style defaults):\n${principles
          .map((p) => `- [${p.id} v${p.version}] ${p.text}`)
          .join('\n')}`
      : '';
  return `You are the drafting stage of an editorial pipeline for B2B thought leadership.
Write in the SPEAKER'S authentic voice using their actual words and phrasing wherever possible.

Hard rules:
- Every claim in the draft must be grounded in the provided source utterances. Report each claim-bearing span with its source utterance IDs.
- Never invent facts, numbers, customers, or quotes. If the source doesn't support a claim, leave it out.
- No engagement-bait, no hashtag spam, no "I'm humbled to announce".${principleBlock}`;
}

export async function proposeStubs(workspaceId: string, momentId: string): Promise<WeaveStub[]> {
  const moment = getMoment(workspaceId, momentId);
  if (!moment) throw new Error(`Moment ${momentId} not found in workspace ${workspaceId}`);
  const utterances = getUtterancesByIds(workspaceId, moment.utteranceIds);
  const src = utterances.map((u) => `${u.speaker}: ${u.text}`).join('\n');

  const result = await structured({
    stage: 'weave-stubs',
    system: STUB_SYSTEM,
    user: `Moment claim: ${moment.claim}\nWhy now: ${moment.judgment.whyNow}\n\nSource utterances:\n${src}\n\nPropose 6-10 distinct weavings.`,
    schema: StubSchema,
  });
  return result.stubs;
}

function inScope(p: Principle, format: AssetFormat): boolean {
  return p.scope.channel === null || p.scope.channel === format;
}

/** Per-format depth + structure specs. Without these, the grounding rule plus a
 *  tiny source window converges every draft to a compressed restatement. */
const FORMAT_SPECS: Record<AssetFormat, string> = {
  li_post:
    'A LinkedIn post of 600–1,300 characters. Structure: a hook line that earns the "see more" click, a concrete body that develops the argument with the evidence and at least one specific number or example from the source, and a sharp closing line. Short paragraphs (1–2 sentences). No hashtags.',
  blog:
    'A complete blog post of 700–1,100 words in markdown: an H1 title, a 2–3 sentence opening that states the thesis, 3–5 H2 sections that develop the argument with the concrete numbers, stories, and methodology from the source material, and a closing section with a direct takeaway. Use the surrounding context to develop the full argument — not just the headline claim.',
  x_thread:
    'An X thread of 6–10 numbered tweets ("1/", "2/", …), each under 280 characters. Tweet 1 is the hook with the strongest concrete fact; the middle develops the argument one idea per tweet; the last tweet is the takeaway. No hashtags.',
  clip_spec:
    'A video clip specification: IN/OUT timestamps from the source utterance timing, a cut plan (timestamp ranges with what is said), 2–4 burned captions that are VERBATIM quotes from the transcript (never paraphrased), aspect ratios, and a CTA card line.',
};

/** Surrounding transcript context: ±N utterances around each cited utterance,
 *  from the same source. All of it is citable — this is what lets a blog draw on
 *  the full argument (methodology, examples, follow-ups) instead of starving the
 *  writer with the 1–2 lines the moment happens to cite. */
function expandContext(workspaceId: string, cited: Utterance[], window = 4): Utterance[] {
  const bySource = new Map<string, Utterance[]>();
  const out = new Map<string, Utterance>();
  for (const u of cited) {
    if (!bySource.has(u.sourceId)) bySource.set(u.sourceId, listUtterances(workspaceId, u.sourceId));
    for (const n of bySource.get(u.sourceId)!) {
      if (Math.abs(n.seq - u.seq) <= window) out.set(n.id, n);
    }
  }
  return [...out.values()].sort((a, b) => (a.sourceId === b.sourceId ? a.seq - b.seq : a.sourceId.localeCompare(b.sourceId)));
}

/** Exemplars: recent NON-HOLDOUT edits, most recent first (the floor under distillation). */
function exemplarBlock(workspaceId: string): string {
  const edits = listEdits(workspaceId, { holdout: false }).slice(-config.maxExemplars);
  if (edits.length === 0) return '';
  return (
    '\n\nRECENT EDITOR CORRECTIONS (learn the taste these diffs express):\n' +
    edits.map((e) => `--- edit (${e.reasonChip ?? 'unspecified'}) ---\n${e.diff.slice(0, 1500)}`).join('\n')
  );
}

export async function weaveDraft(
  workspaceId: string,
  momentId: string,
  format: AssetFormat,
  angle = 'default',
  opts: { holdout?: boolean; withConstitution?: boolean } = {},
): Promise<Draft> {
  const moment = getMoment(workspaceId, momentId);
  if (!moment) throw new Error(`Moment ${momentId} not found in workspace ${workspaceId}`);
  const cited = getUtterancesByIds(workspaceId, moment.utteranceIds);
  const citedIds = new Set(cited.map((u) => u.id));
  // Give the writer the surrounding argument, all of it citable (receipts still resolve).
  const context = expandContext(workspaceId, cited);
  const validIds = new Set(context.map((u) => u.id));
  const src = context
    .map((u) => `${citedIds.has(u.id) ? '★' : ' '} ${u.id} | ${u.speaker}${u.tStartSec != null ? ` @${u.tStartSec}s` : ''}: ${u.text}`)
    .join('\n');

  const useConstitution = opts.withConstitution ?? true;
  const active = useConstitution
    ? listPrinciples(workspaceId, 'active').filter((p) => inScope(p, format)).slice(0, config.maxInContextPrinciples)
    : [];

  const result = await structured({
    stage: 'weave-draft',
    system: draftSystem(active),
    user:
      `Write this asset: ${FORMAT_SPECS[format]}\nAngle: ${angle}\nCentral moment (the piece's thesis): ${moment.claim}\n\n` +
      `Source transcript (★ = the utterances the moment cites; unstarred lines are surrounding context from the same recordings — ALL lines are citable):\n${src}` +
      (useConstitution ? exemplarBlock(workspaceId) : ''),
    schema: DraftSchema,
  });

  // Critique-and-revise pass against the same principles (CAI-style application).
  let content = result.content;
  if (active.length > 0) {
    content = await generate({
      stage: 'weave-revise',
      system: draftSystem(active),
      user:
        `Review this draft against the editorial constitution above. If it complies, return it UNCHANGED. ` +
        `If any principle is violated, return a minimally revised version that complies. Return ONLY the draft text.\n\n${content}`,
    });
  }

  const provenance = result.provenance
    .map((p) => ({ quote: p.quote, utteranceIds: p.utteranceIds.filter((id) => validIds.has(id)) }))
    .filter((p) => p.utteranceIds.length > 0);

  const draft: Draft = {
    id: newId('drf'),
    workspaceId,
    momentId,
    format,
    angle,
    content,
    provenance,
    constitutionVersion: constitutionVersion(workspaceId),
    holdout: opts.holdout ?? Math.random() < config.holdoutFraction,
    state: 'draft',
    createdAt: new Date().toISOString(),
  };
  insertDraft(draft);
  updateMomentState(workspaceId, momentId, 'woven');
  return draft;
}
