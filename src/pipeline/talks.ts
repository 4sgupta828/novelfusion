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
import { config } from '../config.js';
import {
  listUtterances,
  listSources,
  insertTalkProposal,
  getTalkProposal,
  updateTalkProposalStatus,
  getUtterancesByIdsOrdered,
  getActiveVoicePersona,
  upsertTalkKit,
  getTalkKit,
  type NewTalkProposal,
} from '../db/index.js';
import { hybridSearch } from './retrieval.js';
import { verifySpanAny, numericGrounded, judgeFaithfulness } from './grounding.js';
import type { TalkProposal, TalkSegment, TalkKit, TalkPoint, DevelopedSegment, VoicePersona, Utterance } from '../domain/types.js';

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
    maxTokens: 16000, // 6 talks + grounded outlines is a large object; 10k could truncate the JSON mid-string
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

/** Re-open a planned (or dismissed) proposal back onto the slate. */
export function reopenTalk(workspaceId: string, id: string): TalkProposal {
  const t = getTalkProposal(workspaceId, id);
  if (!t) throw new Error('Talk proposal not found.');
  updateTalkProposalStatus(workspaceId, id, 'open');
  return getTalkProposal(workspaceId, id)!;
}

// ---------- develop: a planned talk → a grounded run-of-show (talk_kit) ----------

const PER_SEGMENT_EXPAND = 12; // extra passages retrieved per segment when corpus-query is on

function personaLine(persona: VoicePersona | null): string {
  if (!persona || !persona.enabled) return '';
  const p = persona.profile;
  const list = (xs?: string[]) => (xs ?? []).filter(Boolean).join('; ');
  const bits = [
    p.summary ? `sounds like ${p.summary}` : '',
    p.register ? `register: ${p.register}` : '',
    p.lexicon?.avoids?.length ? `NEVER uses: ${list(p.lexicon.avoids)}` : '',
  ].filter(Boolean);
  return bits.length ? `\n\nBRAND VOICE (shape tone/framing, never the facts): ${bits.join(' · ')}` : '';
}

const PointSchema = z.object({
  text: z.string().describe('one talking point — a single sentence the speaker can say'),
  zone: z
    .enum(['sourced', 'connective', 'speaker_owned'])
    .describe('sourced = a factual claim backed by a passage (MUST include supportingSpan + utteranceIds); connective = a transition/framing line (no receipts, it is scaffold); speaker_owned = a prompt/blank for the speaker to fill with their own words'),
  supportingSpan: z.string().describe('for sourced points ONLY: a VERBATIM span copied from one cited passage that supports this point. Empty for connective/speaker_owned.'),
  utteranceIds: z.array(z.string()).describe('for sourced points ONLY: the passage ids (verbatim, as labeled) backing this point. Empty otherwise.'),
});

const DevelopSegmentSchema = z.object({
  points: z.array(PointSchema).min(1).describe('the talking points for this segment, in delivery order'),
  speakerNotes: z.string().describe('brief delivery guidance for the speaker (pace, emphasis, what to watch for) — not content claims'),
});

const DEVELOP_SYSTEM = `You develop ONE segment of a talk into a run-of-show a REAL person will deliver. You are NOT writing a script to be read verbatim as if it were the speaker's own authored thinking — you are preparing grounded talking points, honestly labeled.

Every talking point has a ZONE:
- "sourced": a factual claim. It MUST be backed by the provided passages — include a VERBATIM supportingSpan copied from ONE cited passage, and the utteranceIds it rests on. If the passages don't support a claim, DO NOT invent one.
- "connective": a transition, framing, or rhetorical line. No receipts — it is scaffold, and it will be labeled as such (never presented as the speaker's sourced fact).
- "speaker_owned": a prompt for the speaker to fill in their OWN words/story/opinion (e.g. "[Open with your own experience of …]").

Rules:
- Ground every sourced point in the passages given for THIS segment. Never cite an id you were not given. Never fabricate a figure or a quote.
- Prefer honesty over coverage: if the material is thin, produce fewer sourced points and more speaker_owned prompts. A thin segment is fine; a fabricated one is not.
- Do not compute or derive figures the passages don't literally state.
- Keep points tight and speakable.`;

/** Grounding gate for one sourced point (mirrors the Query pipeline: id-validate → span → numeric →
 *  faithfulness). Returns the cleaned point, or null if it fails any gate (coverage-collapse: an
 *  ungrounded claim is dropped, never shown). */
function gateSourced(
  raw: { text: string; supportingSpan: string; utteranceIds: string[] },
  byId: Map<string, WsUtterance>,
): TalkPoint | null {
  const ids = raw.utteranceIds.filter((id) => byId.has(id)); // fail-safe: drop fabricated ids
  if (ids.length === 0) return null;
  const citedTexts = ids.map((id) => byId.get(id)!.text);
  const span = verifySpanAny(citedTexts, raw.supportingSpan);
  if (!span.verified) return null; // the claimed span isn't actually in the cited passages
  if (!numericGrounded(raw.text, citedTexts).ok) return null; // a figure the evidence doesn't print
  return { text: raw.text.trim(), zone: 'sourced', supportingSpan: raw.supportingSpan.trim(), utteranceIds: ids, spanMethod: span.method as 'exact' | 'fuzzy' };
}

