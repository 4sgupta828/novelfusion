// The single OpenAI chokepoint. OpenAI is used in a few deliberate places:
//   1. embeddings (embed.ts) — Anthropic has no embeddings API.
//   2. the faithfulness judge (grounding.ts) — a DIFFERENT model family from the Anthropic
//      drafter, so drafter and judge fail in uncorrelated ways (the research system's rule).
//   3. text-to-speech (fusion.ts) — voiceover for the experimental fusion-video generator.
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

export type TtsVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
export type TtsModel = 'tts-1' | 'tts-1-hd' | 'gpt-4o-mini-tts';

export interface SpeechOpts {
  voice?: TtsVoice;
  model?: TtsModel;
  /** Steerable delivery direction — ONLY honored by gpt-4o-mini-tts (ignored by tts-1/tts-1-hd). */
  instructions?: string;
  /** Playback speed 0.25–4.0 (default 1.0). */
  speed?: number;
}

/** Synthesize speech (voiceover) from text via OpenAI TTS. Returns mp3 bytes. Fails loudly — the
 *  caller (fusion video) treats an error as a failed render. tts-1 is fast/cheap; tts-1-hd is higher
 *  fidelity; gpt-4o-mini-tts is steerable via `instructions` (tone/emotion/pace). */
export async function synthesizeSpeech(text: string, opts: SpeechOpts = {}): Promise<Buffer> {
  const model: TtsModel = opts.model ?? 'tts-1';
  const voice: TtsVoice = opts.voice ?? 'alloy';
  const speed = Math.max(0.25, Math.min(4, opts.speed ?? 1));
  const req: Record<string, unknown> = { model, voice, input: text, response_format: 'mp3', speed };
  if (model === 'gpt-4o-mini-tts' && opts.instructions) req.instructions = opts.instructions;
  const res = await getOpenAI().audio.speech.create(req as unknown as Parameters<OpenAI['audio']['speech']['create']>[0]);
  const buf = Buffer.from(await res.arrayBuffer());
  openaiTrace({ stage: 'tts', model, voice, speed, steered: !!(model === 'gpt-4o-mini-tts' && opts.instructions), chars: text.length, bytes: buf.length });
  return buf;
}
