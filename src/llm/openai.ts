// The single OpenAI chokepoint. OpenAI is used in exactly two places, both deliberate:
//   1. embeddings (embed.ts) — Anthropic has no embeddings API.
//   2. the faithfulness judge (grounding.ts) — a DIFFERENT model family from the Anthropic
//      drafter, so drafter and judge fail in uncorrelated ways (the research system's rule).
// Owns the client singleton + per-call trace records (Rule 13). No other module may
// construct an OpenAI client.

import OpenAI from 'openai';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

let client: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (!client) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        'No OPENAI_API_KEY — corpus retrieval needs it (embeddings + the different-family faithfulness judge). Set it in .env, or disable retrieval (flag NF_FLAG_CORPUS_QUERY off).',
      );
    }
    client = new OpenAI();
  }
  return client;
}

export function openaiTrace(rec: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(config.tracePath), { recursive: true });
  fs.appendFileSync(config.tracePath, JSON.stringify({ at: new Date().toISOString(), provider: 'openai', ...rec }) + '\n');
}
