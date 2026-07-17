# NovelFusion

**A governed editorial memory system with generation attached.**

NovelFusion turns an organization's recorded voice — webinars, podcasts, customer calls — into
approved, provenance-backed marketing content, and turns every human editorial decision into a
versioned, scoped, regression-tested **editorial constitution**. Every claim has receipts
(timestamped source utterances); every principle is ratified against counterfactual diffs, not
prose; nothing goes live without shadow observation and one-click rollback.

- 📄 Product spec: [`docs/PRD.md`](docs/PRD.md)
- 🧭 Strategy record (panel decisions, market research, gate criteria): [`docs/SYNTHESIS.md`](docs/SYNTHESIS.md)
- 🤖 Agent operating rules: [`CLAUDE.md`](CLAUDE.md)

## Status: Phase 0

This repo currently implements the **pre-registered Phase 0 bench prototype** — the headless
distillation-loop experiment that decides whether the company gets built (kill/proceed criteria
in `SYNTHESIS.md` §4). No product UI yet, on purpose.

## Quick start

```bash
npm install
cp .env.example .env      # add ANTHROPIC_API_KEY
npm run typecheck && npm test

# The Phase 0 loop, end to end:
npm run nf -- --workspace demo init
npm run nf -- --workspace demo ingest samples/demo-webinar.txt
npm run nf -- --workspace demo extract          # LLM: transcript → ranked moments
npm run nf -- --workspace demo slate            # today's slate (top 5)
npm run nf -- --workspace demo weave <momentId> --format li_post
npm run nf -- --workspace demo show <draftId> --out /tmp/draft.txt
#   ...edit /tmp/draft.txt as a human editor would...
npm run nf -- --workspace demo edit <draftId> --file /tmp/draft.txt --reason off-voice
npm run nf -- --workspace demo distill          # LLM: edits → candidate principles
npm run nf -- --workspace demo ratify           # LLM: counterfactual diffs + blast radius → reports/
npm run nf -- --workspace demo accept <principleId>    # → shadow (blocked if blast radius >10%)
npm run nf -- --workspace demo promote <principleId>   # → active
npm run nf -- --workspace demo regress          # LLM: recurrence eval on holdout pairs
npm run nf -- --workspace demo report           # gate metrics vs. pre-registered thresholds
```

## How the loop enforces its own rules

- **Ratification is gated on behavior**: `nf accept` refuses to accept a principle that has no
  counterfactual run, or whose out-of-scope blast radius exceeds 10%.
- **Shadow before live**: accepted principles enter `shadow`; `promote` is a separate, deliberate step.
- **Holdout discipline (no eval contamination)**: ~30% of drafts are auto-marked holdout; holdout
  edits are never distilled and never retrieved as exemplars — they exist only to measure
  generalization (`nf regress`).
- **Provenance is structural**: hallucinated utterance IDs are dropped in code; consent gating and
  tenancy isolation are code paths, not prompts.
- **Every model call is traced** to `data/traces.jsonl` (stage, model, usage) and every eval run
  records enough config to re-run it (model, constitution version, git SHA).

## Layout

```
src/
  cli.ts                  # Phase 0 CLI (the PRD's "spreadsheet-grade UI")
  config.ts               # env config + feature flags (default OFF)
  domain/types.ts         # core entities (PRD §7 subset)
  db/                     # SQLite (better-sqlite3); schema.sql; workspace-scoped queries only
  llm/client.ts           # the single Claude chokepoint: model, structured outputs, caching, traces
  pipeline/
    ingest.ts             # transcripts → utterances (pure code)
    moments.ts            # utterances → ranked moments (LLM owns meaning)
    weave.ts              # moment → stubs → constitution-conditioned draft (+critique pass)
    edits.ts              # human edit capture (distiller signal, exemplar store)
    distill.ts            # edits → scoped candidate principles (+counterexamples)
    counterfactual.ts     # candidate → diffs + blast radius → ratification report
  eval/harness.ts         # recurrence eval: constitution-on vs. baseline on holdouts
  report/gate.ts          # Phase 0 gate metrics vs. thresholds
test/                     # pure-code units (parsing, diffing, blast radius)
samples/                  # fictional demo transcript
```
