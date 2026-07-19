# Spec: video generation — consent gate → real-footage → consented-likeness (PROPOSED, sequenced)

**Status:** Proposed · **Origin:** `SYNTHESIS.md §8` (3-panel adversarial review, 2026-07-19,
unanimous RECONSIDER) · **Phase:** consent-gate slice buildable now (additive, on-thesis); rendering
is post–Phase-0-gate.

This is the design record for adding video to NovelFusion **without** becoming ngram/HeyGen. It is
sequenced so the moat piece ships first and the synthetic presenter — the risky part — only lands on
top of infrastructure that can refuse to render an unconsented likeness.

## 1. What we are NOT building
- ❌ Generated synthetic protagonists (fabricated presenters). Stays killed (§2.2).
- ❌ Marketing-copy scripts read by an AI voice. Scripts are grounded `developTalk` output only.
- ❌ Ads-first synthetic polish. Lowest on-thesis; the authenticity thesis is weakest there.
- ❌ Own-render (in-house avatar/voice generation). BYO-renderer only.
- ❌ Any synthetic frame before the consent-grant gate + labeling exist.

## 2. What we ARE building (in order)

### Slice 1 — Consent-grant primitive + code-owned gate (build now; additive)
The moat piece. Valuable even if no synthetic frame ever renders — it upgrades the whole product's
consent story from source-level to per-person, scoped, revocable grants.

**Data model — `consent_grants`:**
```
id, workspace_id,
subject           TEXT  -- normalized person key for matching (lowercased name)
subject_label     TEXT  -- display name as entered
collaborator_id   TEXT  -- optional link to a collaborator
scopes            TEXT  -- JSON: subset of ['quote','clip','likeness','voice_clone']
channels          TEXT  -- JSON: ['all'] or specific channels
survives_departure INTEGER -- 0/1: does the grant persist if the person leaves?
evidence          TEXT  -- how consent was obtained (ref/note) — the audit anchor
granted_at        TEXT
revoked_at        TEXT  -- null = active; set = revoked (never hard-deleted → audit trail)
created_at        TEXT
```

**The gate (deterministic, code-owned — Rule 18 consent exemption, per PRD §8):**
`consentGate(workspaceId, { subject, scope, channel }) → { covered: boolean, reason, grantId? }`
- normalize `subject`; a grant covers iff same workspace + subject + `scopes` includes `scope` +
  (`channels` includes `channel` or `'all'`) + `revoked_at` is null.
- Fail-closed: no covering grant → `covered:false`. Identity match is structural (normalized string),
  never an LLM call.

**Scope ladder (narrowest→widest):** `quote` (text attribution) ⊂ `clip` (real footage of them) ⊂
`likeness` (synthetic face) ⊂ `voice_clone` (synthetic voice). A synthetic-presenter render requires
BOTH `likeness` and `voice_clone`. Real-footage clip requires `clip`. A pull-quote requires `quote`.

**Ship as product:** a Consent surface to add/revoke grants per person, see coverage. No existing
behavior changes (old paths byte-identical) until the gate is wired into a render path.

### Slice 2 — Real-footage clip rendering (post-gate)
Render the existing `clip_spec` AssetFormat into an actual clip: cut the real timestamped source
media, burn captions + brand, export 16:9/9:16/1:1. Requires: retained source media (see
`source_blobs`), timestamp gating (already enforced — `weave.ts` rejects doc/web timing fabrication),
and a `clip` consent grant for each on-screen person. Media/ffmpeg infra TBD. No synthetic anything.

### Slice 3 — Consented-likeness clip (flagged, post-gate, BYO-renderer)
`NF_FLAG_SYNTHETIC_VIDEO` default OFF. Pipeline: gated `developTalk` script → a **render manifest**
(scenes, per-scene sourced lines + receipts, presenter grant id, voice grant id, `aiDisclosure`
baked in, provider, channel) → an external renderer (HeyGen/ElevenLabs) makes pixels → export a
**signed provenance/consent bundle**. Render is BLOCKED by the gate unless `likeness` + `voice_clone`
grants cover the subject for the channel, and a named person approves. New external-network path →
Rule 15 security note. Provenance binding: manifest → grant → external asset id (`RenderProvenance`).

## 3. Legal / consent invariants
- **Article 50:** every synthetic asset carries an AI-generated label/manifest by construction; an
  unlabeled synthetic asset is unrenderable.
- **NO FAKES / departure:** a `voice_clone`/`likeness` grant with `survives_departure=false` stops
  covering the moment the person is marked departed — the gate then blocks new renders. (Whose
  approval survives departure is `SYNTHESIS §5 Q4`, still open — modeled here as an explicit flag.)
- **Consent is code, never model** (Rule 18 exemption; PRD §8). The gate is deterministic and
  fail-closed.

## 4. Open questions
- Person identity: match grants by normalized name vs a first-class `persons` table (speakers are
  strings on utterances today). Slice 1 uses normalized-name matching + optional collaborator link.
- Which renderer to integrate first for Slice 3 (HeyGen vs ElevenLabs-only for voice-over-real-footage).
- Real-footage media availability: how much of the corpus has retained source video/audio to cut from.
