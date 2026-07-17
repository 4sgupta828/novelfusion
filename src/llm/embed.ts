// Embedding chokepoint — the ONLY OpenAI surface in the system (retrieval dense leg).
// Mirrors llm/client.ts: owns model choice + per-call trace records (Rule 13). Anthropic
// has no embeddings API, so the dense leg uses OpenAI text-embedding-3-small (the same
// embedder the reference research system uses); model+dim are stamped on every stored
// vector so the dense leg never cosines across two embedding spaces.

import { getOpenAI, openaiTrace } from './openai.js';

export const EMBED_MODEL = 'text-embedding-3-small';
export const EMBED_DIM = 1536;

/** OpenAI's per-request input cap is generous; batch conservatively to bound latency/memory. */
const BATCH = 128;

/** Embed a batch of texts → Float32 vectors, order-preserving. Traces per API call. */
export async function embedTexts(texts: string[], stage = 'embed'): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const c = getOpenAI();
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const res = await c.embeddings.create({ model: EMBED_MODEL, input: batch });
    for (const d of res.data) out.push(Float32Array.from(d.embedding));
    openaiTrace({
      stage,
      model: EMBED_MODEL,
      usage: res.usage,
      inputs: batch.length,
      promptChars: batch.reduce((a, t) => a + t.length, 0),
    });
  }
  return out;
}

/** Embed a single query. */
export async function embedQuery(text: string): Promise<Float32Array> {
  const vecs = await embedTexts([text], 'embed_query');
  if (vecs.length === 0) throw new Error('embedQuery returned no vector');
  return vecs[0]!;
}
