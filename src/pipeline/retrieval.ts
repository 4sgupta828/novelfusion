// Corpus retrieval — the research-system hybrid shape, adapted to Phase-0 SQLite.
// "Retrieval finds, grounding judges." Two recall legs (BM25 lexical + dense cosine) fused
// by Reciprocal Rank Fusion; the fused ids become passage TEXT only through the workspace-
// scoped hydration choke-point (getUtterancesByIdsOrdered) — so a forgotten filter in a leg
// degrades to a dropped candidate, never a cross-workspace leak. The answer is grounded by
// construction: the LLM emits per-claim sentences with a verbatim span + citations, each
// claim is span/numeric/faithfulness-gated (HARD, fail-closed), and the shown answer is the
// concatenation of SURVIVING claims. Zero survivors → a coverage gap, never a fabrication.
//
// Rule 18: the LLM owns meaning (answer authoring, faithfulness); code owns structure (RRF,
// cosine, span presence, numeric presence, workspace/admitted filters). BM25 is recall only.

import { z } from 'zod/v4';
import { structured } from '../llm/client.js';
import { embedTexts, embedQuery, EMBED_MODEL, EMBED_DIM } from '../llm/embed.js';
import {
  getUtterancesByIdsOrdered,
  ftsSearch,
  ftsUpsertPassages,
  ftsIndexedIds,
  listUnembeddedUtterances,
  loadEmbeddings,
  upsertEmbedding,
  listUtterances,
} from '../db/index.js';
import { verifySpanAny, numericGrounded, judgeFaithfulness, type SpanMethod } from './grounding.js';
import type { Utterance } from '../domain/types.js';

const RRF_K = 60;
const DEFAULT_POOL = 40; // per-leg candidate pool
const DEFAULT_TOPK = 8; // passages handed to the answer LLM
const DENSE_WARN_AT = 20000; // brute-force cosine ceiling before Phase-1 pgvector

/** Reciprocal Rank Fusion over ranked id lists. Pure/testable. Union of all legs — a leg
 *  never removes what another surfaced; it only contributes rank weight. */
export function rrfFuse(lists: string[][], k = RRF_K): string[] {
  const score = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (k + rank)));
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Embed + FTS-index every admitted, not-yet-indexed passage in a workspace. Idempotent;
 *  best-effort — a failed OpenAI call leaves passages unembedded (dense leg skips them; FTS
 *  still covers them) rather than throwing. NEVER called from the ingest commit path. */
export async function embedBackfill(workspaceId: string): Promise<{ embedded: number; ftsIndexed: number; error?: string }> {
  // FTS: index any admitted passage missing from the FTS table (cheap, no external call).
  const already = ftsIndexedIds(workspaceId);
  const allAdmitted = listUtterances(workspaceId, undefined, { admittedOnly: true });
  const toIndex = allAdmitted.filter((u) => !already.has(u.id));
  if (toIndex.length > 0) ftsUpsertPassages(toIndex.map((u) => ({ id: u.id, workspaceId, text: u.text })));

  // Dense: embed any admitted passage without a vector for the current model.
  const pending = listUnembeddedUtterances(workspaceId, EMBED_MODEL);
  let embedded = 0;
  if (pending.length > 0) {
    try {
      const vecs = await embedTexts(pending.map((p) => p.text), 'embed_backfill');
      for (let i = 0; i < pending.length; i++) {
        upsertEmbedding({ utteranceId: pending[i]!.id, workspaceId, model: EMBED_MODEL, dim: EMBED_DIM, vec: vecs[i]! });
        embedded++;
      }
    } catch (e) {
      return { embedded, ftsIndexed: toIndex.length, error: String(e) };
    }
  }
  return { embedded, ftsIndexed: toIndex.length };
}

/** Dense recall leg. Returns ids best-first. Workspace + model + dim scoped in SQL; empty if
 *  nothing embedded yet (graceful degrade to BM25-only). */
