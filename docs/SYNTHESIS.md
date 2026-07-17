# NovelFusion — Strategic Synthesis

**Date:** 2026-07-16 · **Status:** Adopted (basis for PRD v1)
**Sources:** Two rounds of adversarial panel review (Codex GPT-5.5 + two independent research agents per round), primary research on Blazel, Writer, Typeface, Jasper, Gong, Castmagic/Opus Clip, HeyGen/Tavus/Synthesia, EU AI Act Art. 50, NO FAKES Act.

---

## 1. The market picture (verified July 2026)

**Blazel** (the trigger competitor) is a LinkedIn content + GTM platform: AI agent "Ember" + human strategists, voice interviews as input, voice-matched text posts + lead intelligence out. $200/seat/mo personal, $500/seat/mo team, custom enterprise. **~$10.3M pre-seed** (Sierra Ventures lead, Feb 2026; an earlier $73M figure from an aggregator was wrong). ~75 clients. Multichannel (Substack, X, Reddit, podcasts, earned media) is arriving in quarters, not years. Blazel is a well-funded *peer*, not an incumbent.

**The real incumbents** are enterprise content AI at $100K–$1M ACVs:
- **Writer** — Knowledge Graph (RAG over company data) + Voice profiles + **Playbooks/Agent Skills (Mar 2026)**: humans author global policy in natural language. This is the write-direction of our idea, already shipping.
- **Typeface** — Arc Graph brand intelligence + Video Agent (TensorTour acquisition) + "Arc Loop" performance-signal learning (opaque, not human-ratified).
- **Jasper** — Brand IQ reverse-engineers voice rules from examples; no ongoing edit→rule loop.
- **Gong** — sits on the richest utterance corpus in B2B; voice-of-customer → content is one product decision away.
- **Microsoft Copilot** — sits on Teams/chats/docs with pre-approved trust; ships meeting-transcript→content scenarios.
- **Acrolinx** — 20-year existence proof that enterprises pay for machine-enforceable editorial rulebooks (and of the failure mode: rulebases that rot without gardening).
- **Repurposing tools** (Castmagic $23/mo, Opus Clip $19/mo, ON24) — transcript→content mechanically, prosumer price band, no governance.

**Regulatory clock:** EU AI Act **Article 50 applies Aug 2, 2026** — synthetic media must carry AI labels even without deceptive intent (penalties to 3% of global turnover). **NO FAKES Act** cleared Senate Judiciary unanimously (June 2026) — a federal likeness/voice property right. Salesforce **fenced off Slack's API** (May 2025): no bulk export, no persistent indexes, no LLM use of Slack data.

## 2. What the panels killed (accepted constraints)

