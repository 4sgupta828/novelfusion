// Background embedding/FTS backfill — the eager counterpart to the lazy at-query-time backfill.
// Mirrors the research system's idempotent embedder loop, adapted to a single Node process:
// a fire-and-forget KICK when a source is admitted/ingested, plus a slow periodic SWEEP as a
// self-healing safety net. Both funnel through embedBackfill() (idempotent: it only embeds/indexes
// admitted passages that aren't done yet), so overlapping runs never double-work — and a per-
// workspace in-flight lock stops concurrent runs from double-spending OpenAI on the same passages.
//
// Gated by the corpusQuery flag + an OpenAI key: when retrieval is off, this is entirely inert
// (no timer, no calls) — the OFF path stays byte-identical (Rule 20). Best-effort throughout: an
// embedding failure is logged and retried on the next sweep, never surfaced to the user's request.

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { listWorkspaceIds, listUnembeddedUtterances, ftsIndexedIds, listUtterances } from '../db/index.js';
import { EMBED_MODEL } from '../llm/embed.js';
import { embedBackfill } from './retrieval.js';

const SWEEP_INTERVAL_MS = 45_000;
const inFlight = new Set<string>(); // per-workspace lock
let timer: ReturnType<typeof setTimeout> | null = null;

function active(): boolean {
  return config.flags.corpusQuery && !!process.env.OPENAI_API_KEY;
}

function trace(rec: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(config.tracePath), { recursive: true });
    fs.appendFileSync(config.tracePath, JSON.stringify({ at: new Date().toISOString(), stage: 'backfill_worker', ...rec }) + '\n');
  } catch { /* tracing must never break the worker */ }
}

/** Embed + FTS-index a workspace's pending admitted passages. Serialized per workspace. */
export async function processWorkspace(workspaceId: string): Promise<void> {
  if (!active() || inFlight.has(workspaceId)) return;
  inFlight.add(workspaceId);
  try {
    const r = await embedBackfill(workspaceId);
    if (r.embedded > 0 || r.ftsIndexed > 0 || r.error) trace({ workspaceId, ...r });
  } catch (e) {
    trace({ workspaceId, error: String(e) });
  } finally {
    inFlight.delete(workspaceId);
  }
}

/** Cheap check: does this workspace have admitted passages not yet embedded or FTS-indexed? */
function hasPendingWork(workspaceId: string): boolean {
  if (listUnembeddedUtterances(workspaceId, EMBED_MODEL).length > 0) return true;
  const indexed = ftsIndexedIds(workspaceId);
  return listUtterances(workspaceId, undefined, { admittedOnly: true }).some((u) => !indexed.has(u.id));
}

/** Fire-and-forget nudge — call right after admit/ingest so newly-eligible passages start
 *  embedding immediately, without blocking the HTTP response. */
export function kickBackfill(workspaceId: string): void {
  if (!active()) return;
  void processWorkspace(workspaceId);
}

/** Periodic self-healing sweep across all workspaces (catches anything a kick missed — e.g. a
 *  process restart mid-embed). Only touches workspaces with real pending work. */
export function startBackfillWorker(intervalMs = SWEEP_INTERVAL_MS): void {
  if (!active() || timer) return;
  const tick = async () => {
    for (const ws of listWorkspaceIds()) {
      if (hasPendingWork(ws)) await processWorkspace(ws);
    }
    timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, 3000); // first sweep shortly after boot
  trace({ event: 'started', intervalMs });
}

/** Stop the sweep (for clean shutdown / tests). */
export function stopBackfillWorker(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}
