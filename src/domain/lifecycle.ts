// Principle lifecycle guard — pure, shared by the CLI and the HTTP server so
// the shadow-before-live invariant is enforced server-side, not by hidden
// buttons (panel finding: promote/accept/reject were ungated at the HTTP layer).

import type { PrincipleStatus } from './types.js';

export type PrincipleAction = 'accept' | 'promote' | 'reject';

const ALLOWED: Record<PrincipleAction, PrincipleStatus[]> = {
  accept: ['candidate'],            // candidate → shadow (never straight to active)
  promote: ['shadow'],              // shadow → active
  reject: ['candidate', 'shadow'],  // active principles are retired, not rejected
};

export function assertPrincipleTransition(current: PrincipleStatus, action: PrincipleAction): void {
  if (!ALLOWED[action].includes(current)) {
    throw new Error(
      `Cannot ${action} a principle in status "${current}" — allowed from: ${ALLOWED[action].join(', ')}. ` +
        `The lifecycle is candidate → shadow → active; shadow-before-live has no bypass.`,
    );
  }
}
