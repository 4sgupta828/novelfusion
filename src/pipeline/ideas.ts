// Ideas pipeline — the scratch space UPSTREAM of the slate. Two on-demand generators:
//   generateIdeaClusters — reads a diverse sample of the whole corpus and surfaces NOVEL-FUSION
//     clusters: non-obvious juxtapositions of themes that, combined, yield a fresh POV. Each
//     cluster ships 2–3 seed ideas.
//   brainstormIdeas — directed generation from a prompt, optionally through a named expert's lens
//     (a collaborator) and optionally refining an existing idea. Uses hybrid retrieval when the
//     corpus-query flag is on, else a diverse sample.
// Ideas are candidates, never drafts: promoteIdeaToMoment is the ONLY path into the governed
// pipeline (→ slate). Rule 18: the LLM owns which fusions are novel and worth pursuing; code owns
// structure — every cited utterance id is validated against the passages actually shown to the
// model (fabricated ids are dropped, fail-safe), so each idea carries real receipts.

import { z } from 'zod/v4';
import { structured } from '../llm/client.js';
import { config } from '../config.js';
import {
  listUtterances,
  getUtterancesByIdsOrdered,
  insertIdea,
  getIdea,
  updateIdeaStatus,
  insertMoment,
  getCollaborator,
  newId,
  type NewIdea,
} from '../db/index.js';
import { hybridSearch } from './retrieval.js';
import type { Idea, Moment, Utterance } from '../domain/types.js';

const CLUSTER_INPUT_CHARS = 32000; // broad read: fusion needs cross-source range
const BRAINSTORM_INPUT_CHARS = 16000;

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

// ---------- idea clusters ----------

const SeedIdeaSchema = z.object({
  text: z.string().describe('a sharp, publishable idea/angle (one or two sentences) that this fusion makes possible'),
  rationale: z.string().describe('why this is worth saying now — the tension or insight it resolves'),
  novelty: z.number().min(0).max(1).describe('0–1: how non-obvious this is vs. the median take in this space'),
  utteranceIds: z.array(z.string()).describe('ids (verbatim, as labeled) of the passages this idea rests on'),
});

const ClusterSchema = z.object({
  clusters: z.array(
    z.object({
      title: z.string().describe('a short, evocative name for this fusion'),
      thesis: z.string().describe('the novel-fusion thesis: the two+ threads being combined and the non-obvious POV their combination produces'),
      ideas: z.array(SeedIdeaSchema).min(1).max(3),
    }),
  ),
});

const CLUSTER_SYSTEM = `You are an editorial strategist mining a company's own corpus for NOVEL FUSIONS — non-obvious connections between separate threads that, combined, produce a fresh, defensible point of view worth publishing.

You are NOT summarizing the corpus or listing its topics. You are looking for the sparks: where a claim in one place and a claim in another, put together, say something the company could own that no one is saying yet.

Rules:
- Prefer TENSION and JUXTAPOSITION over restatement. A good cluster combines threads that don't obviously belong together. Reject clusters that are just "here's a theme they talk about a lot".
- Every seed idea must be GROUNDED: cite the passage ids (verbatim, as given) that it rests on. Do not cite an id you were not given. An idea with no real supporting passage should not be produced.
- Score novelty honestly. A take that any competitor could also make is low novelty even if it's true.
- Quality over quantity. 3–6 strong clusters beat a dozen weak ones. If the corpus only supports a couple, produce a couple.
- Never invent facts. The fusion is your insight; the underlying claims must come from the passages.`;

/** Read a diverse corpus sample and generate grounded novel-fusion idea clusters. Persists each
 *  seed idea as an 'open' Idea grouped under its cluster. Returns the created ideas. */
export async function generateIdeaClusters(workspaceId: string): Promise<Idea[]> {
  const all = listUtterances(workspaceId, undefined, { admittedOnly: true });
  if (all.length === 0) {
    throw new Error('No corpus yet. Ingest sources (or run a footprint sweep) before clustering ideas.');
  }
  const sample = diverseSample(all, CLUSTER_INPUT_CHARS);
  const validIds = new Set(sample.map((p) => p.id));

  const result = await structured({
    stage: 'idea-clusters',
    system: CLUSTER_SYSTEM,
    user: `CORPUS SAMPLE (${sample.length} passages${sample.length < all.length ? `, sampled from ${all.length}` : ''}; format "id: text"):\n\n${renderPassages(sample)}`,
    schema: ClusterSchema,
    maxTokens: 8000,
  });

  const created: Idea[] = [];
  for (const c of result.clusters) {
    for (const seed of c.ideas) {
      const ids = seed.utteranceIds.filter((id) => validIds.has(id)); // code owns structure: drop fabricated ids
      if (ids.length === 0) continue; // fail-safe: an idea with no real receipt is dropped
      const idea: NewIdea = {
        workspaceId,
        text: seed.text.trim(),
        rationale: seed.rationale.trim(),
        novelty: seed.novelty,
        sourceUtteranceIds: ids,
        origin: 'cluster',
        clusterTitle: c.title.trim(),
        clusterThesis: c.thesis.trim(),
        authorId: null,
      };
      created.push(insertIdea(idea));
    }
  }
  return created;
}

// ---------- brainstorm ----------

const BrainstormSchema = z.object({
  ideas: z.array(SeedIdeaSchema).min(1),
});

