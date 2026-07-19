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

export type VizKind =
  | 'bar'
  | 'pie'
  | 'line'
  | 'table'
  | 'stat'
  | 'scatter'      // two metrics plotted against each other (correlation / positioning)
  | 'quadrant'     // market map: named players on two named axes, split into four quadrants
  | 'grouped_bar'  // several series compared side-by-side across categories
  | 'stacked_bar'; // composition across categories (parts of each whole)

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
  /** scatter / quadrant: named points on two axes (group colors points; optional). */
  points?: { label: string; x: number; y: number; group?: string | null }[];
  /** scatter / quadrant / grouped_bar / stacked_bar: axis labels (x = horizontal, y = vertical). */
  axes?: { x: string; y: string };
  /** quadrant only: the four quadrant labels, in order [top-left, top-right, bottom-left, bottom-right]. */
  quadrants?: string[];
  /** grouped_bar / stacked_bar: each category carries several named series values. */
  groups?: { label: string; values: { name: string; value: number }[] }[];
  /** Provenance: the utterances the figures came from. */
  utteranceIds: string[];
}

/** A shareable infographic poster composed from a draft's own grounded content. Persisted on the
 *  draft (part of the post), rendered inline and exportable to PNG. */
export interface InfographicPoster {
  eyebrow: string;
  headline: string;
  subhead: string;
  stats: { value: string; label: string }[];
  takeaway: string;
  featureViz: VizSpec | null;
  source: string;
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
  /** A persisted infographic poster built from this draft (null until generated). */
  infographic: InfographicPoster | null;
  provenance: ProvenanceEntry[];
  constitutionVersion: number;
  /** true → excluded from exemplar retrieval and distillation (Rule 5: eval holdout). */
  holdout: boolean;
  state: DraftState;
  createdAt: string;
}

export interface Collaborator {
  id: string;
  workspaceId: string;
  name: string;
  expertise: string;
  createdAt: string;
}

/** Consent scope ladder, narrowest → widest. A real-footage clip needs `clip`; a synthetic presenter
 *  needs BOTH `likeness` and `voice_clone`. Wider scopes do NOT imply narrower ones — a grant lists
 *  exactly what was consented. */
export type ConsentScope = 'quote' | 'clip' | 'likeness' | 'voice_clone';

/** A per-person, scoped, revocable consent grant — the ledger primitive (PRD §7/§8, SYNTHESIS §8).
 *  Never hard-deleted: revocation sets revokedAt, preserving the audit trail. */
export interface ConsentGrant {
  id: string;
  workspaceId: string;
  subject: string; // normalized person key (lowercased name) used for matching
  subjectLabel: string; // display name as entered
  collaboratorId: string | null; // optional link to a collaborator
  scopes: ConsentScope[];
  channels: string[]; // ['all'] or specific channel keys
  survivesDeparture: boolean; // does the grant persist if the person leaves?
  evidence: string; // how consent was obtained — the audit anchor
  grantedAt: string | null;
  revokedAt: string | null; // null = active
  createdAt: string;
}

/** Result of the deterministic consent gate. `covered:false` is fail-closed (the default). */
export interface ConsentDecision {
  covered: boolean;
  reason: string;
  grantId?: string;
}

export type ClipFormat = '16:9' | '9:16' | '1:1';

/** A rendered real-footage clip — provenance-clean video cut from a source's retained recording at a
 *  moment's timestamps, authorized by `clip` consent grants (SYNTHESIS §8 slice 2). The file lives on
 *  disk; this is the provenance record. */
export interface RenderedClip {
  id: string;
  workspaceId: string;
  sourceId: string;
  momentId: string | null;
  utteranceIds: string[];
  speakers: string[]; // distinct on-screen speakers (consent subjects)
  consentGrantIds: string[]; // the grants that authorized this render
  format: ClipFormat;
  channel: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  filename: string;
  filePath: string;
  mime: string;
  size: number;
  createdAt: string;
}

export type SceneVisual = 'title' | 'bullets' | 'stat' | 'quote' | 'chart';

/** One scene of a fusion-video storyboard: what the voiceover says + what shows on screen. */
export interface StoryboardScene {
  narration: string; // voiceover text (spoken)
  visual: SceneVisual;
  title: string; // on-screen headline
  subtitle?: string;
  bullets?: string[];
  stat?: { value: string; label: string };
  quote?: { text: string; attribution?: string };
  chart?: { unit?: string; bars: { label: string; value: number }[] };
}

/** An EXPERIMENTAL generated fusion video (ngram-style): storyboard + canvas infographics + AI
 *  voiceover, assembled with ffmpeg. Synthetic by design — not the provenance-clean clip path. */
export interface FusionVideo {
  id: string;
  workspaceId: string;
  title: string;
  origin: string; // 'talk' | 'source' | 'moment'
  originId: string | null;
  voice: string;
  format: ClipFormat;
  scenes: StoryboardScene[];
  durationSec: number;
  filename: string;
  filePath: string;
  mime: string;
  size: number;
  createdAt: string;
}

