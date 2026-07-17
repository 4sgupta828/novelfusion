# NovelFusion Workbench — UI Guide

The product has one job: **turn what your people actually said into publishable marketing
content, and turn your editing taste into enforceable rules.** The four views are the four
stages of that assembly line. (Launch: `npm run ui` → http://localhost:4780. In-app version
of this guide: press `?`.)

## Vocabulary

| Term | Meaning |
|---|---|
| **Moment** | A publishable insight someone actually said, extracted from a transcript ("we killed our SLA dashboard…"). |
| **Weave** | Turn one moment into a piece of content — LinkedIn post, blog, X thread, or video clip spec. |
| **Receipt** (provenance chip) | The proof behind a claim: who said it, in which recording, at what timestamp. Click to unfold the transcript span. |
| **Edit capture** | Saving your correction to a draft as a diff + reason chip. Edits are the system's training signal. |
| **Principle** | An editorial rule distilled from your edits ("cut throat-clearing openers; start with the claim"). |
| **Constitution** | All ratified principles — the rulebook every future draft must obey. |
| **Blast radius** | The % of *out-of-scope* drafts a candidate principle would change. >10% blocks acceptance. |
| **Shadow** | A probation state: an accepted principle annotates drafts but doesn't steer them yet. |
| **Holdout** | Drafts/edits reserved for evaluation — never used as training signal, so the metrics stay honest. |

## 1 · Slate — "what's worth publishing today?"

Your daily editorial queue. The system reads your transcripts, finds the strongest moments,
ranks them, and shows only the top few — the **attention budget** bar in the header is the
promise that reviewing today's queue takes minutes, not hours.

Each card: the claim in quotes, a "why now" line, **novelty** (different from what you've
already published?) and **credibility** (is this speaker believable here?) scores, and red
**risk flags** (e.g. "names a customer — consent needed"). Two decisions per card:

- **Weave** — "yes, make content from this."
- **Reject** — "no," with a **typed reason** (not our POV / too generic / legal risk / …).
  The reason is training signal: the system learns your taste from what you kill, not just
  what you keep.

## 2 · Drafts — "the content, with receipts"

Weaving produces a **draft**. Opening one shows:

- **The content** — post, blog, thread, or clip spec (finished examples carry `approved` /
  `published` state).
- **Receipts** — every claim-bearing sentence mapped to its source utterance. Nothing ships
  that a real human didn't actually say; this is the anti-hallucination guarantee and the
  compliance story.
- **"Edit as the human editor"** — the most important button in the product. Corrections are
  captured as diffs with a reason chip: *your edit becomes policy.*

## 3 · Constitution — "your taste, made into law"

What separates NovelFusion from a content generator. After you've captured edits, **Distill**
asks: *what rule do these edits keep expressing?* Deleted the fluffy opener three times? It
proposes: "Cut throat-clearing openers; start with the claim itself."

The core safety idea: **you never ratify a rule because it sounds right — you ratify what it
would actually do.** **Ratify** runs the counterfactual: the rule is re-applied to recent
drafts and you review the diffs ("this rule would have changed these 3 posts, like this").
The **blast radius** check catches rules bleeding beyond their lane — above 10%, the Accept
button physically locks.

Lifecycle (enforced on the server, not just in the buttons):
**candidate → shadow (a week of observation) → active.** No shortcuts, one-click reject at
any point before active.

## 4 · Gate — "is this product actually working?"

The Phase 0 scoreboard against thresholds committed *before* building (`docs/SYNTHESIS.md` §4):
principle acceptance ≥60%, edit recurrence ↓≥30% with the constitution on, blast radius
contained, edit→principle coverage ≥50%. ⬜ means not yet measurable — honest, not broken.

## The loop, end to end

Transcript → **Slate** picks moments → **Weave** drafts with receipts → you edit →
**Distill** turns edits into candidate rules → **Ratify** proves each rule on diffs →
the constitution grows → future drafts come out closer to right → you edit less.
**Every hour of editing judgment becomes permanent infrastructure.**

## Keyboard

| Key | Action |
|---|---|
| `1`–`4` | Switch view (Slate / Drafts / Constitution / Gate) |
| `j` / `k` | Next / previous card |
| `Enter` | Open selected |
| `w` | Weave selected moment |
| `x` then `1`–`6` | Reject selected with typed reason |
| `.` | Open the first receipt on the selected card |
| `Esc` | Cancel rejection · close · back |
| `?` | In-app guide + shortcuts |