const coverageOf = (sourcedCount: number): DevelopedSegment['coverage'] => (sourcedCount >= 3 ? 'full' : sourcedCount >= 1 ? 'partial' : 'thin');

/** Develop a planned talk proposal into a grounded run-of-show. Each outline segment is expanded into
 *  talking points; sourced claims pass the grounding.ts gates (id → span → numeric → faithfulness,
 *  fail-closed), connective/speaker_owned are labeled scaffold. Per-segment coverage is honest — a
 *  segment the corpus can't support becomes a labeled gap, never confabulation. Persists one kit. */
export async function developTalk(workspaceId: string, talkId: string): Promise<TalkKit> {
  const talk = getTalkProposal(workspaceId, talkId);
  if (!talk) throw new Error('Talk proposal not found.');
  if (talk.status === 'dismissed') throw new Error('Cannot develop a dismissed talk.');
  if (talk.outline.length === 0) throw new Error('This proposal has no outline to develop.');

  const persona = getActiveVoicePersona(workspaceId);
  // Faithfulness judge is the different-family (OpenAI) gate — apply it when the corpus-query stack
  // is enabled and a key is present (same policy as the Query pipeline); else deterministic gates only.
  const useFaithfulness = config.flags.corpusQuery && !!process.env.OPENAI_API_KEY;

  const developed: DevelopedSegment[] = [];
  let totalSourced = 0;
  let totalDropped = 0;

  for (const seg of talk.outline) {
    // Grounded passages for this segment: the outline's receipts, expanded via hybrid retrieval when on.
    const byId = new Map<string, WsUtterance>();
    for (const u of getUtterancesByIdsOrdered(workspaceId, seg.utteranceIds)) byId.set(u.id, u as WsUtterance);
    if (config.flags.corpusQuery) {
      try {
        const { ids } = await hybridSearch(workspaceId, `${seg.title}. ${seg.summary}`, { topK: PER_SEGMENT_EXPAND });
        for (const u of getUtterancesByIdsOrdered(workspaceId, ids)) if (!byId.has(u.id)) byId.set(u.id, u as WsUtterance);
      } catch { /* retrieval is best-effort expansion; the seed receipts still ground the segment */ }
    }
    const passages = [...byId.values()];
    const shown = passages.map((p) => `${p.id}: ${p.text}`).join('\n');

    const result = await structured({
      stage: 'develop-talk-segment',
      system: DEVELOP_SYSTEM + personaLine(persona),
      user: `TALK: ${talk.title}\nGOAL: ${talk.goal} — ${talk.outcome}\nAUDIENCE: ${talk.audience}\n\nSEGMENT: ${seg.title}\n${seg.summary}\n\nPASSAGES for this segment (format "id: text"; ground every sourced point here):\n\n${shown || '(no passages — produce speaker_owned prompts only, do not invent sourced claims)'}`,
      schema: DevelopSegmentSchema,
      maxTokens: 4000,
    });

    // Gate each point by zone.
    const sourcedRaw = result.points.filter((p) => p.zone === 'sourced');
    const gatedSourced: (TalkPoint | null)[] = sourcedRaw.map((p) => gateSourced(p, byId));

    // Optional different-family faithfulness pass on survivors (parallel; fail-closed).
    let survivors: TalkPoint[] = gatedSourced.filter((p): p is TalkPoint => p !== null);
    if (useFaithfulness && survivors.length) {
      const verdicts = await Promise.all(
        survivors.map((p) => judgeFaithfulness(p.text, p.utteranceIds.map((id) => byId.get(id)!.text)).catch(() => ({ faithful: false, reason: 'error' }))),
      );
      survivors = survivors.filter((_, i) => verdicts[i]!.faithful);
    }
    totalDropped += sourcedRaw.length - survivors.length;
    totalSourced += survivors.length;

    // Reassemble points in the model's order: keep connective/speaker_owned as-is, swap sourced for survivors.
    const survivorTexts = new Set(survivors.map((s) => s.text.trim()));
    const points: TalkPoint[] = [];
    for (const p of result.points) {
      if (p.zone === 'sourced') {
        const kept = survivors.find((s) => s.text.trim() === p.text.trim());
        if (kept && survivorTexts.has(p.text.trim())) { points.push(kept); survivorTexts.delete(p.text.trim()); }
        // dropped sourced points simply vanish (fail-safe)
      } else {
        points.push({ text: p.text.trim(), zone: p.zone, utteranceIds: [] });
      }
    }

    const sourcedKept = points.filter((p) => p.zone === 'sourced').length;
    const coverage = coverageOf(sourcedKept);
    developed.push({
      title: seg.title,
      summary: seg.summary,
      points,
      speakerNotes: result.speakerNotes.trim(),
      coverage,
      gapNote: coverage === 'thin' ? 'The corpus does not yet support grounded claims for this segment — deliver it from your own experience, or add source material.' : null,
    });
  }

  return upsertTalkKit({
    workspaceId,
    talkId,
    title: talk.title,
    segments: developed,
    grounding: { sourced: totalSourced, dropped: totalDropped, faithfulnessApplied: useFaithfulness },
  });
}

/** The developed run-of-show for a talk, if one exists. */
export function talkKit(workspaceId: string, talkId: string): TalkKit | null {
  return getTalkKit(workspaceId, talkId);
}
