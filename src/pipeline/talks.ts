// Talk Slate — the discovery layer of `talk_kit` (docs/specs/talk-kit.md). proposeTalks reads a
// diverse sample of the corpus AND the inventory of what has already been delivered (source titles),
// then proposes a slate of FEASIBLE long-form talks, each tied to a concrete goal (training,
// education, sales, marketing, deep-dive, …) and a positive company outcome, with a grounded segment
// outline. Analogous to the Ideas board but for long-form.
//
// Rule 18: the LLM owns which talks are feasible, novel, and worth giving; code owns structure — it
// validates every cited utterance id against the passages actually shown (fabricated ids dropped,
// fail-safe), so each proposal and each outline segment carries real receipts. A proposal with no
// surviving grounding is dropped entirely. This is a PROPOSAL layer, not a talk_kit generator: full
// long-form composition + grounding gates + attestation are deferred (SYNTHESIS §7).

import { z } from 'zod/v4';
import { structured } from '../llm/client.js';
import {
  listUtterances,
  listSources,
  insertTalkProposal,
  getTalkProposal,
  updateTalkProposalStatus,
  type NewTalkProposal,
} from '../db/index.js';
import type { TalkProposal, TalkSegment, Utterance } from '../domain/types.js';

const INPUT_CHARS = 34000; // broad read: a talk needs cross-source range to be feasible

type WsUtterance = Utterance & { workspaceId: string };

/** Round-robin across sources up to a char budget, so no single source dominates the sample. */
function diverseSample(passages: WsUtterance[], budget: number): WsUtterance[] {
  const bySource = new Map<string, WsUtterance[]>();
  for (const p of passages) {
    const arr = bySource.get(p.sourceId) ?? [];
    arr.push(p);
    bySource.set(p.sourceId, arr);
  }
  const queues = [...bySource.values()];
  const picked: WsUtterance[] = [];
  let chars = 0;
  let anyLeft = true;
  while (anyLeft) {
    anyLeft = false;
    for (const q of queues) {
      const p = q.shift();
      if (!p) continue;
      anyLeft = true;
      if (chars + p.text.length > budget) { anyLeft = false; break; }
      picked.push(p);
      chars += p.text.length;
    }
  }
  return picked;
}

const renderPassages = (ps: WsUtterance[]) =>
  ps.map((p) => `${p.id}${p.speaker ? ` (${p.speaker})` : ''}: ${p.text}`).join('\n');

const SegmentSchema = z.object({
  title: z.string().describe('segment title'),
  summary: z.string().describe('one or two sentences: what this segment covers and the point it makes'),
  utteranceIds: z.array(z.string()).describe('ids (verbatim, as labeled) of the passages that ground this segment'),
});

const TalkSchema = z.object({
  talks: z.array(
    z.object({
      title: z.string().describe('a specific, compelling talk title (not a generic topic)'),
      goal: z
        .string()
        .describe('the concrete goal this talk serves — one of: training, education, sales_enablement, demand_gen, thought_leadership, community, recruiting, deep_dive, product_launch — or a more precise one you name'),
      outcome: z.string().describe('the concrete positive outcome for the COMPANY if this talk lands (e.g. "shortens enterprise sales cycles by pre-answering the top security objection")'),
      thesis: z.string().describe('the argument or lesson the talk delivers — its spine, not a topic label'),
      audience: z.string().describe('who this is for (be specific: role, seniority, stage)'),
      format: z.string().describe('best delivery format: webinar, workshop, conference_talk, podcast, sales_session, internal_training, …'),
      outline: z.array(SegmentSchema).min(2).max(7).describe('the segment arc; every segment grounded in real passages'),
      feasibility: z.number().min(0).max(1).describe('0–1: how well the corpus ACTUALLY supports a full talk on this (enough real material across the arc). Be honest — a thin corpus means low feasibility.'),
      novelty: z.number().min(0).max(1).describe('0–1: how fresh vs. what has ALREADY been delivered (see the delivered-content inventory). A re-run of an existing talk is low.'),
      rationale: z.string().describe('why give this talk now — the timing/insight/gap it fills'),
      buildsOn: z.array(z.string()).describe('titles from the delivered-content inventory this talk builds on or overlaps (empty if genuinely new ground)'),
    }),
  ),
});

