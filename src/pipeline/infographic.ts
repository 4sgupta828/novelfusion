// Infographic composer — distills a (already grounded, already provenance-checked) draft into a
// shareable poster SPEC: eyebrow, headline, key stats, takeaway, and which figure to feature. It
// only SELECTS and lightly reframes the draft's own content (like the draft's own hook/takeaway) —
// it invents no new facts, and every stat's number is validated against the draft (grounded pixels,
// not fabricated). The client renders the spec + featured figure into a self-contained SVG poster.

import { z } from 'zod/v4';
import { structured } from '../llm/client.js';
import { getDraft, getUtterancesByIds, saveDraftInfographic } from '../db/index.js';
import type { VizSpec, InfographicPoster } from '../domain/types.js';

const SpecSchema = z.object({
  eyebrow: z.string().describe('a 1–3 word category label, ALL CAPS feel, e.g. "AI GTM"'),
  headline: z.string().describe('the punchline, ≤ 6 words, drawn from the draft'),
  subhead: z.string().describe('one clause of context, ≤ 14 words'),
  stats: z
    .array(z.object({ value: z.string(), label: z.string() }))
    .describe('1–3 headline numbers taken VERBATIM from the draft (value like "$125M" or "72%"); [] if the draft has none'),
  takeaway: z.string().describe('the one thing to remember, ≤ 16 words, from the draft'),
  featureVizIndex: z.number().nullable().describe('index into the draft figures to feature in the poster, or null'),
});


const NUM_RE = /\d[\d,]*(?:\.\d+)?/g;
const core = (s: string) => s.replace(/[,\s]/g, '');

/** Numbers the draft actually contains — the poster's stats must be a subset of these. */
function draftNumbers(content: string, viz: VizSpec[]): Set<string> {
  const set = new Set<string>();
  for (const m of content.match(NUM_RE) ?? []) set.add(core(m));
  for (const v of viz) {
    for (const s of v.series ?? []) set.add(core(String(s.value)));
    for (const g of v.groups ?? []) for (const val of g.values) set.add(core(String(val.value)));
    for (const p of v.points ?? []) { set.add(core(String(p.x))); set.add(core(String(p.y))); }
  }
  return set;
}

/** The dominant source behind the draft's receipts — for the poster's provenance line. */
function sourceLabel(workspaceId: string, provenance: { utteranceIds: string[] }[]): string {
  const ids = [...new Set(provenance.flatMap((p) => p.utteranceIds))];
  if (ids.length === 0) return 'grounded in the workspace corpus';
  const counts = new Map<string, number>();
  for (const u of getUtterancesByIds(workspaceId, ids)) {
    const t = u.sourceTitle;
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : 'grounded in the workspace corpus';
}

/** Compose an infographic poster from a draft AND persist it onto the draft (part of the post). */
export async function suggestInfographic(workspaceId: string, draftId: string): Promise<InfographicPoster> {
  const draft = getDraft(workspaceId, draftId);
  if (!draft) throw new Error(`Draft ${draftId} not found.`);

  const vizSummary = draft.viz.length
    ? draft.viz
        .map((v, i) => {
          const nums = [
            ...(v.series ?? []).map((s) => `${s.label}=${s.value}`),
            ...(v.groups ?? []).flatMap((g) => g.values.map((s) => `${g.label}/${s.name}=${s.value}`)),
          ].join(', ');
          return `[${i}] ${v.kind} "${v.title}"${nums ? ` — ${nums}` : ''}`;
        })
        .join('\n')
    : '(no figures)';

  const spec = await structured({
    stage: 'infographic',
    system:
      'You design a shareable INFOGRAPHIC poster from a marketing draft. Distill the draft into a punchy poster: an eyebrow category, a very short headline, a one-clause subhead, 1–3 KEY STATS taken verbatim from the draft, a takeaway, and which figure (by index) to feature. ' +
      'Use ONLY facts and numbers already in the draft — invent nothing. Every stat value must appear in the draft text. Keep it tight and quotable.',
    user: `DRAFT:\n${draft.content}\n\nFIGURES:\n${vizSummary}`,
    schema: SpecSchema,
    maxTokens: 1500,
  });

  // Ground the stats: keep only those whose number actually occurs in the draft (code-owned guard).
  const known = draftNumbers(draft.content, draft.viz);
  const stats = spec.stats
    .filter((s) => (s.value.match(NUM_RE) ?? []).some((n) => known.has(core(n))))
    .slice(0, 3);

  const idx = spec.featureVizIndex;
  const featureViz = idx != null && idx >= 0 && idx < draft.viz.length ? draft.viz[idx]! : draft.viz[0] ?? null;

  const poster: InfographicPoster = {
    eyebrow: spec.eyebrow.trim(),
    headline: spec.headline.trim(),
    subhead: spec.subhead.trim(),
    stats,
    takeaway: spec.takeaway.trim(),
    featureViz,
    source: sourceLabel(workspaceId, draft.provenance),
  };
  saveDraftInfographic(workspaceId, draftId, poster); // built into the post — persisted + rendered inline
  return poster;
}