export async function denseSearch(workspaceId: string, query: string, poolK: number): Promise<string[]> {
  const rows = loadEmbeddings(workspaceId, EMBED_MODEL, EMBED_DIM);
  if (rows.length === 0) return [];
  if (rows.length > DENSE_WARN_AT) {
    // eslint-disable-next-line no-console
    console.warn(`[retrieval] dense leg scanning ${rows.length} vectors in workspace ${workspaceId} (>${DENSE_WARN_AT}); consider Phase-1 pgvector.`);
  }
  const q = await embedQuery(query);
  return rows
    .map((r) => ({ id: r.id, s: cosine(q, r.vec) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, poolK)
    .map((r) => r.id);
}

export interface HybridResult {
  ids: string[];
  legs: { fts: string[]; dense: string[] };
}

/** Fuse the two recall legs. Returns fused ids (ranked) + per-leg ids for the trace. */
export async function hybridSearch(
  workspaceId: string,
  query: string,
  opts: { topK?: number; poolK?: number } = {},
): Promise<HybridResult> {
  const poolK = opts.poolK ?? DEFAULT_POOL;
  const topK = opts.topK ?? DEFAULT_TOPK;
  const fts = ftsSearch(workspaceId, query, poolK);
  const dense = await denseSearch(workspaceId, query, poolK);
  const ids = rrfFuse([dense, fts]).slice(0, topK);
  return { ids, legs: { fts, dense } };
}

const AnswerSchema = z.object({
  covered: z.boolean().describe('true only if the passages actually answer the question'),
  claims: z.array(
    z.object({
      sentence: z.string().describe('one publishable sentence answering part of the question, asserting only what the passages state'),
      supportingSpan: z.string().describe('a VERBATIM span copied from ONE cited passage that supports this sentence'),
      utteranceIds: z.array(z.string()).describe('ids (exactly as labeled U:<id>) of the passages that support this sentence'),
    }),
  ),
});

const ANSWER_SYSTEM = `You answer a question STRICTLY from the provided corpus passages. This is a grounded research surface, not a creative writer.
Rules:
- Use ONLY the passages. Never add outside knowledge, industry-typical values, or inferred consequences.
- Each claim sentence must be supported by a VERBATIM span you copy from one of its cited passages, and must cite the passage ids (U:<id>) it rests on.
- Do not compute, normalize, or derive figures (no turning "5,000 → 7,000" into "40% growth") unless a passage literally prints that figure.
- Preserve attribution, modality (proposed ≠ approved), and polarity (respect negation/sarcasm). Never present [WEB] text as something a person said.
- If the passages do not actually answer the question, set covered=false and return an empty claims list. Abstaining is correct; padding is not.`;

export interface GroundedClaim {
  sentence: string;
  supportingSpan: string;
  utteranceIds: string[];
  spanMethod: SpanMethod;
}

export interface QueryResult {
  gap: boolean;
  answer: string | null;
  claims: GroundedClaim[];
  passages: (Utterance & { workspaceId: string })[];
  trace: {
    fts: string[];
    dense: string[];
    fused: string[];
    claimsProposed: number;
    dropped: { sentence: string; reason: string }[];
    coverageReason?: string;
  };
}

function passageLabel(u: Utterance): string {
  const loc = u.locator;
  const cls = u.provenanceClass === 'human_utterance' ? 'SPOKEN' : u.provenanceClass === 'owned_document' ? 'DOC' : 'WEB';
  const who = u.speaker ? ` ${u.speaker}:` : '';
  const where = loc.kind === 'document' ? (loc.page ? ` p.${loc.page}` : '') : loc.kind === 'webpage' ? ' (web)' : '';
  return `[${cls}${where}] U:${u.id}${who} ${u.text}`;
}

/**
 * Full query pipeline. FAILS CLOSED: any claim that can't clear span + numeric + faithfulness
 * gates is dropped; the answer is only the surviving claims; zero survivors → a coverage gap.
 */
export async function answerQuery(
  workspaceId: string,
  query: string,
  opts: { topK?: number; poolK?: number } = {},
): Promise<QueryResult> {
  const { ids, legs } = await hybridSearch(workspaceId, query, opts);
  // Hydrate ONLY through the workspace-scoped choke-point (foreign ids vanish here).
  const passages = getUtterancesByIdsOrdered(workspaceId, ids);
  const allowedIds = new Set(passages.map((p) => p.id));
  const byId = new Map(passages.map((p) => [p.id, p]));

  const emptyTrace = { fts: legs.fts, dense: legs.dense, fused: ids };

  if (passages.length === 0) {
    return { gap: true, answer: null, claims: [], passages: [], trace: { ...emptyTrace, claimsProposed: 0, dropped: [], coverageReason: 'no passages retrieved' } };
  }

  const corpus = passages.map(passageLabel).join('\n\n');
  const proposal = await structured({
    stage: 'corpus_query',
    schema: AnswerSchema,
    system: ANSWER_SYSTEM,
    user: `QUESTION:\n${query}\n\nPASSAGES:\n${corpus}`,
  });

  const dropped: { sentence: string; reason: string }[] = [];
  if (!proposal.covered || proposal.claims.length === 0) {
    return { gap: true, answer: null, claims: [], passages, trace: { ...emptyTrace, claimsProposed: proposal.claims.length, dropped, coverageReason: 'model reported not covered' } };
  }

  const survivors: GroundedClaim[] = [];
  for (const c of proposal.claims) {
    // Citations must be within the passages we actually handed the model (drops hallucinated ids).
    // The model sometimes echoes the "U:" label prefix — strip it before matching.
    const citedIds = c.utteranceIds.map((id) => id.replace(/^U:/, '')).filter((id) => allowedIds.has(id));
    if (citedIds.length === 0) { dropped.push({ sentence: c.sentence, reason: 'no valid citation' }); continue; }
    // Re-fetch cited passages through the choke-point (workspace-scoped; never bare-id/global).
    const citedTexts = getUtterancesByIdsOrdered(workspaceId, citedIds).map((u) => u.text);

    const span = verifySpanAny(citedTexts, c.supportingSpan);
    if (!span.verified) { dropped.push({ sentence: c.sentence, reason: `span ${span.method}` }); continue; }

    const num = numericGrounded(c.sentence, citedTexts);
    if (!num.ok) { dropped.push({ sentence: c.sentence, reason: `ungrounded number(s): ${num.missing.join(', ')}` }); continue; }

    const faith = await judgeFaithfulness(c.sentence, citedTexts);
    if (!faith.faithful) { dropped.push({ sentence: c.sentence, reason: `unfaithful: ${faith.reason}` }); continue; }

    survivors.push({ sentence: c.sentence, supportingSpan: c.supportingSpan, utteranceIds: citedIds, spanMethod: span.method });
  }

  if (survivors.length === 0) {
    return { gap: true, answer: null, claims: [], passages, trace: { ...emptyTrace, claimsProposed: proposal.claims.length, dropped, coverageReason: 'all claims failed grounding gates' } };
  }

  // Grounded by construction: the answer IS the surviving claims. Cited passages only.
  const citedPassageIds = new Set(survivors.flatMap((s) => s.utteranceIds));
  const shownPassages = passages.filter((p) => citedPassageIds.has(p.id));
  return {
    gap: false,
    answer: survivors.map((s) => s.sentence).join(' '),
    claims: survivors,
    passages: shownPassages,
    trace: { ...emptyTrace, claimsProposed: proposal.claims.length, dropped },
  };
}
