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
import { getTemplate, type ContentTemplate } from '../domain/templates.js';

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

const VizSchema = z.object({
  kind: z.enum(['bar', 'pie', 'line', 'table', 'stat']),
  title: z.string(),
  caption: z.string().describe('One line: what the figure shows and why it matters'),
  unit: z.string().nullable().describe("Unit for values, e.g. '$', '%', 'min' — null if none"),
  afterSection: z.string().nullable().describe('Section key to render this figure after (null = end)'),
  series: z
    .array(z.object({ label: z.string(), value: z.number() }))
    .nullable()
    .describe('For bar/pie/line/stat: labeled numeric values. null for table.'),
  table: z
    .object({ columns: z.array(z.string()), rows: z.array(z.array(z.string())) })
    .nullable()
    .describe('For table kind: header + data rows. null otherwise.'),
  utteranceIds: z.array(z.string()).describe('Source utterance IDs (verbatim) the FIGURES came from'),
});

const DraftSchema = z.object({
  content: z.string().describe('The full asset as plain text/markdown (all sections concatenated). Ready to publish.'),
  sections: z
    .array(z.object({ key: z.string(), title: z.string(), body: z.string() }))
    .nullable()
    .describe('One entry per template section, in order. null for freeform.'),
  viz: z
    .array(VizSchema)
    .nullable()
    .describe('Charts/tables — ONLY where the source contains real quantitative data that a figure clarifies. Empty/null if none warranted; never fabricate numbers.'),
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
Write in the authentic voice of the people on the record — use the SPOKEN segments for voice, wording, and thesis; use DOC/WEB segments as supporting evidence (facts, numbers, framing), not as the voice.

Hard rules:
- Every claim in the draft must be grounded in the provided source segments. Report each claim-bearing span with its source segment IDs.
- Never invent facts, numbers, customers, or quotes. If the sources don't support a claim, leave it out.
- Do not attribute a spoken opinion to a document or a web page, or vice versa.
- No engagement-bait, no hashtag spam, no "I'm humbled to announce".${principleBlock}`;
}

export async function proposeStubs(workspaceId: string, momentId: string): Promise<WeaveStub[]> {
  const moment = getMoment(workspaceId, momentId);
  if (!moment) throw new Error(`Moment ${momentId} not found in workspace ${workspaceId}`);
  const utterances = getUtterancesByIds(workspaceId, moment.utteranceIds);
  const src = utterances.map((u) => `${segLabel(u)}: ${u.text}`).join('\n');

  const result = await structured({
    stage: 'weave-stubs',
    system: STUB_SYSTEM,
    user: `Moment claim: ${moment.claim}\nWhy now: ${moment.judgment.whyNow}\n\nSource segments:\n${src}\n\nPropose 6-10 distinct weavings.`,
    schema: StubSchema,
  });
  return result.stubs;
}

const ProvenanceOnlySchema = z.object({
  provenance: z.array(
    z.object({
      quote: z.string().describe('A claim-bearing span of the draft'),
      utteranceIds: z.array(z.string()).describe('Source segment IDs (verbatim) grounding that span'),
    }),
  ),
});

/** Source line label per segment kind (transcript → speaker@time; doc → §heading; web → §anchor). */
function segLabel(u: Utterance): string {
  if (u.locator.kind === 'transcript') {
    return `[SPOKEN] ${u.id} | ${u.speaker ?? '?'}${u.tStartSec != null ? ` @${u.tStartSec}s` : ''}`;
  }
  if (u.locator.kind === 'document') {
    return `[DOC] ${u.id} | ${u.sourceTitle ?? 'doc'}${u.locator.heading ? ` §${u.locator.heading}` : ''}`;
  }
  return `[WEB] ${u.id} | ${u.sourceTitle ?? 'web'}${u.locator.anchor ? ` §${u.locator.anchor}` : ''}`;
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

function templateBlock(template: ContentTemplate): string {
  if (!template.sections) {
    return '';
  }
  const keys = template.sections.map((s) => s.key).join(', ');
  return (
    `\n\nTEMPLATE — "${template.name}". Structure the piece as these ordered sections (return them in "sections", ` +
    `one entry per section with its key, a short display title, and the body). Also concatenate them into "content" ` +
    `as the full publishable text. Section keys and their editorial intent:\n` +
    template.sections.map((s) => `- ${s.key} (${s.title}): ${s.intent}`).join('\n') +
    `\nUse exactly these section keys: ${keys}. For a short format (li_post, x_thread), you may fold weaker sections ` +
    `together but keep the strongest 3–4 moves.`
  );
}

const VIZ_GUIDANCE = `\n\nFIGURES — emit charts/tables ONLY when the source contains real quantitative data a figure genuinely clarifies (a ratio, a breakdown, a before/after, a trend, a headline number). Rules:
- Never fabricate or estimate numbers. Every value must come from the source utterances; put those utterance IDs in the figure's utteranceIds.
- Pick the form by the data's job: 'bar' to compare magnitudes across categories, 'pie' for parts of a whole (2–5 slices), 'line' for change over time, 'table' for a small labeled matrix, 'stat' for a single headline number.
- Set afterSection to the section key the figure supports. Give every figure a title and a one-line caption.
- Prefer at most 1–2 figures. If the source has no hard numbers, return an empty figures list — a figure with no real data is worse than none.`;

export async function weaveDraft(
  workspaceId: string,
  momentId: string,
  format: AssetFormat,
  angle = 'default',
  opts: { holdout?: boolean; withConstitution?: boolean; template?: string } = {},
): Promise<Draft> {
  const moment = getMoment(workspaceId, momentId);
  if (!moment) throw new Error(`Moment ${momentId} not found in workspace ${workspaceId}`);
  const template = getTemplate(opts.template);
  const cited = getUtterancesByIds(workspaceId, moment.utteranceIds);
  const citedIds = new Set(cited.map((u) => u.id));

  // clip_spec is transcript-only: a doc/web segment has no timing, so a video cut
  // plan would force the model to fabricate timestamps (Rule 18 / never-invent). Gate it.
  if (format === 'clip_spec' && cited.some((u) => u.locator.kind !== 'transcript')) {
    throw new Error('clip_spec requires transcript-grounded moments (documents/web pages have no timing). Weave a text format instead.');
  }

  // Give the writer the surrounding argument, all of it citable (receipts still resolve).
  const context = expandContext(workspaceId, cited);
  const validIds = new Set(context.map((u) => u.id));
  const src = context.map((u) => `${citedIds.has(u.id) ? '★' : ' '} ${segLabel(u)}: ${u.text}`).join('\n');

  const useConstitution = opts.withConstitution ?? true;
  const active = useConstitution
    ? listPrinciples(workspaceId, 'active').filter((p) => inScope(p, format)).slice(0, config.maxInContextPrinciples)
    : [];

  const result = await structured({
    stage: 'weave-draft',
    system: draftSystem(active),
    user:
      `Write this asset: ${FORMAT_SPECS[format]}\nAngle: ${angle}\nCentral moment (the piece's thesis): ${moment.claim}` +
      templateBlock(template) +
      VIZ_GUIDANCE +
      `\n\nSource segments (★ = the segments the moment cites; unstarred lines are surrounding context — ALL lines are citable. [SPOKEN] carries a real person's voice; [DOC]/[WEB] are supporting evidence):\n${src}` +
      (useConstitution ? exemplarBlock(workspaceId) : ''),
    schema: DraftSchema,
    maxTokens: 20000,
  });

  // Critique-and-revise pass against the same principles (CAI-style application).
  let content = result.content;
  let revised = false;
  if (active.length > 0) {
    const out = await generate({
      stage: 'weave-revise',
      system: draftSystem(active),
      user:
        `Review this draft against the editorial constitution above. If it complies, return it UNCHANGED. ` +
        `If any principle is violated, return a minimally revised version that complies. Return ONLY the draft text.\n\n${content}`,
    });
    revised = out.trim() !== content.trim();
    content = out;
  }

  // Provenance must map the FINAL content, not the pre-revision draft (panel bug fix:
  // the revise pass can alter wording, leaving receipts pointing at spans that no
  // longer exist). Re-derive against the revised text when it changed.
  let rawProvenance = result.provenance;
  if (revised) {
    const reprov = await structured({
      stage: 'weave-reprovenance',
      system:
        'You map claim-bearing spans of a finished draft to the source segment IDs that ground them. ' +
        'Report each claim span and its source segment IDs (verbatim from the list). Only spans grounded in the sources.',
      user: `Source segments:\n${src}\n\nFinished draft:\n${content}`,
      schema: ProvenanceOnlySchema,
    });
    rawProvenance = reprov.provenance;
  }

  const provenance = rawProvenance
    .map((p) => ({ quote: p.quote, utteranceIds: p.utteranceIds.filter((id) => validIds.has(id)) }))
    .filter((p) => p.utteranceIds.length > 0);

  // Structure keeps only sections whose keys the template declared; figures keep
  // only provenance IDs that resolve (same discipline as text provenance).
  const templateKeys = new Set(template.sections?.map((s) => s.key) ?? []);
  const sections = (result.sections ?? []).filter((s) => templateKeys.size === 0 || templateKeys.has(s.key));
  const viz = (result.viz ?? [])
    .filter(vizHasData)
    .map((v) => ({
      kind: v.kind,
      title: v.title,
      caption: v.caption,
      unit: v.unit ?? undefined,
      afterSection: v.afterSection ?? undefined,
      series: v.series ?? undefined,
      table: v.table ?? undefined,
      utteranceIds: v.utteranceIds.filter((id) => validIds.has(id)),
    }));

  const draft: Draft = {
    id: newId('drf'),
    workspaceId,
    momentId,
    format,
    angle,
    template: template.id,
    content,
    sections,
    viz,
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

/** Code owns structure: drop a figure that carries no usable data (Rule 18 —
 *  the model decides IF a figure is warranted; code enforces that it isn't empty). */
function vizHasData(v: { series?: unknown; table?: { rows?: unknown[] } | null }): boolean {
  if (Array.isArray(v.series) && v.series.length > 0) return true;
  if (v.table && Array.isArray(v.table.rows) && v.table.rows.length > 0) return true;
  return false;
}
