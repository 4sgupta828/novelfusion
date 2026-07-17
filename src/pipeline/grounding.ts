// Grounding gates for the corpus-query answer. "Retrieval finds, grounding judges."
// Two deterministic gates (code owns structure) + one LLM gate (a DIFFERENT model family
// owns meaning):
//   1. verifySpan — the claim's quoted span is verbatim-present in a CITED passage.
//   2. numericGrounded — every value-shaped token in the claim appears in the evidence
//      (catches computed/normalized figures the evidence never printed).
//   3. judgeFaithfulness — OpenAI (different family from the Anthropic drafter): does the
//      claim assert only what its evidence states, with correct attribution/modality/polarity?
// All are HARD and fail CLOSED: a claim that can't clear them is dropped; zero survivors → a
// coverage gap, never a hallucinated answer. This surface is marketing-adjacent, so a wrong
// "grounded" claim is worse than a refusal.

import { getOpenAI, openaiTrace } from '../llm/openai.js';

const MIN_SPAN_CHARS = 12;
const FUZZY_THRESHOLD = 0.95;
const MAX_PASSAGE_CHARS = 20000; // bound the LCS cost

/** NFKC + fold smart quotes/dashes/ellipsis + collapse whitespace + lowercase. The
 *  document/web ingesters already collapse whitespace; this also absorbs the typographic
 *  drift (curly quotes, ligatures, en/em dashes) the model silently introduces in a quote. */
export function normalizeForSpan(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Length of the longest common subsequence (char-level), bounded. */
function lcsLen(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0 || n === 0) return 0;
  let prev = new Uint32Array(n + 1);
  let curr = new Uint32Array(n + 1);
  for (let i = 1; i <= m; i++) {
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      curr[j] = ai === b.charCodeAt(j - 1) ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

export type SpanMethod = 'exact' | 'fuzzy' | 'too_short' | 'absent';

/** Deterministic span check against ONE passage. Tier 1: exact substring after
 *  normalization. Tier 2: fuzzy — ≥95% of the span's characters appear in-order in the
 *  passage (absorbs ligature/quote/hyphenation drift a naive substring false-fails on).
 *  Spans below a minimum substance are not verifiable this way and fail closed
 *  (a 3-char span matches too much — Rule 9: this is a knowingly-approximate tier). */
export function verifySpan(passageText: string, span: string): { verified: boolean; method: SpanMethod } {
  const p = normalizeForSpan(passageText).slice(0, MAX_PASSAGE_CHARS);
  const s = normalizeForSpan(span);
  if (s.length < MIN_SPAN_CHARS) return { verified: false, method: 'too_short' };
  if (p.includes(s)) return { verified: true, method: 'exact' };
  if (lcsLen(s, p) / s.length >= FUZZY_THRESHOLD) return { verified: true, method: 'fuzzy' };
  return { verified: false, method: 'absent' };
}

/** Span must be present in at least one of the passages the claim CITED — never checked
 *  against the corpus at large (that both false-passes and reopens the cross-tenant hole). */
export function verifySpanAny(passageTexts: string[], span: string): { verified: boolean; method: SpanMethod } {
  let worst: SpanMethod = 'absent';
  for (const t of passageTexts) {
    const r = verifySpan(t, span);
    if (r.verified) return r;
    if (r.method === 'too_short') worst = 'too_short';
  }
  return { verified: false, method: worst };
}

/** Value-shaped tokens: currency, decimals, percents. Deliberately NOT bare integers/years
 *  (too collision-prone), matching the research system's prose value-leak guard. */
const VALUE_RE = /(?:\$\s?\d[\d,]*(?:\.\d+)?)|(?:\b\d[\d,]*\.\d+%?)|(?:\b\d[\d,]*%)/g;
const NUM_CORE_RE = /\d[\d,]*(?:\.\d+)?/g;

const digitCore = (tok: string) => tok.replace(/[,\s$%]/g, '');

/** Every value token asserted in the claim must appear as a number in the cited evidence.
 *  Catches "grew 5,000 → 7,000" (evidence) reported as "40% growth" (claim) — a computed
 *  figure the evidence never literally prints. Code-owned structure; the meaning call is
 *  the faithfulness judge. */
export function numericGrounded(claimText: string, evidenceTexts: string[]): { ok: boolean; missing: string[] } {
  const claimTokens = claimText.match(VALUE_RE) ?? [];
  if (claimTokens.length === 0) return { ok: true, missing: [] };
  const evidenceCores = new Set<string>();
  for (const e of evidenceTexts) for (const m of e.match(NUM_CORE_RE) ?? []) evidenceCores.add(digitCore(m));
  const missing = claimTokens.map(digitCore).filter((c) => !evidenceCores.has(c));
  return { ok: missing.length === 0, missing };
}

/** Different-family (OpenAI) faithfulness judge. Fails CLOSED: any error → not faithful. */
export async function judgeFaithfulness(
  claimText: string,
  evidenceTexts: string[],
): Promise<{ faithful: boolean; reason: string }> {
  const evidence = evidenceTexts.map((t, i) => `[E${i + 1}] ${t}`).join('\n');
  const system =
    'You are an adversarial grounding auditor. Decide whether a CLAIM is faithful to its cited EVIDENCE. ' +
    'Set faithful=false if the claim: asserts a number/unit/percentage the evidence does not literally state ' +
    '(never credit a computed or per-unit figure from an aggregate, or vice versa); attributes a statement to the ' +
    'wrong speaker; changes modality (proposed→did, may→will); inverts polarity (negation/sarcasm); or generalizes ' +
    'beyond what the evidence supports. Judge ONLY faithfulness to the cited evidence, not truth in the world. ' +
    'When uncertain, faithful=false. Respond as JSON: {"faithful": boolean, "reason": string}.';
  const user = `CLAIM:\n${claimText}\n\nEVIDENCE:\n${evidence}`;
  try {
    const res = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    openaiTrace({ stage: 'faithfulness_judge', model: 'gpt-4o', usage: res.usage, promptChars: system.length + user.length });
    const parsed = JSON.parse(res.choices[0]?.message?.content ?? '{}');
    return { faithful: parsed.faithful === true, reason: String(parsed.reason ?? '') };
  } catch (e) {
    openaiTrace({ stage: 'faithfulness_judge', model: 'gpt-4o', error: String(e) });
    return { faithful: false, reason: 'judge_error (fail-closed)' };
  }
}
