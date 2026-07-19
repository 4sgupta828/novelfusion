# Spec: `talk_kit` — long-form talk/webinar output (PROPOSED, post-gate, flag default OFF)

**Status:** Proposed · **Phase:** post–Phase-0-gate (do NOT build ahead of the `SYNTHESIS.md §4`
gate) · **Flag:** `NF_FLAG_TALK_KIT` (add to `src/config.ts`, `Field default false`, per Rule 20) ·
**Origin:** `SYNTHESIS.md §7` (3-panel adversarial review, 2026-07-18).

This is a **design stub**, not an implementation. It exists so the shape and its guardrails are
recorded before any code. Building it now would contaminate the pre-registered distillation gate and
drain the Phase-0 budget — all three panelists said hold. Ship only after the gate clears.

## 1. What it is / isn't

`talk_kit` is a **long-form, multi-segment weave output** for a talk a **real person delivers**
(webinar, podcast, conference, sales kickoff). "Webinar" is one instance; the format is generic.

- ✅ NovelFusion produces the **content + structure**; a real human presents it.
- ❌ NOT a synthetic avatar / cloned-voice presenter (`SYNTHESIS.md §2.2`; EU AI Act Art.50). Hard
  line, non-negotiable.
- ❌ NOT "the exec's authored POV" laundered from generated prose — see the attestation split (§4).

Two modes, deliberately separated because they have different economics:

| Mode | Input | Output | Economics | Exec-time cost |
|---|---|---|---|---|
| **1. Downstream repurposing pack** | a recording that ALREADY exists | posts + clips + sales-narrative one-pager, receipted | **paid product** | zero (async) |
| **2. Forward run-of-show prep** | intent + structure + corpus | segmented run-of-show, talking points, slides, speaker notes, Q&A prep | **free onboarding hook, NOT a paid output** | a live delivery slot — the scarce resource (`§2.4`) |

Mode 1 is the durable value (it *is* the graveyard thesis and feeds the §6 money story). Mode 2 is an
acquisition surface only, like retro-distillation (§3) / retro-resonance (§6.4) — never centered as
the product, because a whole talk is the worst artifact against the exec-attention constraint.

## 2. Data model

Reuse the existing draft shape — no new draft table:
- `Draft.sections: DraftSection[]` (`types.ts:104`) renders the segments (each segment = one section:
  `{key, title, body}`).
- `Draft.provenance: ProvenanceEntry[]` (`types.ts:97`) carries per-claim receipts.
- `Draft.viz: VizSpec[]` carries slide figures (gated — see §4).

New pieces required:
- **`AssetFormat` += `talk_kit`** (`types.ts:10`) and a `FORMAT_SPECS` entry (`weave.ts:170`).
- **A multi-moment / corpus-scoped composition input.** `weaveDraft` today is single-`momentId`
  (`weave.ts` takes one moment; `Draft.momentId` is 1:1, `types.ts:161`, `schema.sql:126`). A talk
  spans many moments across many sources. Options: (a) a `talkBrief` input `{intent, structure,
  seedMomentIds?}` that drives a corpus retrieval pass; (b) allow `Draft.momentIds: string[]` or a
  nullable `momentId` with a separate `composition` record. **Decision deferred to build time**;
  do NOT overload the single-moment path.
- **Attestation zones per section** (§4): tag each rendered span as `sourced | connective |
  speaker-owned`.

## 3. Pipeline (composition, corpus-scoped)

```
talkBrief {intent, structure, seedMomentIds?}
  → retrieve across corpus (retrieval.ts hybridSearch, workspace-scoped choke-point)
  → outline: LLM proposes segment arc for the intent/structure (ids validated, Rule 18)
  → per segment: draft talking points, each claim → grounding gate (§4) → receipts
  → speaker notes + Q&A prep (anticipated questions grounded in corpus)
  → condition throughout by voice persona (getActiveVoicePersona) + constitution (active principles)
  → critique-and-revise pass
```

`retrieval.ts` is currently a **separate query surface, not wired into weave** — wiring it in is the
core of the build. Retrieval finds; grounding judges (the research-system rule already in the repo).

## 4. Guardrails (mandatory — all panel-required)

1. **Grounding through the retrieval gates, not the weave id-filter.** Long-form claims must pass the
   `grounding.ts` span + numeric-token + different-family faithfulness gates, fail-closed
   (`retrieval.ts:197-220`). Weave today only filters fabricated ids (`weave.ts:314`) — too weak for
   a whole talk, where hallucination compounds across segments.
2. **Attestation split.** Every span is one of: `sourced` (has receipts), `connective` (transitions/
   framing — labeled non-attributable scaffold), `speaker-owned` (the presenter's own words, blank
   for them to fill). The UI must never present `connective` as the exec's authored POV. This is the
   fix for "authorship laundering."
3. **Provenance-density floor.** A segment below a minimum ratio of sourced:connective content is
   flagged (thin coverage) rather than shipped as confident.
4. **Slide numerics gated.** Any figure/table in `viz` must pass numeric + faithfulness grounding,
   not just carry ids (`VIZ_GUIDANCE`, `weave.ts:222` currently ungated for talk scale).
5. **Consent gating holds unchanged.** A talk that quotes an utterance without a covering consent
   grant blocks approval, deterministically (code, not model — PRD §8).
6. **Real-footage assembly** (scaled `clip_spec`) may only use timestamped sources — the existing
   guard (`weave.ts:246`) already blocks doc/web-only clips because timestamps would be fabricated.

## 5. Eval (build the held-out set FIRST — Rule 4/16)

Long-form's failure mode is **coverage collapse** (the id-filter fails safe, so the risk is
dropped/thin coverage, not fabrication) and cross-segment drift. Required held-out cases before build:
- a talk brief whose intent is only partially supported by the corpus → the kit must show explicit
  coverage gaps, not confabulate segments;
- a brief spanning multiple sources/speakers → no cross-speaker attribution errors;
- numeric-heavy slides → no fabricated figures survive the gate;
- an off-limits/consent-blocked source in scope → approval blocks.
Holdouts excluded from exemplar retrieval (Rule 5).

## 6. Open questions

- Willingness-to-pay for **prep** specifically (Q5.2 interviews) — is Mode 2 ever a paid output, or
  permanently a hook?
- Multi-moment contract shape (§2) — `momentIds[]` vs a `composition` record.
- Does `talk_kit` warrant its own scoped constitution namespace (`channel`), or inherit `blog`'s?
