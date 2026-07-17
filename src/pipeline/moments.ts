// Moment extraction — the LLM owns meaning here (Rule 18): what counts as a
// publishable moment, novelty, credibility, risk. Code owns chunking, ID
// validation, and persistence.

import { z } from 'zod/v4';
import { structured } from '../llm/client.js';
import { insertMoment, listUtterances, newId } from '../db/index.js';
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
From a diarized transcript you identify "moments": specific, contrarian-or-concrete, publishable insights actually said by a speaker — strong claims, market predictions, hard-won tactical advice, sharp framings of customer pain.

Rules:
- A moment must be grounded in the provided utterances; cite their IDs exactly as given.
- Prefer distinctive, opinionated claims over consensus statements. "Quality matters" is not a moment; "we killed our SLA dashboard because it optimized the wrong fear" is.
- Do not invent, embellish, or combine claims across speakers.
- Flag risks honestly (named customers, forward-looking statements, competitor mentions, sensitive topics).
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

export async function extractMoments(workspaceId: string): Promise<Moment[]> {
  const utterances = listUtterances(workspaceId);
  if (utterances.length === 0) throw new Error(`No utterances in workspace ${workspaceId} — run ingest first.`);

  const created: Moment[] = [];
  for (const chunk of chunkUtterances(utterances)) {
    const validIds = new Set(chunk.map((u) => u.id));
    const input = chunk.map((u) => `${u.id} | ${u.speaker}${u.tStartSec != null ? ` @${u.tStartSec}s` : ''}: ${u.text}`).join('\n');

    const result = await structured({
      stage: 'extract-moments',
      system: SYSTEM,
      user: `Transcript chunk (format: utteranceId | speaker: text):\n\n${input}`,
      schema: MomentSchema,
    });

    for (const m of result.moments) {
      // Code owns structure: reject hallucinated utterance IDs outright (fail safe).
      const ids = m.utteranceIds.filter((id) => validIds.has(id));
      if (ids.length === 0) continue;
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
  return created;
}
