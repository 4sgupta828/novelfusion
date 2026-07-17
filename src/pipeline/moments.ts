// Moment extraction — the LLM owns meaning here (Rule 18): what counts as a
// publishable moment, novelty, credibility, risk. Code owns chunking, ID
// validation, and persistence.

import { z } from 'zod/v4';
import { structured } from '../llm/client.js';
import { insertMoment, listUtterances, newId, existingMomentKeys, momentKey } from '../db/index.js';
import type { Moment, Utterance } from '../domain/types.js';

const MomentSchema = z.object({
  moments: z.array(
    z.object({
      utteranceIds: z.array(z.string()).describe('IDs of the utterances (verbatim from input) this moment is grounded in'),
      claim: z.string().describe("The publishable insight, in the speaker's own words as far as possible"),
      novelty: z.number().describe('0-1: how novel vs. typical published content in this space'),
      credibility: z.number().describe('0-1: how credible is this speaker on this topic'),
      riskFlags: z.array(
        z.object({
          kind: z.enum(['named_customer', 'forward_looking', 'competitor_mention', 'sensitive']),
          note: z.string(),
        }),
      ),
      whyNow: z.string().describe('One line: why this is worth publishing now'),
    }),
  ),
});

const SYSTEM = `You are the moment-extraction stage of an editorial pipeline for B2B thought leadership.
From a corpus you identify "moments": specific, contrarian-or-concrete, publishable insights — strong claims, market predictions, hard-won tactical advice, sharp framings of customer pain.

Each source segment is tagged with a provenance class:
- [SPOKEN] — a real human said this on the record (transcript). This is the PRIMARY grounding for a moment; it carries a real person's voice and consent.
- [DOC] — an owned company document (deck, memo, one-pager). SUPPORTING evidence — a fact, number, or framing that backs a spoken claim.
- [WEB] — a public web page. SUPPORTING evidence only (external context, published claims).

Rules:
- A moment must be grounded in the provided segments; cite their IDs exactly as given.
- PREFER moments grounded in [SPOKEN] segments. A [DOC]/[WEB] segment may SUPPORT a moment, but do not build a moment solely from a document or web page unless it is a genuinely strong standalone data point — and never treat public web text as if a person said it.
- Prefer distinctive, opinionated claims over consensus statements. "Quality matters" is not a moment; "we killed our SLA dashboard because it optimized the wrong fear" is.
- Do not invent, embellish, or fuse unrelated claims across sources.
- Flag risks honestly (named customers, forward-looking statements, competitor mentions, sensitive/confidential material).
- If a chunk contains no genuine moments, return an empty list. Abstaining is correct; padding is not.`;

const CHUNK_CHARS = 8000;

function chunkUtterances(utterances: Utterance[]): Utterance[][] {
  const chunks: Utterance[][] = [];
  let current: Utterance[] = [];
  let size = 0;
  for (const u of utterances) {
    if (size + u.text.length > CHUNK_CHARS && current.length > 0) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(u);
    size += u.text.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

const CLASS_TAG: Record<string, string> = { human_utterance: 'SPOKEN', owned_document: 'DOC', public_web: 'WEB' };

function segLine(u: Utterance & { sourceTitle?: string }): string {
  const tag = CLASS_TAG[u.provenanceClass] ?? 'SPOKEN';
  if (u.locator.kind === 'transcript') {
    return `[${tag}] ${u.id} | ${u.speaker ?? '?'}${u.tStartSec != null ? ` @${u.tStartSec}s` : ''}: ${u.text}`;
  }
  if (u.locator.kind === 'document') {
    const h = u.locator.heading ? ` §${u.locator.heading}` : '';
    return `[${tag}] ${u.id} | doc${h}: ${u.text}`;
  }
  const h = u.locator.anchor ? ` §${u.locator.anchor}` : '';
  return `[${tag}] ${u.id} | web${h}: ${u.text}`;
}

export async function extractMoments(workspaceId: string): Promise<{ created: Moment[]; skipped: number }> {
  // Extraction reads only ADMITTED sources (ingest quarantine — a pending doc never
  // reaches the pipeline until a human admits it). Per-source order preserves context.
  const utterances = listUtterances(workspaceId, undefined, { admittedOnly: true });
  if (utterances.length === 0) throw new Error(`No admitted sources in workspace ${workspaceId} — ingest and admit sources first.`);

  // Re-extract is dedup-on-write: extraction re-mines the whole admitted corpus each run, but a
  // moment whose utterance-id set already exists (in ANY state — including rejected) is not
  // re-inserted. So re-running after a new doc adds only genuinely new moments and never
  // resurrects a killed one. Limitation (Rule 9): a re-run that groups the same utterances
  // slightly differently yields a distinct key, so near-duplicate groupings can still slip through.
  const seen = existingMomentKeys(workspaceId);
  const created: Moment[] = [];
  let skipped = 0;
  for (const chunk of chunkUtterances(utterances)) {
    const validIds = new Set(chunk.map((u) => u.id));
    const input = chunk.map(segLine).join('\n');

    const result = await structured({
      stage: 'extract-moments',
      system: SYSTEM,
      user: `Corpus segments (format: [CLASS] segmentId | source: text):\n\n${input}`,
      schema: MomentSchema,
    });

    for (const m of result.moments) {
      // Code owns structure: reject hallucinated utterance IDs outright (fail safe).
      const ids = m.utteranceIds.filter((id) => validIds.has(id));
      if (ids.length === 0) continue;
      const key = momentKey(ids);
      if (seen.has(key)) { skipped++; continue; } // already extracted (any state) — never duplicate
      seen.add(key);
      const moment: Moment = {
        id: newId('mom'),
        workspaceId,
        utteranceIds: ids,
        claim: m.claim,
        judgment: { novelty: m.novelty, credibility: m.credibility, riskFlags: m.riskFlags, whyNow: m.whyNow },
        score: 0.6 * m.novelty + 0.4 * m.credibility,
        state: 'slated',
        rejectionChip: null,
      };
      insertMoment(moment);
      created.push(moment);
    }
  }
  return { created, skipped };
}
