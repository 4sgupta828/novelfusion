// Source discovery — find public web pages relevant to a topic via Exa, and ingest them into the
// corpus QUARANTINED (admitted=false) for human review. Governance-first: discovered pages are
// public_web provenance (supporting evidence only; never treated as something a person said), and
// nothing enters the pipeline until a human admits it.
//
// Rule 18 split: the LLM owns MEANING (turning a topic into sharp search queries informed by the
// workspace's voice); code owns STRUCTURE (Exa I/O, URL validation, dedup, segmentation, quarantine
// persistence). The LLM step degrades gracefully — if it's unavailable, the raw topic is the query.

import { z } from 'zod/v4';
import { structured } from '../llm/client.js';
import { exaSearch } from '../llm/exa.js';
import { assertPublicUrl, segmentDocument, insertWebpage } from './ingest.js';
import { listSources, listMoments } from '../db/index.js';

const MAX_QUERIES = 3;
const PER_QUERY = 5;

const QuerySchema = z.object({
  queries: z.array(z.string()).describe('2-3 sharp, specific web-search queries'),
});

/** Expand a topic into a few Exa queries, informed by the workspace's existing moments so results
 *  match its angle. Fails SOFT: any LLM error (e.g. no credit) falls back to the raw topic. */
export async function expandQueries(workspaceId: string, topic: string): Promise<{ queries: string[]; expanded: boolean }> {
  const moments = listMoments(workspaceId, 'slated', 8).map((m) => `- ${m.claim}`).join('\n');
  try {
    const out = await structured({
      stage: 'discover-queries',
      system:
        'You turn an editorial topic into 2-3 sharp web-search queries for finding SUPPORTING evidence (data, expert commentary, primary reporting) for B2B thought leadership. ' +
        'Make each query specific and distinct — different angles, not rewordings. Return only the queries.',
      user: `Topic: ${topic}\n\n${moments ? `The workspace is already publishing around these moments (match this angle):\n${moments}` : 'No existing moments yet.'}`,
      schema: QuerySchema,
      maxTokens: 1000,
    });
    const queries = out.queries.map((q) => q.trim()).filter(Boolean).slice(0, MAX_QUERIES);
    return queries.length > 0 ? { queries, expanded: true } : { queries: [topic], expanded: false };
  } catch {
    return { queries: [topic], expanded: false }; // graceful degrade — discovery still works without the LLM
  }
}

export interface DiscoveredSource {
  id: string;
  title: string;
  url: string;
  segmentCount: number;
}

export interface DiscoverResult {
  queries: string[];
  expanded: boolean;
  created: DiscoveredSource[];
  skipped: number;
}

/** Discover + quarantine web sources for a topic. Dedups against the query set AND the workspace's
 *  existing source URIs, so re-running doesn't re-ingest the same page. */
export async function discoverSources(
  workspaceId: string,
  topic: string,
  opts: { perQuery?: number } = {},
): Promise<DiscoverResult> {
  if (!topic || topic.trim().length < 3) throw new Error('a topic is required (min 3 chars)');
  const perQuery = opts.perQuery ?? PER_QUERY;
  const { queries, expanded } = await expandQueries(workspaceId, topic.trim());

  const seen = new Set(listSources(workspaceId).map((s) => (s.uri || '').replace(/\/$/, '')));
  const created: DiscoveredSource[] = [];
  let skipped = 0;

  for (const q of queries) {
    let results;
    try {
      results = await exaSearch(q, perQuery);
    } catch (e) {
      if (created.length === 0 && q === queries[0]) throw e; // surface a hard Exa error on the first query
      continue;
    }
    for (const r of results) {
      const key = r.url.replace(/\/$/, '');
      if (seen.has(key)) { skipped++; continue; }
      seen.add(key);
      let url;
      try { url = assertPublicUrl(r.url); } catch { skipped++; continue; } // defense: never store a non-public URL
      const blocks = segmentDocument(r.text);
      if (blocks.length === 0) { skipped++; continue; }
      // Quarantine: admitted=false. A human admits from the Corpus view before it enters the pipeline.
      const { source, segmentCount } = insertWebpage(workspaceId, url.toString(), r.title, blocks, { admitted: false });
      created.push({ id: source.id, title: source.title, url: source.uri, segmentCount });
    }
  }
  return { queries, expanded, created, skipped };
}
