// The consent gate — deterministic, code-owned, fail-closed (Rule 18 consent exemption; PRD §8).
// The meaning ("did this person agree?") is NOT an LLM call — it's a structural check against the
// consent ledger. A missing or revoked grant → NOT covered, always. This is the primitive that lets
// NovelFusion refuse to render an unconsented clip/likeness/voice (SYNTHESIS §8).

import type { ConsentGrant, ConsentScope, ConsentDecision } from './types.js';

/** A grant's channel list covers a request channel iff it lists 'all' or the exact channel. */
export function channelCovers(grant: ConsentGrant, channel: string): boolean {
  return grant.channels.includes('all') || grant.channels.includes(channel);
}

/** Pure decision over a set of grants (already scoped to one person). Fail-closed: an empty set, a
 *  revoked grant, or a scope/channel miss all return covered:false. Scopes do NOT cascade — a grant
 *  must list the exact scope requested (a `likeness` grant does not imply `clip`). */
export function decideConsent(
  grants: ConsentGrant[],
  req: { scope: ConsentScope; channel: string },
): ConsentDecision {
  const active = grants.filter((g) => g.revokedAt === null);
  if (active.length === 0) return { covered: false, reason: 'no active consent grant for this person' };
  const match = active.find((g) => g.scopes.includes(req.scope) && channelCovers(g, req.channel));
  if (match) return { covered: true, reason: `covered by grant ${match.id}`, grantId: match.id };
  const hasScope = active.some((g) => g.scopes.includes(req.scope));
  return {
    covered: false,
    reason: hasScope
      ? `consent for "${req.scope}" exists but not for channel "${req.channel}"`
      : `no consent grant for scope "${req.scope}"`,
  };
}