export type IdeaOrigin = 'cluster' | 'brainstorm';
export type IdeaStatus = 'open' | 'promoted' | 'dismissed';

/** A candidate idea in the scratch space upstream of the slate. Grounded (receipts) but not yet
 *  a Moment — promotion is the only path into the governed pipeline. */
export interface Idea {
  id: string;
  workspaceId: string;
  text: string;
  rationale: string;
  novelty: number; // 0..1
  sourceUtteranceIds: string[]; // receipts, validated against the sampled/retrieved corpus
  origin: IdeaOrigin;
  clusterTitle: string | null; // group label for clustered ideas
  clusterThesis: string | null; // the novel-fusion thesis/tension of the cluster
  authorId: string | null; // collaborator lens for brainstormed ideas
  status: IdeaStatus;
  promotedMomentId: string | null;
  createdAt: string;
}

export type TalkStatus = 'open' | 'planned' | 'dismissed';

/** One grounded segment of a proposed talk's outline. */
export interface TalkSegment {
  title: string;
  summary: string;
  utteranceIds: string[]; // receipts grounding this segment
}

/** A candidate long-form talk the corpus can support — the discovery layer of `talk_kit`
 *  (docs/specs/talk-kit.md). Grounded (receipts + a grounded outline), tied to a concrete goal and
 *  outcome, scored for feasibility (corpus support) and novelty (vs already-delivered content). A
 *  proposal, not a talk_kit: "plan" marks one to develop later. */
export interface TalkProposal {
  id: string;
  workspaceId: string;
  title: string;
  goal: string; // concrete goal category (LLM-chosen; Rule 18)
  outcome: string; // the positive company outcome this talk drives
  thesis: string; // what the talk argues/teaches
  audience: string; // who it's for
  format: string; // suggested delivery format (webinar, workshop, conference_talk, podcast, …)
  outline: TalkSegment[];
  sourceUtteranceIds: string[]; // receipts making the talk feasible
  feasibility: number; // 0..1 how well the corpus supports a whole talk
  novelty: number; // 0..1 vs already-delivered talks/content
  rationale: string; // why now / why this
  buildsOn: string[]; // source titles it builds on/overlaps (delivered-talk awareness)
  status: TalkStatus;
  createdAt: string;
}

/** Attestation zone — the fix for "authorship laundering". A talking point is either a grounded
 *  claim, labeled scaffold, or a blank for the speaker. Only 'sourced' points carry receipts and
 *  pass the grounding gate; 'connective' and 'speaker_owned' are never presented as sourced fact. */
export type TalkPointZone = 'sourced' | 'connective' | 'speaker_owned';

export interface TalkPoint {
  text: string;
  zone: TalkPointZone;
  /** Verbatim span from a cited passage (sourced points only) — the thing the span-gate verifies. */
  supportingSpan?: string;
  utteranceIds: string[]; // receipts (sourced points only)
  spanMethod?: 'exact' | 'fuzzy'; // how the span verified (sourced points only)
}

export type SegmentCoverage = 'full' | 'partial' | 'thin';

export interface DevelopedSegment {
  title: string;
  summary: string;
  points: TalkPoint[];
  speakerNotes: string;
  coverage: SegmentCoverage; // from provenance density
  gapNote: string | null; // set when the corpus can't support the segment (honest gap, not confabulation)
}

/** A developed run-of-show for a planned talk. Honest by construction: attestation zones + per-segment
 *  coverage. Full long-form composition of the `talk_kit` direction (docs/specs/talk-kit.md). */
export interface TalkKit {
  id: string;
  workspaceId: string;
  talkId: string;
  title: string;
  segments: DevelopedSegment[];
  grounding: { sourced: number; dropped: number; faithfulnessApplied: boolean };
  createdAt: string;
}

/** The distilled brand voice — style plus soul — inferred from the workspace's published output.
 *  Each judgemental trait carries example utterance ids (receipts) it was inferred from. */
export interface VoicePersonaProfile {
  summary: string; // one-line "who this brand sounds like"
  register: string; // tone & cadence
  rhetoric: string; // how it builds an argument
  lexicon: { embraces: string[]; avoids: string[]; signaturePhrases: string[] };
  beliefs: { statement: string; exampleUtteranceIds: string[] }[]; // POV / worldview — the soul
  obsessions: string[]; // recurring themes
  dos: { rule: string; exampleUtteranceIds: string[] }[];
  donts: { rule: string; exampleUtteranceIds: string[] }[];
}

export interface VoicePersona {
  id: string;
  workspaceId: string;
  version: number;
  profile: VoicePersonaProfile;
  enabled: boolean;
  createdAt: string;
}

export interface EditEvent {
  id: string;
  workspaceId: string;
  draftId: string;
  /** The collaborator who authored this version, or null for the house editor. */
  authorId: string | null;
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
  clusterId: string | null;
  createdAt: string;
}

export interface Cluster {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  enabled: boolean;
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
