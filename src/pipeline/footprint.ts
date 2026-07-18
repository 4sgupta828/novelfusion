// Company footprint sweep — given a company name, discover its PUBLIC web presence (its own site +
// blog + interviews/talks + press) via Exa, windowed to the last N years, and ingest it into the
// workspace tagged as VOICE so the persona distiller can build a profile from it.
//
// Scope is deliberately public-web only (Rule 15 / the product's consent-shaped thesis): no scraping
// of walled platforms (LinkedIn/X/IG/FB). Those are gaps we label honestly, not scrape. Owned-social
// via granted API tokens is a later, separate adapter. Everything here is public data + Exa.

import { exaSearch } from '../llm/exa.js';
import { assertPublicUrl, segmentDocument, insertWebpage } from './ingest.js';
import { listSources, setSourceVoice } from '../db/index.js';

export interface FootprintSource {
  id: string;
  title: string;
  url: string;
  segmentCount: number;
}

export interface FootprintResult {
  company: string;
  queries: string[];
  created: FootprintSource[];
  skipped: number;
  windowFrom: string;
}

/** Channel-targeted queries that surface a company's OWN published voice (not just press about it):
 *  its site content, its founders' interviews/talks (voice-rich spoken material), and its POV pieces. */
function footprintQueries(company: string): { q: string; ownDomainOnly: boolean }[] {
  const c = `"${company}"`;
  return [
    { q: `${c} blog posts, articles, and insights`, ownDomainOnly: true }, // their own site (if domain given)
    { q: `${c} founder or CEO interview, podcast, keynote, or talk`, ownDomainOnly: false }, // spoken voice
    { q: `${c} announcement, launch, manifesto, or point of view`, ownDomainOnly: false },
    { q: `${c} perspective, opinion, or thought leadership essay`, ownDomainOnly: false },
  ];
}

const normDomain = (d: string) => d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').trim();

export async function sweepFootprint(
  workspaceId: string,
  company: string,
  opts: { domain?: string; years?: number; perQuery?: number } = {},
): Promise<FootprintResult> {
  if (!company || company.trim().length < 2) throw new Error('a company name is required');
  const years = opts.years ?? 5;
  const perQuery = opts.perQuery ?? 6;
  const from = new Date();
  from.setFullYear(from.getFullYear() - years);
  const startPublishedDate = from.toISOString();
  const domain = opts.domain ? normDomain(opts.domain) : undefined;

  const seen = new Set(listSources(workspaceId).map((s) => (s.uri || '').replace(/\/$/, '')));
  const created: FootprintSource[] = [];
  let skipped = 0;
  const queries = footprintQueries(company.trim());
  const ranQueries: string[] = [];

  for (const { q, ownDomainOnly } of queries) {
    // Skip the domain-scoped query if we weren't given a domain.
    if (ownDomainOnly && !domain) continue;
    ranQueries.push(q);
    let results;
    try {
      results = await exaSearch(q, {
        numResults: perQuery,
        startPublishedDate,
        ...(ownDomainOnly && domain ? { includeDomains: [domain] } : {}),
      });
    } catch (e) {
      if (created.length === 0 && ranQueries.length === 1) throw e; // surface a hard Exa error early
      continue;
    }
    for (const r of results) {
      const key = r.url.replace(/\/$/, '');
      if (seen.has(key)) { skipped++; continue; }
      seen.add(key);
      let url;
      try { url = assertPublicUrl(r.url); } catch { skipped++; continue; }
      const blocks = segmentDocument(r.text);
      if (blocks.length === 0) { skipped++; continue; }
      // Admitted (explicit bulk footprint ingest) + voice-tagged so the persona distills from it.
      const { source, segmentCount } = insertWebpage(workspaceId, url.toString(), r.title, blocks, { admitted: true });
      setSourceVoice(workspaceId, source.id, true);
      created.push({ id: source.id, title: source.title, url: source.uri, segmentCount });
    }
  }
  return { company: company.trim(), queries: ranQueries, created, skipped, windowFrom: startPublishedDate.slice(0, 10) };
}
