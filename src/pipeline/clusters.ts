// Principle clustering — the LLM owns the SEMANTIC grouping (Rule 18: what themes exist and
// which principle belongs to which). Code owns structure: id validation, persistence, and the
// non-destructive rule (only currently-unclustered principles are touched, so manual clusters
// and assignments are never clobbered by a re-run).

import { z } from 'zod/v4';
import { structured } from '../llm/client.js';
import { listPrinciples, createCluster, assignPrincipleCluster } from '../db/index.js';
import type { Cluster } from '../domain/types.js';

const TIER_LABEL: Record<string, string> = {
  L0_compliance: 'compliance',
  L1_brand: 'brand',
  L2_channel: 'channel',
  L3_taste: 'taste',
};

const ClusterProposal = z.object({
  clusters: z.array(
    z.object({
      name: z.string().describe('a short, human editorial theme, e.g. "Tone & voice" or "Compliance guardrails"'),
      description: z.string().describe('one line: what this cluster governs and when you might suspend it'),
      principleIds: z.array(z.string()).describe('ids (verbatim from input) of the principles in this theme'),
    }),
  ),
});

const SYSTEM = `You organize an editorial "constitution" — a set of ratified writing rules — into a few coherent THEMES, so an editor can toggle a whole theme on or off as a temporary escape hatch (e.g. "suspend the formal-tone rules for this launch").

Group the given principles into 2–6 themes by what they GOVERN (tone/voice, compliance & legal guardrails, channel/format conventions, structure, claims/evidence discipline, etc.). Rules:
- Name each theme in plain editorial language; give a one-line description including when someone might reasonably suspend it.
- Put each principle in the SINGLE best-fitting theme; cite ids exactly as given. It is fine to leave a genuinely-orphan principle out of every theme (it stays unclustered).
- Prefer a few meaningful themes over many tiny ones. Do not invent principles or ids.`;

export interface ClusterResult {
  created: Cluster[];
  assigned: number;
}

/** Auto-cluster the workspace's currently-UNCLUSTERED live principles (candidate/shadow/active).
 *  Non-destructive: already-clustered principles and existing clusters are left untouched. */
export async function clusterPrinciples(workspaceId: string): Promise<ClusterResult> {
  const live = listPrinciples(workspaceId).filter(
    (p) => ['candidate', 'shadow', 'active'].includes(p.status) && p.clusterId === null,
  );
  if (live.length === 0) throw new Error('No unclustered active/shadow/candidate principles to group. Distill and ratify some first, or all are already clustered.');

  const input = live.map((p) => `${p.id} [${TIER_LABEL[p.tier] ?? p.tier}] ${p.text}`).join('\n');
  const proposal = await structured({
    stage: 'cluster-principles',
    system: SYSTEM,
    user: `Principles (format: id [tier] text):\n\n${input}`,
    schema: ClusterProposal,
  });

  const validIds = new Set(live.map((p) => p.id));
  const used = new Set<string>();
  const created: Cluster[] = [];
  let assigned = 0;
  for (const c of proposal.clusters) {
    const ids = c.principleIds.filter((id) => validIds.has(id) && !used.has(id));
    if (ids.length === 0) continue; // code owns structure: drop empty/hallucinated clusters
    const cluster = createCluster(workspaceId, c.name.trim() || 'Untitled cluster', c.description.trim(), true);
    for (const id of ids) { assignPrincipleCluster(workspaceId, id, cluster.id); used.add(id); assigned++; }
    created.push(cluster);
  }
  return { created, assigned };
}
