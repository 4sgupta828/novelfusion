// Single chokepoint for all model calls (CLAUDE.md Architecture + Rule 13).
// Owns: model choice, adaptive thinking, structured outputs, prompt-caching
// breakpoints, and per-call trace records.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod/v4';
import { config } from '../config.js';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new Error(
        'No Anthropic credentials found (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN). Copy .env.example to .env and add a key — LLM stages (extract, weave, distill, ratify, regress) need it.',
      );
    }
    client = new Anthropic();
  }
  return client;
}

interface TraceRecord {
  at: string;
  stage: string;
  model: string;
  usage: unknown;
  promptChars: number;
  outputChars: number;
  note?: string;
}

function trace(rec: TraceRecord): void {
  fs.mkdirSync(path.dirname(config.tracePath), { recursive: true });
  fs.appendFileSync(config.tracePath, JSON.stringify(rec) + '\n');
}

/**
 * `system` is the STABLE, cacheable block per stage — keep it byte-identical
 * across calls within a stage (no timestamps/IDs; see shared caching rules).
 * Volatile content goes in `user`.
 */
export interface CallOpts {
  stage: string;
  system: string;
  user: string;
  maxTokens?: number;
}

export async function structured<T extends z.ZodTypeAny>(opts: CallOpts & { schema: T }): Promise<z.infer<T>> {
  const c = getClient();
  const response = await c.messages.parse({
    model: config.model,
    max_tokens: opts.maxTokens ?? 16000,
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: opts.user }],
    output_config: { format: zodOutputFormat(opts.schema) },
  });
  trace({
    at: new Date().toISOString(),
    stage: opts.stage,
    model: config.model,
    usage: response.usage,
    promptChars: opts.system.length + opts.user.length,
    outputChars: JSON.stringify(response.parsed_output ?? '').length,
  });
  if (response.stop_reason === 'refusal') {
    throw new Error(`Model refused at stage "${opts.stage}" — inspect input; do not retry blindly.`);
  }
  if (response.parsed_output == null) {
    throw new Error(`Structured output parse failed at stage "${opts.stage}" (stop_reason=${response.stop_reason}).`);
  }
  return response.parsed_output;
}

export async function generate(opts: CallOpts): Promise<string> {
  const c = getClient();
  const response = await c.messages.create({
    model: config.model,
    max_tokens: opts.maxTokens ?? 16000,
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: opts.user }],
  });
  if (response.stop_reason === 'refusal') {
    throw new Error(`Model refused at stage "${opts.stage}" — inspect input; do not retry blindly.`);
  }
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  trace({
    at: new Date().toISOString(),
    stage: opts.stage,
    model: config.model,
    usage: response.usage,
    promptChars: opts.system.length + opts.user.length,
    outputChars: text.length,
  });
  return text;
}
