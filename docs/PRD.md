# PRD — NovelFusion (working name)

**A governed editorial memory system with generation attached.**
**Version:** 1.0 · **Date:** 2026-07-16 · **Status:** Approved for Phase 0 build
**Companion doc:** `docs/SYNTHESIS.md` (strategy record — the "why" behind every constraint here)

---

## 1. One-liner and positioning

> **Every edit you make becomes policy.** NovelFusion turns an organization's recorded voice — webinars, podcasts, customer calls, founder talks — into approved, provenance-backed marketing content, and turns every editorial decision into a versioned, regression-tested editorial constitution.

- **Against Blazel:** they interview execs to manufacture source material; we mine the recorded material that already exists — with receipts.
- **Against Writer/Typeface/Jasper:** they ground generation in brand guidelines and documents; we ground it in *timestamped human utterances* with named-person approval, and we learn policy *from edits*, not just from config.
- **Against Castmagic/Opus Clip:** they repurpose mechanically at $19–32/mo; we add the governance layer (consent, approval, constitution, audit) that makes the output publishable by an enterprise.
- **Positioning frame:** anti-slop infrastructure. As AI text floods LinkedIn and Article 50 forces "AI-generated" labels onto synthetic media, *"provably said by a real human, on the record, approved"* becomes the scarce good.

## 2. Users

| Persona | Role in product | What they need |
|---|---|---|
| **Editor** (agency content strategist / in-house content lead) — *primary user* | Runs the workbench daily. Reviews the slate, weaves drafts, edits, ratifies principles. | Leverage: more approved assets per week without quality loss. A system that visibly learns from their edits. |
| **Approver** (the quoted exec / SME) | One-tap approval of assets that quote them. Grants/holds likeness + quote consent. | Near-zero friction. Trust that nothing ships in their name without them. Mobile-friendly. |
| **Compliance viewer** (legal/comms, enterprise tier) | Read-only audit: provenance chains, consent ledger, constitution history. | Exportable audit trail; proof human review is genuine. |
| **Agency principal** — *buyer (agency channel)* | Manages client workspaces, billing, white-label QBR reports. | Per-client isolation guarantees; margin math; "constitution portfolio" as client-retention asset. |

## 3. Goals and non-goals

**V1 goals**
1. Ingest customer-owned recorded media (Zoom, Gong export, webinar/podcast libraries, uploaded video/audio/transcripts) and public URLs (YouTube/Wistia) — zero-permission path first.
2. Extract ranked, provenance-linked **moments**; render each chosen moment into channel-native **drafts** (LinkedIn post, X thread, blog section, real-footage clip spec).
3. **Constitution loop:** every edit/rejection → candidate principle → counterfactual-diff ratification → scoped, shadow-then-live application → regression suite.
4. **Approval + consent:** named-person one-tap approval; per-person consent ledger; immutable audit trail.
5. **Retro-distillation onboarding:** seed a constitution from published-content-vs-transcript diffs + imported style guide in <48h.
6. Crude but real distribution feedback: publish-to-LinkedIn integration + UTM/engagement pull-back per asset.

