// Exa (exa.ai) neural web search — the ONLY Exa surface. A new external-network path (Rule 15):
// we send the search query to Exa and receive public-web URLs + cleaned page text. Traced per
// call (Rule 13). The API key is never logged. Callers must still assertPublicUrl each returned
// URL before storing, and discovered sources land quarantined (admitted=false) for human review.

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const EXA_ENDPOINT = 'https://api.exa.ai/search';
const MAX_TEXT_CHARS = 6000; // bound stored text per result

export interface ExaResult {
  url: string;
  title: string;
  text: string;
  publishedDate?: string;
}

function trace(rec: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(config.tracePath), { recursive: true });
  fs.appendFileSync(config.tracePath, JSON.stringify({ at: new Date().toISOString(), provider: 'exa', ...rec }) + '\n');
}

export interface ExaOpts {
  numResults?: number;
  includeDomains?: string[]; // restrict to the company's own domain(s)
  startPublishedDate?: string; // ISO date — the footprint window (e.g. last 5 years)
}

/** Neural search for a query → public-web results with extracted text. Options push domain-scope
 *  and a published-date window to Exa natively (used by the company-footprint sweep). */
export async function exaSearch(query: string, opts: number | ExaOpts = 5): Promise<ExaResult[]> {
  const o: ExaOpts = typeof opts === 'number' ? { numResults: opts } : opts;
  const key = process.env.EXA_API_KEY;
  if (!key) throw new Error('No EXA_API_KEY — source discovery needs it. Add it to .env, or disable NF_FLAG_SOURCE_DISCOVERY.');

  const res = await fetch(EXA_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({
      query,
      type: 'auto',
      numResults: o.numResults ?? 5,
      ...(o.includeDomains?.length ? { includeDomains: o.includeDomains } : {}),
      ...(o.startPublishedDate ? { startPublishedDate: o.startPublishedDate } : {}),
      contents: { text: { maxCharacters: MAX_TEXT_CHARS } },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Exa search failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  const data = (await res.json()) as { results?: Array<{ url?: string; title?: string; text?: string; publishedDate?: string }> };
  const results = (data.results ?? [])
    .filter((r) => r.url && r.text && r.text.trim().length > 0)
    .map((r) => ({ url: r.url!, title: (r.title ?? '').trim(), text: r.text!.trim(), publishedDate: r.publishedDate }));
  trace({ stage: 'exa_search', queryChars: query.length, requested: o.numResults ?? 5, domains: o.includeDomains?.length ?? 0, returned: results.length });
  return results;
}