const SYSTEM = `You are an editorial + content strategist mining a company's OWN corpus (recorded talks, calls, podcasts, docs, published posts) for FEASIBLE long-form TALKS the company could give — webinars, workshops, conference talks, podcast episodes, sales sessions, internal training.

You are NOT writing the talk. You are proposing a SLATE of candidate talks, like a ranked idea board — each a concrete talk with a clear GOAL and a positive OUTCOME for the company, grounded in what the corpus can actually support.

Rules:
- Every talk must serve a CONCRETE GOAL and name the positive company OUTCOME (train customers, educate a market, enable sales, drive demand, establish authority, recruit, deep-dive for power users, launch a product). No talk "just because it's interesting" — tie it to an outcome.
- FEASIBILITY is grounded, not aspirational: propose talks the corpus has REAL material for across the whole arc. Every outline segment must cite passage ids (verbatim, as given) that ground it. Score feasibility honestly — thin support = low feasibility, and don't invent an arc the material can't carry.
- NOVELTY vs what's already been delivered: you are given an inventory of the company's existing/delivered content. Prefer NEW talks, deeper cuts, or novel recombinations over re-runs. If a talk overlaps an existing one, list it in buildsOn and score novelty lower.
- Diversity: span goals and audiences. A good slate has a range (a sales-enablement talk, a training deep-dive, a thought-leadership keynote), not five variants of one.
- Never invent facts. The talk's framing is your strategy; the underlying material must come from the passages. Do not cite an id you were not given.
- Quality over quantity. 4–7 strong, feasible talks beat a dozen thin ones. If the corpus only supports a couple, propose a couple.`;

/** Read a diverse corpus sample + the delivered-content inventory and propose grounded, goal-oriented
 *  talks. Optional `goal` focuses the slate. Persists each surviving proposal as 'open'. */
export async function proposeTalks(workspaceId: string, opts: { goal?: string } = {}): Promise<TalkProposal[]> {
  const all = listUtterances(workspaceId, undefined, { admittedOnly: true });
  if (all.length === 0) {
    throw new Error('No corpus yet. Ingest sources (talks, calls, docs) before proposing talks.');
  }
  const sample = diverseSample(all, INPUT_CHARS);
  const validIds = new Set(sample.map((p) => p.id));

  // Delivered-content awareness: the inventory of what the company already has/gave, for novelty.
  const sources = listSources(workspaceId).filter((s) => s.admitted);
  const inventory = sources.length
    ? sources.map((s) => `- ${s.title} [${s.kind}${s.isVoice ? ', published voice' : ''}, ${s.segmentCount} segments]`).join('\n')
    : '(none recorded)';

  const goalLine = opts.goal ? `\n\nFOCUS: propose talks that serve this goal in particular: ${opts.goal}.` : '';

  const result = await structured({
    stage: 'propose-talks',
    system: SYSTEM,
    user: `DELIVERED / EXISTING CONTENT INVENTORY (for novelty — avoid re-running these; build beyond them):\n${inventory}\n\nCORPUS SAMPLE (${sample.length} passages${sample.length < all.length ? `, sampled from ${all.length}` : ''}; format "id: text"):\n\n${renderPassages(sample)}${goalLine}`,
    schema: TalkSchema,
    maxTokens: 10000,
  });

  const created: TalkProposal[] = [];
  for (const t of result.talks) {
    // Ground the outline: keep only segments with ≥1 real receipt (code owns structure, fail-safe).
    const outline: TalkSegment[] = t.outline
      .map((s) => ({ title: s.title.trim(), summary: s.summary.trim(), utteranceIds: s.utteranceIds.filter((id) => validIds.has(id)) }))
      .filter((s) => s.utteranceIds.length > 0);
    if (outline.length < 2) continue; // a talk needs a grounded arc, not one segment — drop it

    const receipts = [...new Set(outline.flatMap((s) => s.utteranceIds))];
    const proposal: NewTalkProposal = {
      workspaceId,
      title: t.title.trim(),
      goal: t.goal.trim(),
      outcome: t.outcome.trim(),
      thesis: t.thesis.trim(),
      audience: t.audience.trim(),
      format: t.format.trim(),
      outline,
      sourceUtteranceIds: receipts,
      feasibility: t.feasibility,
      novelty: t.novelty,
      rationale: t.rationale.trim(),
      buildsOn: t.buildsOn.map((s) => s.trim()).filter(Boolean),
    };
    created.push(insertTalkProposal(proposal));
  }
  return created;
}

/** Mark a proposal as planned (the user intends to develop it into a talk). */
export function planTalk(workspaceId: string, id: string): TalkProposal {
  const t = getTalkProposal(workspaceId, id);
  if (!t) throw new Error('Talk proposal not found.');
  updateTalkProposalStatus(workspaceId, id, 'planned');
  return getTalkProposal(workspaceId, id)!;
}

export function dismissTalk(workspaceId: string, id: string): void {
  const t = getTalkProposal(workspaceId, id);
  if (!t) throw new Error('Talk proposal not found.');
  updateTalkProposalStatus(workspaceId, id, 'dismissed');
}