const BRAINSTORM_SYSTEM = `You are a brainstorm partner generating sharp, publishable marketing angles for a company, grounded in its own corpus.

Rules:
- Generate DISTINCT ideas — different angles, not paraphrases of one. Push past the obvious first take.
- Every idea must be GROUNDED in the provided passages: cite the passage ids (verbatim, as given) it rests on. Do not cite an id you were not given, and do not produce an idea no passage supports.
- Score novelty honestly (0–1): how non-obvious is this vs. the median take.
- Never invent facts. The angle is your contribution; the underlying claims come from the passages.`;

export interface BrainstormOpts {
  prompt: string;
  /** collaborator id — generate through this expert's lens (their expertise shapes the angles). */
  authorId?: string | null;
  /** refine/expand an existing idea rather than start fresh. */
  refineIdeaId?: string | null;
}

/** Directed idea generation. Retrieves relevant passages (hybrid when the corpus-query flag is on,
 *  else a diverse sample), optionally through a named expert's lens, optionally refining an idea.
 *  Persists grounded ideas with origin 'brainstorm'. Returns the created ideas. */
export async function brainstormIdeas(workspaceId: string, opts: BrainstormOpts): Promise<Idea[]> {
  const prompt = opts.prompt.trim();
  if (!prompt) throw new Error('A brainstorm prompt is required.');

  // Optional expert lens.
  let lens = '';
  let authorId: string | null = null;
  if (opts.authorId) {
    const expert = getCollaborator(workspaceId, opts.authorId);
    if (expert) {
      authorId = expert.id;
      lens = `\n\nGenerate through the lens of ${expert.name}${expert.expertise ? `, whose expertise is: ${expert.expertise}` : ''}. Favor angles this person would uniquely see.`;
    }
  }

  // Optional refinement seed.
  let refineBlock = '';
  if (opts.refineIdeaId) {
    const seed = getIdea(workspaceId, opts.refineIdeaId);
    if (seed) {
      refineBlock = `\n\nREFINE / EXPAND this existing idea (produce stronger variants and adjacent angles, not a restatement):\n"${seed.text}"${seed.rationale ? `\n(rationale: ${seed.rationale})` : ''}`;
    }
  }

  // Retrieve relevant passages: hybrid recall when the flag is on, else a diverse sample.
  let passages: WsUtterance[];
  if (config.flags.corpusQuery) {
    const { ids } = await hybridSearch(workspaceId, `${prompt} ${refineBlock}`.trim(), { topK: 40 });
    passages = getUtterancesByIdsOrdered(workspaceId, ids);
    if (passages.length === 0) {
      // Retrieval found nothing relevant — fall back to a diverse sample so brainstorm still grounds.
      passages = diverseSample(listUtterances(workspaceId, undefined, { admittedOnly: true }), BRAINSTORM_INPUT_CHARS);
    }
  } else {
    passages = diverseSample(listUtterances(workspaceId, undefined, { admittedOnly: true }), BRAINSTORM_INPUT_CHARS);
  }
  if (passages.length === 0) {
    throw new Error('No corpus yet. Ingest sources before brainstorming.');
  }
  const validIds = new Set(passages.map((p) => p.id));

  const result = await structured({
    stage: 'brainstorm',
    system: BRAINSTORM_SYSTEM,
    user: `BRAINSTORM REQUEST: ${prompt}${lens}${refineBlock}\n\nCORPUS PASSAGES (format "id: text"):\n\n${renderPassages(passages)}`,
    schema: BrainstormSchema,
    maxTokens: 6000,
  });

  const created: Idea[] = [];
  for (const seed of result.ideas) {
    const ids = seed.utteranceIds.filter((id) => validIds.has(id));
    if (ids.length === 0) continue; // fail-safe
    const idea: NewIdea = {
      workspaceId,
      text: seed.text.trim(),
      rationale: seed.rationale.trim(),
      novelty: seed.novelty,
      sourceUtteranceIds: ids,
      origin: 'brainstorm',
      clusterTitle: null,
      clusterThesis: null,
      authorId,
    };
    created.push(insertIdea(idea));
  }
  return created;
}

// ---------- promotion (the only path into the governed pipeline) ----------

/** Promote an open idea to a Moment on the slate. The idea's receipts become the moment's
 *  provenance; it enters as a normal slated moment and thereafter follows the governed pipeline
 *  (weave → edit → distill). Marks the idea 'promoted' and records the resulting moment id. */
export function promoteIdeaToMoment(workspaceId: string, ideaId: string): Moment {
  const idea = getIdea(workspaceId, ideaId);
  if (!idea) throw new Error('Idea not found.');
  if (idea.status !== 'open') throw new Error(`Idea is already ${idea.status}.`);
  if (idea.sourceUtteranceIds.length === 0) throw new Error('Idea has no receipts; cannot promote (provenance required).');

  const moment: Moment = {
    id: newId('mom'),
    workspaceId,
    utteranceIds: idea.sourceUtteranceIds,
    claim: idea.text,
    judgment: {
      novelty: idea.novelty,
      credibility: 0.6, // neutral prior; a promoted idea hasn't been speaker-scored like an extracted moment
      riskFlags: [],
      whyNow: idea.rationale || (idea.clusterThesis ?? ''),
    },
    score: 0.6 * idea.novelty + 0.4 * 0.6,
    state: 'slated',
    rejectionChip: null,
  };
  insertMoment(moment);
  updateIdeaStatus(workspaceId, ideaId, 'promoted', moment.id);
  return moment;
}
