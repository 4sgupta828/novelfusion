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
  },
};