**Explicit non-goals (V1)** — each is a panel-decided constraint, not an oversight:
- ❌ Slack/Teams or any private-chat ingestion (contractually fenced, legally toxic, kills the sales cycle).
- ❌ Synthetic avatars / voice cloning (Article 50 labeling makes it brand-negative; real-footage clips only).
- ❌ Rendered video editing in-app (V1 emits clip specs: in/out timestamps, caption file, b-roll notes; rendering via existing tools).
- ❌ CRM lead-intelligence loop (Blazel's turf; revisit post-MVP).
- ❌ Per-seat pricing mechanics.
- ❌ Fine-tuning per customer (principles + exemplars via retrieval and prompting only).

## 4. Product principles (govern every design decision)

1. **Governance is the product; generation is a feature.** When a tradeoff pits draft quality against record integrity, the record wins.
2. **Ratify diffs, not sentences.** No principle goes live on the strength of plausible English; the editor accepts *behavior* (counterfactual diffs) or nothing.
3. **Hard attention budget: ≤45 editor-minutes/day.** Everything the system surfaces by default must fit it. Ranking is the product; if the system can't pick the top 4, it doesn't get to show 40.
4. **Rejection must be cheaper than acceptance.** One keystroke + typed reason chip. Rejection is generative (it feeds the distiller), never janitorial.
5. **Every claim has receipts.** No draft exists without a source-utterance chain (who, where, when, timestamp link). No exceptions, including manually written drafts (they attach sources at creation).
6. **Scoped by default, shadow before live, one-click rollback.** Treat every ratification like a production deploy, because it is.
7. **Exemplar memory is the floor.** If distillation underperforms, retrieved raw edits keep the product working.
8. **Instrument rubber-stamping honestly.** Approved-and-published volume *rises* under rubber-stamping — pair it with edit-engagement metrics and canary audits, and show the customer both.
9. **Client isolation is architecture, not configuration.** Cross-client principle leakage at an agency is a fireable incident; make it impossible, not unlikely.

## 5. System overview

```
                        ┌────────────────────────────────────────────────┐
  Sources               │  CORPUS  (per-tenant, per-client workspace)    │
  Zoom / Gong export    │  transcripts · diarization · utterance index   │
  webinar/podcast libs ─▶  voice profiles · topic-credibility map        │
  public URLs · uploads │  published-content archive                     │
  style-guide import    └───────────────┬────────────────────────────────┘
                                        │
                        ┌───────────────▼────────────────┐
                        │  MOMENT ENGINE                 │  extraction → scoring →
                        │  (exposed judgment, rankable)  │  dedupe vs. already-said
                        └───────────────┬────────────────┘
                                        │ Today's Slate (top ~5)
                        ┌───────────────▼────────────────┐
                        │  WEAVING ENGINE                │  angle × format × audience
                        │  stubs → outline → draft      │  constitution-conditioned
                        └───────────────┬────────────────┘
                                        │ edits / rejections (typed)
      ┌───────────────────┬─────────────▼─────────────┬──────────────────────┐
      │  CONSTITUTION     │  EVAL HARNESS (week one)  │  GOVERNANCE           │
      │  distiller →      │  compliance · regression  │  approval routing     │
      │  candidates →     │  counter-tests · judge    │  consent ledger       │
      │  diff ratification│  calibration              │  audit trail          │
      └───────────────────┴───────────────────────────┴──────────┬───────────┘
                                                                 │ publish
                                                     LinkedIn API · export · clip specs
                                                                 │
                                                     engagement pull-back (UTM, post stats)
```

Five subsystems: **Ingestion/Corpus**, **Moment Engine**, **Weaving Engine**, **Constitution + Eval Harness**, **Governance/Publishing**. The eval harness is built **first** (Phase 0) because ratification depends on it.

---

## 6. UX specification

### 6.1 Design language

- **Feel:** an editorial command center — calm, dense-but-legible, keyboard-first. Closer to Linear/superhuman than to a marketing suite. The user is a professional editor; respect their speed.
- **Typography-led:** content is text; the UI is built around a serif reading face for draft/source text and a compact sans for chrome. Generous line length limits (~68ch) in reading panes.
- **Provenance chips everywhere:** a compact, always-visible chip pattern — `▸ Priya Sharma · All-hands 6/12 · 00:14:32` — that click-expands to the transcript span with audio/video scrub. The chip is the visual signature of the product.
- **Color as state, not decoration:** neutral canvas; a single accent for actionable items; reserved semantic colors — amber = awaiting approval, violet = shadow-mode principle, red = risk flag/consent gap, green = published. Light + dark themes from day one.
- **Motion:** functional only — diff reveals, chip expansions, slate card transitions. 150–200ms, no ornamental animation.
- **Latency posture:** generation streams token-by-token into panes (Claude streaming API); anything >400ms shows skeletons with the provenance chip rendered first (source is known before the draft exists — show it first, always).
- **Keyboard grammar (global):** `j/k` navigate · `enter` open · `a` approve · `x` reject (opens chip picker: 1–6 for reason) · `e` edit · `w` weave · `.` expand judgment · `⌘k` command palette · `?` overlay. Every review action reachable without the mouse.

### 6.2 Surface 1 — Today's Slate (default screen)

The daily ranked queue. **Never a feed.**

- **Layout:** single centered column of 3–5 moment cards. A thin header shows the attention budget as a depleting bar ("~22 min of review today") — the system's promise made visible.
- **Moment card anatomy:**
  - Headline claim (the utterance, lightly cleaned, in the speaker's words — serif, quoted).
  - Provenance chip.
  - One-line "why now": `Novel vs. your published corpus · CEO is credible here · fits Thursday slot`.
  - Risk flags if any (red chip: `names a customer — consent needed`, `forward-looking claim`).
  - Actions: **Weave** (primary) · **Reject** (chip picker: *Not our POV · Too generic · Off-limits source · Wrong speaker · Legal risk · Already said*) · **Snooze**.
- **Judgment is progressive:** card shows the one-line verdict; `.` expands to evidence (similar past posts, competing interpretations of the utterance, constitution principles that informed ranking — each linked). Never a rationale paragraph by default — *judgment-as-diff, not judgment-as-essay*.
- **Corrections persist:** editor can correct an interpretation inline ("this isn't our POV", "mark this source off-limits") — correction writes to the corpus/constitution as a candidate, visibly: a toast `Correction captured → candidate principle for Friday review`.
- **"Show more" exists but is instrumented:** below the slate, a quiet `Show 12 more moments` link. Click-through rate is a product-health metric (target: rarely clicked — it means ranking works).
- **Empty state:** if the corpus has no fresh material, the slate says so plainly and offers the backlog ("Your webinar archive still holds 41 unmined moments").

### 6.3 Surface 2 — Weaving

Opened per-moment. Exploration without the firehose.

- **Stage 1 — stub grid:** a matrix of **one-sentence pitches** (angle × format), each cell ~15 words with reasoning on hover. Audiences as a segmented filter above the grid. Nothing is a full draft yet — twelve stubs is one glance, not twelve reading obligations.
- **Stage 2 — outline:** picking a cell renders a 4–6 line outline in a side pane (streamed). Editor can redirect ("more contrarian", "open with the customer story") via a one-line steer box; outline re-streams.
- **Stage 3 — draft:** explicit `Draft it` action renders the full asset. Draft pane is a real editor (rich-text for posts, MDX for blog) with:
  - **Provenance gutter:** every claim-bearing sentence carries a left-gutter dot; hover shows its source chip; a sentence with *no* source shows a hollow dot (visible, not blocking — but the approval step flags it).
  - **Constitution margin:** violations/tensions surface as violet margin markers (`tension with #P-014 "no unnamed-customer claims" v3`) — click to see the principle and either edit the draft or open a scope-exception flow.
  - **Edit capture:** all edits are diffed and stored; on save, if edits cluster into a recognizable pattern the system asks *once, inline, dismissibly*: `3 similar edits this week — draft a principle from these? [Later → Friday review]`. Never a modal, never blocking.
- **Series mode (diff-based review):** once a pattern is approved (e.g., weekly webinar recap), subsequent drafts render as **diffs against the approved pattern** — "identical except these three sentences." Re-reading unchanged prose is where review minutes die.
- **One moment → asset package:** a single weave can emit the LinkedIn post + X thread + blog section + clip spec as a linked set sharing one provenance chain; the editor toggles which to produce.

### 6.4 Surface 3 — The Constitution

The governance surface and the hero of the product.

- **Constitution browser:** principles as cards grouped by scope tier — `Company / Voice: <person> / Channel / Audience / Topic / Campaign (temporary)`. Each card: the principle text, scope tuple chips, status (`shadow · active · decaying`), fire-rate + **override-rate** sparklines, evidence count, owner, version, TTL/review date. Sort by override rate to find rotting principles.
- **Friday Review (batched ratification ritual):** candidates accumulate all week; ratification happens **only** in this scheduled 15-minute session — never streamed mid-flow (decisions under load are worthless and these apply globally). The session is a focused, full-screen flow:
  1. Candidate principle (proposed text, editable) + scope proposal (default: narrowest observed).
  2. **Evidence:** the 3–5 edits/rejections that spawned it, shown as diffs.
  3. **THE HERO SCREEN — counterfactual diff:** *"Under this principle, 7 of last month's 40 drafts would have changed."* Side-by-side diffs, paginated, with an explicit blast-radius readout: `7 in scope · 0 outside scope ✓`. Any out-of-scope hit renders red and blocks one-click ratification (editor must narrow scope or acknowledge).
  4. Conflict check: nearest-neighbor principles retrieved; input-conditional tensions shown with a concrete example, not an abstract warning.
  5. Decision: **Ratify → shadow (1 week)** · Rescope · Merge into existing · Reject (`too broad / not our rule / one-off taste / already covered`).
- **Shadow mode UI:** shadow principles annotate drafts (violet, advisory) without steering generation; after a week the system presents `would-have-changed` stats and promotes/demotes with one click.
- **Version history:** git-semantics timeline per principle and for the constitution as a whole — changelog, blame (which edits spawned it), diff between constitution vN and vN−1, **one-click rollback**. A misfire is a 30-second revert, not a trust-destroying week.
- **Regression dashboard:** per-principle compliance pass-rates, edit-recurrence trend (the product's core promise, measured), constitution-size gauge with in-context cap indicator.
- **Export:** emits principles as markdown **without eval traces, evidence links, or provenance bindings** (deliberate — the legible constitution must not be a competitor migration file). Full export available only as a signed compliance archive.

### 6.5 Surface 4 — Approvals & Consent (the Approver's world)

- **Approval queue (per approver):** mobile-first single-column list. Each item: the rendered asset exactly as it will publish, provenance chips inline, and three actions — **Approve** · **Edit suggestion** (inline comment) · **Decline** (reason). One item per screen; swipe/keys to advance. Target: <20 seconds per item.
- **Forced verification on high-stakes items:** assets containing consent-gated material (named customer, another person's quote, likeness use) require the approver to tap the source chip (plays the actual clip span) before Approve activates. This is the *only* place we add friction, deliberately — automation-bias research says verification effort, not exposure, prevents rubber-stamping.
- **Consent ledger:** per-person page: standing grants (quote / clip / channel-scoped), granted-when, revocation button (revocation auto-unpublishes flagged assets where APIs allow, flags the rest for manual takedown). Departure workflow: offboarding a person freezes their unpublished assets and produces a compliance report of published ones.
- **SLA visibility for editors:** the editor's view shows the approval pipeline as a kanban with per-approver latency ("Sam averages 26h — 3 assets waiting") — because approval throughput, not drafting, is the binding constraint.
- **Audit trail:** every asset carries an immutable event chain (created→edited→principle-fired→approved→published→engagement) exportable as a signed PDF/JSON bundle — the agency's QBR artifact and the enterprise compliance story.

### 6.6 Anti-rubber-stamp instrumentation (product-wide, honest-by-design)

- Dwell-time and approve-without-opening-evidence rates per reviewer, surfaced *to the customer* as "review health," framed as audit calibration (the compliance story requires proof review is genuine).
- **Canary drafts:** at a low sampled rate, a draft deliberately violating a ratified principle enters the queue; catching it is confirmation, missing it demotes the reviewer's confidence-routing lane to full review. Canaries are disclosed in aggregate ("2 calibration checks this month"), never as gotchas.
- **Confidence routing:** high-confidence, low-risk, in-pattern drafts route to a sampled-review lane (editor reviews a random 20%); sampled-agreement below threshold demotes the lane automatically. This is the only mechanism by which review effort scales sublinearly with output.

### 6.7 Onboarding — the 48-hour retro-distillation

1. Paste public URLs (webinars/podcasts/YouTube) — zero permissions — and/or connect Zoom/Gong/upload.
2. Import existing style guide (PDF/doc) → parsed into seed principles (provisional, shadow).
3. System diffs their **published content** against **source transcripts** → proposes the initial constitution ("here's the editorial policy you've been applying implicitly — 14 principles, with evidence") + the audit deck: top 25 publishable claims, top themes per exec, 20 clip specs, 5 finished sample posts with receipts.
4. First Friday Review ratifies the seed constitution. The "it already knows us" moment is the activation event.

---

## 7. Data model (core entities)

```typescript
// Tenancy: Org → Workspace (agency client) — HARD boundary: separate encryption
// keys per workspace; no query path crosses workspaces; principles, corpus,
// exemplars, and caches are all workspace-scoped.

Source        { id, workspaceId, kind: 'zoom'|'gong'|'upload'|'public_url'|'style_guide'|'published',
                uri, title, recordedAt, consentBasis: 'public'|'recorded_consent'|'uploaded_owner',
                diarization: SpeakerSpan[], transcriptRef, mediaRef? }

Utterance     { id, sourceId, speakerId, tStart, tEnd, text }   // the atomic provenance unit

Person        { id, workspaceId, name, role, voiceProfileRef,   // linguistic fingerprint
                credibilityTopics: string[], consentGrants: ConsentGrant[] }

ConsentGrant  { personId, scope: 'quote'|'clip'|'likeness', channels: string[],
                grantedAt, revokedAt?, evidenceRef }            // immutable ledger entries

Moment        { id, workspaceId, utteranceIds: string[], claim, judgment: {
                  noveltyVsPublished: number, credibility: number, riskFlags: RiskFlag[],
                  whyNow: string, calendarFit?: string },
                state: 'slated'|'rejected'|'snoozed'|'woven',
                rejection?: { reasonChip, byUserId, at } }

Weaving       { id, momentId, angle, format: 'li_post'|'x_thread'|'blog'|'clip_spec',
                audience, stub, outline?, draftId? }

Draft         { id, weavingId, content, version, provenanceMap: { sentenceIdx -> utteranceId[] },
                principleFirings: { principleId, version, disposition }[],
                editEvents: EditEvent[], state: 'draft'|'in_approval'|'approved'|'published'|'declined' }

EditEvent     { id, draftId, byUserId, diff, reasonChip?, at }   // distiller input; exemplar store

Principle     { id, workspaceId, text, scope: { client, channel?, audience?, person?, topic? },
                tier: 'L0_compliance'|'L1_brand'|'L2_channel'|'L3_taste',
                status: 'candidate'|'shadow'|'active'|'decaying'|'retired',
                evidence: EditEvent[], counterexamples: string[], owner, version,
                fireRate, overrideRate, ttlReviewAt, regressionSetRef }

ConstitutionVersion { id, workspaceId, principleVersions: {...}[], createdAt, changelog }

EvalRun       { id, workspaceId, constitutionVersionId,
                kind: 'compliance'|'regression'|'counterfactual'|'canary',
                results: {...}, judgeCalibrationRef }

ApprovalEvent { id, draftId, approverId, action: 'approved'|'suggested'|'declined',
                verifiedSources: utteranceId[], at }             // immutable

PublishRecord { id, draftId, channel, externalId, url, utm, publishedAt,
                engagementSnapshots: {...}[] }
```

**L0 compliance principles** (legal/regulatory: no unreleased-product claims, no named customers without consent) are enforced by deterministic checkers or a classifier pass **after** generation — never trusted to generation alone.

## 8. Pipeline & technical architecture

**Stack:** TypeScript end-to-end (Next.js app; Node workers for pipeline; Postgres + pgvector; object storage for media; Redis queue). Anthropic TypeScript SDK (`@anthropic-ai/sdk`) for all model calls. ASR/diarization via a best-in-class transcription API for uploads (public URLs with existing captions skip ASR).

**Model usage — all stages on `claude-opus-4-8`** (Anthropic's current recommended default; tier choices revisited after Phase 0 cost data):

| Stage | Pattern |
|---|---|
| Moment extraction | Streaming call per source chunk; **structured outputs** (`output_config.format` json_schema, or `client.messages.parse()` with Zod via `zodOutputFormat`) → typed `Moment[]` with utterance offsets. Adaptive thinking (`thinking: {type: "adaptive"}`). |
| Ranking/dedupe vs. published corpus | Retrieval (pgvector) + one scoring call per candidate batch, structured output. |
| Stub fan-out | One call per moment emits the full stub grid (cheap: ~15 words/cell), structured output. |
| Outline/draft | Streaming into the UI pane. Constitution conditioning = **retrieval of in-scope principles (≤15–30 in-context, L1 always, L2/L3 by scope) + exemplar retrieval (nearest past edits as few-shot)**, then a **critique-and-revise pass** against the remaining principles (the CAI-style application the panel specified). |
| Distiller | Batch job over the week's `EditEvent`s: cluster → propose `Principle` candidates with scope + counterexamples + auto-generated contrast set, structured output. |
| Counterfactual diffs / regression | **Message Batches API** (50% cost) — regenerate historical drafts under candidate/new constitution versions; diff + blast-radius computation in code. |
| LLM-judge (eval harness) | Rubric-based judge calls, structured verdicts; **calibrated against ≥200 human labels per workspace archetype before trusted** (budgeted explicitly — this is the step everyone skips). |
| Retro-distillation onboarding | Batches API over the full published-content × transcript corpus. |

**Prompt-caching discipline:** frozen system prompt per stage; workspace corpus context and constitution snapshot as stable cached blocks (`cache_control: {type: "ephemeral", ttl: "1h"}` on the last stable block); volatile per-request content after the last breakpoint. No timestamps/UUIDs in the prefix.

**Semantic vs. structural split (hard rule):** the model owns meaning (moment quality, principle scope, judgment); code owns structure (provenance offsets, diffs, blast-radius counts, tenancy checks, consent gating). **Consent gating is code**: a draft whose provenance map touches an utterance lacking a covering `ConsentGrant` cannot enter approval, full stop — no model in that path.

**Platform-risk guard:** ingestion adapters are pluggable; monitor per-vendor share of ingested volume with an alert at 40% (Slack-enclosure precedent). Customer-owned exports (Zoom cloud recordings, Gong export) preferred over live API dependence.

## 9. Eval harness (built first — Phase 0, weeks 1–2)

Frozen per-workspace corpus: past transcripts + approved outputs + rejected drafts with edit history. Three test families:

1. **Compliance tests** — per-principle checkers (deterministic where mechanical; calibrated LLM-judge with rubric otherwise) → per-principle pass rates.
2. **Regression tests** — regenerate the corpus under constitution vN vs vN−1 → churn on out-of-scope drafts (**blast radius**) + win-rate on sampled human-judged pairs.
3. **Counter-tests** — per principle: does it prevent recurrence of the edit class that spawned it (**edit-recurrence rate** — the product's entire promise, measured directly).

Judge calibration: ~200 human labels before any judge verdict gates a ratification; recalibrate quarterly and on model-version change.

## 10. Security, privacy, compliance

- SOC 2 Type II track from day one (table stakes, not differentiator). No training on customer data; per-workspace encryption keys; media at rest encrypted.
- Consent ledger + audit trail designed to the NO FAKES / NY SB 7676B shape: consent is per-person, per-scope, per-channel, revocable, and survives as evidence after revocation.
- Departure workflow (person leaves the org) is a first-class flow, not a support ticket.
- Article 50 posture: V1 publishes only real-footage clips and human-approved text — nothing requiring an AI-generated label. If synthetic media ever ships (post-V1), labeling is built-in, not bolted on.
- Data deletion: workspace off-boarding purges corpus + caches; compliance archive export precedes purge.

## 11. Metrics

**North star:** **approved-and-published assets per editor-week** (target: 2–3x the editor's pre-NovelFusion baseline by day 60 — honest number, not 100x).

**Guardrails (equal billing on the dashboard — the north star alone cannot detect the failure that matters most):**
- Edit-engagement rate (%, drafts opened-and-edited vs. approved untouched) and evidence-open rate.
- Canary catch rate ≥90%; sampled-lane agreement ≥85%.
- Principle health: ratification precision (≥60% accepted without rewrite), edit-recurrence ↓≥30% on covered classes, blast radius <10%, override rate per principle (auto-flag >20%).
- Approval latency p50 <24h; slate "show more" click rate (low is good); attention-budget adherence.
- Zero cross-workspace leaks (continuously verified by automated tenancy probes).
- Business: activation = first Friday Review completed ≤7 days from signup; logo retention; constitutions per agency account (expansion metric).

## 12. Phasing

### Phase 0 — the pre-registered gate (6 weeks, 2 engineers, ~$3–5K inference, 1 paid agency design partner w/ 2–3 client accounts)
Headless: ingestion (transcripts only) → eval harness → distiller → counterfactual-diff ratification screen (spreadsheet-grade UI) → constitution-conditioned regeneration on holdout.
**Proceed / kill criteria:** exactly as `SYNTHESIS.md` §4. Exemplar-memory baseline runs throughout — if raw retrieved edits match distilled principles on recurrence reduction, the architecture simplifies (constitution becomes curation-over-exemplars) and the PRD is amended before Phase 1.

### Phase 1 — MVP (≈12 weeks post-gate)
| In | Out (deferred) |
|---|---|
| Surfaces 1–4 as specced (§6) | Series/diff mode; confidence routing (start: full review) |
| Zoom + upload + public-URL ingestion; Gong export | Live Gong API; podcast-platform integrations |
| LinkedIn publish + engagement pull-back; clip specs + caption export | X/blog auto-publish (manual export in MVP) |
| Retro-distillation onboarding; consent ledger; audit export | White-label QBR generator (template export only) |
| 3–5 design partners (agency channel), per-managed-voice pricing | Self-serve signup |

MVP exit criteria: ≥3 partners at ≥2x editor throughput with edit-engagement ≥40% and zero governance incidents; ≥60% of published assets carry full provenance chains viewed at least once by an approver.

### Phase 2 (directional)
Confidence routing + series mode · agency white-label + QBR reports · X/blog publishing + attribution v2 (topic→pipeline) · opt-in expansion inward (designated all-hands, opt-in channels — pull, never push) · enterprise tier (SSO, compliance viewer, legal hold).

## 13. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Distillation precision too low (Phase 0 kill) | Medium | Pre-registered gate; exemplar floor; fallback = provenance product alone (panel-rated viable). |
| Incumbent bolt-on (Writer/Typeface ship edit→rule) | High, 2–4 quarters | Race on the un-bolt-onables: regression corpus, consent ledger, agency workflow embedding; 20+ logos in one vertical before the window closes. |
| Rubber-stamping degrades the loop silently | High | §6.6 instrumentation is core product, not telemetry; edit-engagement on the customer-facing dashboard. |
| Platform enclosure (Zoom/Gong follow Salesforce) | Medium | Customer-owned exports preferred; 40% single-vendor alert; DPA terms in writing pre-Phase 1. |
| One privacy/consent incident defines the category | Low-freq/high-sev | Consent gating in code, not model; forced verification; departure workflow; no private-comms ingestion at all. |
| Constitution rot (Acrolinx failure mode) | Medium | TTL decay, override-rate flagging, Friday ritual keeps gardening cheap. |
| Approval bottleneck caps the value story | High | Approver UX <20s/item, mobile-first, SLA visibility; it's why approvals are in MVP, not Phase 2. |

## 14. Open questions (owners assigned before Phase 1)

1. Zoom/Gong DPA + API terms in writing (derivative marketing content; enclosure clauses).
2. WTP interviews (n≥25): agency principals + mid-market CMOs; validate $500–1,500/managed-voice.
3. ASR/diarization vendor bake-off (accuracy on webinar audio; speaker-ID reliability drives provenance integrity).
4. Consent-at-departure legal review (NO FAKES trajectory; who owns approvals when the person quits).
5. Naming/trademark (NovelFusion is a working name).
6. Design-partner contracts: data rights for the regression corpus must be explicit and generous to us while honoring deletion rights.
