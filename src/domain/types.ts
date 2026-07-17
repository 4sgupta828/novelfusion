// Core domain entities — Phase 0 subset of PRD §7.
// SQLite persistence in src/db; these are the in-code shapes.

export type SourceKind = 'upload' | 'public_url' | 'style_guide' | 'published';
export type AssetFormat = 'li_post' | 'x_thread' | 'blog' | 'clip_spec';
export type MomentState = 'slated' | 'rejected' | 'snoozed' | 'woven';
export type DraftState = 'draft' | 'in_approval' | 'approved' | 'published' | 'declined';
export type PrincipleStatus = 'candidate' | 'shadow' | 'active' | 'decaying' | 'retired' | 'rejected';
export type PrincipleTier = 'L0_compliance' | 'L1_brand' | 'L2_channel' | 'L3_taste';

export type RejectionChip =
  | 'not_our_pov'
  | 'too_generic'
  | 'off_limits_source'
  | 'wrong_speaker'
  | 'legal_risk'
  | 'already_said';

export type EditReasonChip = 'off-voice' | 'off-strategy' | 'risky' | 'not-now' | 'factual' | 'style';

export interface Source {
  id: string;
  workspaceId: string;
  kind: SourceKind;
  uri: string;
  title: string;
  recordedAt: string | null;
  consentBasis: 'public' | 'recorded_consent' | 'uploaded_owner';
}

/** The atomic provenance unit. Every claim in every draft resolves to these. */
export interface Utterance {
  id: string;
  sourceId: string;
  workspaceId: string;
  speaker: string;
  tStartSec: number | null;
  tEndSec: number | null;
  text: string;
  seq: number;
}

export interface RiskFlag {
  kind: 'named_customer' | 'forward_looking' | 'competitor_mention' | 'sensitive';
  note: string;
}

export interface MomentJudgment {
  /** 0–1: how novel vs. what the org has already published. */
  novelty: number;
  /** 0–1: how credible is this speaker on this topic. */
  credibility: number;
  riskFlags: RiskFlag[];
  whyNow: string;
}

export interface Moment {
  id: string;
  workspaceId: string;
  utteranceIds: string[];
  claim: string;
  judgment: MomentJudgment;
  score: number;
  state: MomentState;
  rejectionChip: RejectionChip | null;
}

export interface WeaveStub {
  angle: string;
  format: AssetFormat;
  audience: string;
  stub: string; // one-sentence pitch
}

export interface ProvenanceEntry {
  /** A verbatim or near-verbatim span of the draft that carries a claim. */
  quote: string;
  utteranceIds: string[];
}

export interface Draft {
  id: string;
  workspaceId: string;
  momentId: string;
  format: AssetFormat;
  angle: string;
  content: string;
  provenance: ProvenanceEntry[];
  constitutionVersion: number;
  /** true → excluded from exemplar retrieval and distillation (Rule 5: eval holdout). */
  holdout: boolean;
  state: DraftState;
  createdAt: string;
}

export interface EditEvent {
  id: string;
  workspaceId: string;
  draftId: string;
  reasonChip: EditReasonChip | null;
  /** unified diff, original → edited */
  diff: string;
  editedContent: string;
  holdout: boolean;
  createdAt: string;
}

export interface PrincipleScope {
  channel: AssetFormat | null;
  person: string | null;
  topic: string | null;
  audience: string | null;
}

export interface Principle {
  id: string;
  workspaceId: string;
  text: string;
  tier: PrincipleTier;
  scope: PrincipleScope;
  status: PrincipleStatus;
  evidenceEditIds: string[];
  counterexamples: string[];
  version: number;
  fireCount: number;
  overrideCount: number;
  createdAt: string;
}

export interface CounterfactualResult {
  principleId: string;
  draftId: string;
  inScope: boolean;
  changed: boolean;
  diff: string;
}

export interface EvalRun {
  id: string;
  workspaceId: string;
  kind: 'regression' | 'recurrence' | 'counterfactual' | 'compliance';
  configJson: string; // model, prompt version, constitution version, git SHA (Rule 11)
  resultsJson: string;
  createdAt: string;
}
