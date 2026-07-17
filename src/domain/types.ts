// Core domain entities — Phase 0 subset of PRD §7.
// SQLite persistence in src/db; these are the in-code shapes.

export type SourceKind = 'upload' | 'document' | 'webpage' | 'public_url' | 'style_guide' | 'published';

/** The strategic moat-guard (panel finding): human utterances are the PRIMARY
 *  grounding for a moment; documents/web are SUPPORTING evidence; a public_web
 *  segment can never satisfy a person-consent requirement. Also drives receipt weight. */
export type ProvenanceClass = 'human_utterance' | 'owned_document' | 'public_web';
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
  consentBasis: 'public' | 'recorded_consent' | 'uploaded_owner' | 'synced_pending_review';
  /** Ingest quarantine (panel finding): auto-ingested/synced sources are NOT
   *  eligible for extraction until a human admits them. Manual uploads auto-admit. */
  admitted: boolean;
}

/** Kind-specific provenance anchor. Transcript keeps timestamp+speaker; a document
 *  cites a page/heading; a webpage cites a URL + anchor. The chip renders per-kind. */
export type Locator =
  | { kind: 'transcript' }
  | { kind: 'document'; page?: number; heading?: string }
  | { kind: 'webpage'; url: string; anchor?: string; fetchedAt: string };

/** The atomic provenance unit ("segment"). Every claim in every draft resolves to
 *  one of these — now across transcripts, documents, and web pages. Kept named
 *  Utterance to avoid a ~60-site rename (panel: additive locator, not a migration). */
export interface Utterance {
  id: string;
  sourceId: string;
  workspaceId: string;
  /** null for non-transcript segments (documents/web have no speaker). */
  speaker: string | null;
  tStartSec: number | null;
  tEndSec: number | null;
  text: string;
  seq: number;
  locator: Locator;
  provenanceClass: ProvenanceClass;
  /** Joined from sources for display. */
  sourceTitle?: string;
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

/** One intent-framed section of a templated draft. */
export interface DraftSection {
  key: string;
  title: string;
  body: string;
}

export type VizKind = 'bar' | 'pie' | 'line' | 'table' | 'stat';

/** A chart the model emits when the source data warrants it. Numbers carry
 *  receipts too (utteranceIds) — the "every claim has a source" invariant
 *  extends to figures, not just prose. */
export interface VizSpec {
  kind: VizKind;
  title: string;
  caption: string;
  unit?: string;
  /** Section key after which to render this figure (falls back to end). */
  afterSection?: string;
  /** bar / pie / line / stat: labeled values. */
  series?: { label: string; value: number }[];
  /** table: header row + data rows. */
  table?: { columns: string[]; rows: string[][] };
  /** Provenance: the utterances the figures came from. */
  utteranceIds: string[];
}

export interface Draft {
  id: string;
  workspaceId: string;
  momentId: string;
  format: AssetFormat;
  angle: string;
  /** Template id used to structure the piece ('freeform' = none). */
  template: string;
  content: string;
  /** Structured sections when a template was used (empty for freeform). */
  sections: DraftSection[];
  /** Charts/tables the model emitted (empty when none warranted). */
  viz: VizSpec[];
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