1. **No broad internal-comms mining.** Slack/Teams ingestion is contractually blocked (Slack ToS), legally toxic (Otter.ai wiretap class action, GDPR purpose limitation), and kills deals (marketing champion can't approve org-wide chat access; 6–12-month CISO/legal cycles at mid-market ACVs). Blazel's consent-shaped design (notetaker with permission, voluntary interviews) is the version that survives legal review.
2. **No synthetic avatar/voice-clone video in V1.** Post-Article 50, an "authenticity" product shipping videos legally labeled "AI-generated" is self-defeating. Real-footage clips only (a real person verifiably saying the real thing is not a deepfake).
3. **"Org-level semantic understanding" is not a moat.** It's a 1–3 quarter bolt-on for Writer/Typeface/Copilot. The EEM survives as internal architecture vocabulary only — never the pitch.
4. **The "100x" claim is dead.** Published evidence supports 1.3–2x broadly, ~5x on narrow sub-workflows; MIT NANDA: 95% of gen-AI pilots show no P&L impact. Demand-side capacity binds first: an exec credibly publishes ~3–5 posts/week, and approval throughput is a top-3 pain for a third of B2B content teams. Claim leverage, not multiplication.

## 3. What survived and compounded (the adopted strategy)

**The whitespace, one sentence:** nobody owns the trust layer between what an organization's people actually said and what gets published as marketing — timestamped-utterance provenance, per-person consent and approval, and a ratified, regression-tested editorial constitution — over recorded media the customer already owns.

**The product:** a **governed editorial memory system with generation attached** (not a generator with governance attached). Three compounding records form the moat:
1. **Consent ledger** — utterance-level provenance + per-person likeness/quote consent (rides the Article 50 / NO FAKES compliance tailwind; incumbents' brand-kit architectures don't do utterance lineage).
2. **Approval history** — what legal/comms/execs approved, edited, rejected, and why.
3. **Editorial constitution** — versioned, scoped principles distilled from edits, ratified against counterfactual diffs, regression-tested like code. The **regression corpus** (approved/rejected drafts under versioned constitutions) is the one asset a competitor cannot ingest or bolt on.

**The interaction paradigm** (the founder's collaboration thesis, panel-hardened): the human edits the *policy*, not just the prose. Three surfaces — Material (moments with exposed, correctable AI judgment), Weaving (fan-out as one-line stubs, draft on demand), Principles (edit → candidate principle → counterfactual-diff ratification → global application). It's the acquisition surface and the demo; the records are the moat.

**Panel-mandated design inversions:**
- **Eval harness first.** Ratification depends on counterfactual diffs ("this principle would have changed 7 of last month's 40 drafts"), so the regression harness is week-one infrastructure, not a later feature. The regression-diff screen is the hero surface — the one screen no competitor ships.
- **Ratify diffs, not sentences.** Humans ratify behavior, not plausible English.
- **Contain the constitution.** Scoped namespaces with precedence (company→exec→channel→audience→topic), narrowest-observed scope by default, shadow mode before live, per-principle override tracking + kill switches + TTL decay, ≤15–30 principles in-context (rest via critique-and-revise pass), hard tenancy boundary between agency clients. Documented failure modes (RLVF over-generalization; Acrolinx rot) — not hypothetical.
- **Exemplar memory is the floor.** Retrieving raw past edits as few-shot examples often beats abstracted rules; ship it as the guaranteed baseline under distilled principles.
- **Design to a hard attention budget.** Exposing AI reasoning does not reduce rubber-stamping (automation-bias literature) — only verification effort does. Ranked slate of ~5, stub-first fan-out, one-keystroke typed rejection, diff-based review, confidence routing with sampled audit, weekly batched ratification, direct rubber-stamp instrumentation (approved-and-published *rises* under rubber-stamping; it can't be the only metric).
- **Constitution export must strip eval traces + provenance bindings** — a legible constitution is otherwise a competitor migration file.
- **Retro-distillation onboarding** kills the constitution cold-start: seed principles from the customer's published content diffed against its source transcripts + their existing style guide. Also the wedge demo.

**GTM:** land via the zero-permission **"webinar graveyard" audit** (public recordings → 48-hour audit: "34 publishable exec insights from last quarter, here are 5 finished posts with receipts"). **Channel: exec-comms/ghostwriting agencies** (market ~3x since 2024; $1K–$10K/mo retainers; source-material gathering is their COGS; per-client constitution portfolios = switching cost). **Pricing: per managed voice/brand** ($500–1,500/mo, tiered by published volume) — never per-seat (invites the Blazel comparison; success reduces seats). Expand inward only by pull: opt-in channels, designated all-hands. Never ask for Slack.

## 4. The go/no-go gate (pre-registered)

Six-week headless bench prototype of the distillation loop with one agency design partner (2–3 client accounts): transcripts + 100–300 draft→edited-final pairs → distiller proposes scoped principles with counterfactual diffs → weekly ratification → apply to held-out drafts.

**Proceed:** 60–70% of proposed principles ratified without rewriting · covered-class edit recurrence ↓ ≥30–40% · blast radius (out-of-scope changes) <10% · zero cross-client leaks · blind preference by the approving exec ≥65% · ≥50% of edits map to generalizable principles.
**Kill:** endorsement <50% (distiller is noise) · edit distance flat (the loop is theater) · blast radius >25% (containment infeasible) · strategist disables principles to get work done.
**Fallback if killed:** the provenance/approval product stands alone as the wedge (panel-rated viable without the constitution).

## 5. Open questions carried forward

1. Zoom/Gong API + DPA terms in writing — do they permit derivative marketing content, and enclosure risk (Salesforce precedent)? Never let >40% of ingested volume depend on one vendor's API.
2. 20–25 willingness-to-pay interviews with mid-market CMOs/agency principals — numbers, not enthusiasm.
3. Blazel's actual video shipping status; whether the "internal mini-Blazel" enterprise play is real (no public evidence found).
4. Employee likeness consent at departure — whose approvals survive when the quoted person quits (NY SB 7676B / NO FAKES contractual design).
5. Post-Aug-2026 buyer appetite: will B2B marketers publish AI-labeled synthetic video at all, or does demand collapse to real-footage clips (we bet the latter)?
