import 'dotenv/config';
import path from 'node:path';

function flag(name: string, def = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return v === 'true' || v === '1';
}

export const config = {
  model: process.env.NF_MODEL || 'claude-opus-4-8',
  dbPath: process.env.NF_DB_PATH || path.join(process.cwd(), 'data', 'novelfusion.db'),
  tracePath: path.join(process.cwd(), 'data', 'traces.jsonl'),
  reportsDir: path.join(process.cwd(), 'reports'),
  /** Max principles injected in-context per generation (rest applied via critique-and-revise). */
  maxInContextPrinciples: 30,
  /** Max exemplar edits retrieved per generation. */
  maxExemplars: 4,
  /** Fraction of drafts marked holdout at creation (Rule 5). */
  holdoutFraction: 0.3,
  flags: {
    confidenceRouting: flag('NF_FLAG_CONFIDENCE_ROUTING'), // Rule 20: default OFF
    // Corpus hybrid retrieval + grounded Query (embeddings, FTS, answer-with-receipts).
    // Default OFF (Rule 20): when off, ingest is byte-identical, no OpenAI call, no Query route.
    corpusQuery: flag('NF_FLAG_CORPUS_QUERY'),
    // Retain original uploaded bytes so a source can be downloaded. Default ON because it is an
    // explicitly-requested product feature, but kept behind a flag so raw-PII retention is
    // killable in one step (flip NF_FLAG_RETAIN_ORIGINALS=false to stop retaining + hide download).
    retainOriginals: flag('NF_FLAG_RETAIN_ORIGINALS', true),
    // Auto-discover public web sources via Exa (results land quarantined, pending review).
    // Default OFF (Rule 20); needs EXA_API_KEY. New external-network path (Rule 15).
    sourceDiscovery: flag('NF_FLAG_SOURCE_DISCOVERY'),
    // Talk Slate: propose feasible long-form talks from the corpus (the discovery layer of the
    // `talk_kit` direction, docs/specs/talk-kit.md). Default OFF (Rule 20): when off, the Talks nav
    // view is hidden and its endpoints 404. Full long-form talk composition remains deferred.
    talkKit: flag('NF_FLAG_TALK_KIT'),
  },
};
