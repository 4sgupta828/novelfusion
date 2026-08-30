# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
The AI Development Operating Rules below are project-agnostic lessons — keep them intact.

## What This System Does

NovelFusion is a **governed editorial memory system with generation attached**: it ingests an
organization's recorded media (webinars, podcasts, Zoom/Gong calls, public URLs), extracts
provenance-linked "moments," renders them into channel-native marketing drafts, and — the core
differentiator — turns every human edit/rejection into a **versioned, scoped, regression-tested
editorial constitution** with named-person approval and a consent ledger.

Read `docs/PRD.md` (product spec) and `docs/SYNTHESIS.md` (strategy record + panel decisions)
before making product-shaped changes. The non-goals in PRD §3 are hard constraints, not TODOs:
no private-chat ingestion, no synthetic avatars/voice cloning, provenance and consent gating are
never optional.

**Current phase: Phase 0** — the pre-registered six-week bench prototype of the distillation loop
(gate criteria in `SYNTHESIS.md` §4). Headless pipeline + markdown/CLI review surfaces. Do not
build product UI ahead of the gate.

## Session Workflow (worktree isolation — READ FIRST)

Every session that will **modify code** runs in its own git worktree on a dedicated branch.
Read-only sessions (questions, investigation, diagnostics that touch no files) stay on the
current checkout.

1. **Isolate before editing.** Before writing/editing code, create a worktree + branch off the
   current `main`. Do not edit files in the primary working directory
   (`/Users/sgupta/novelfusion`). If you started coding on `main` by mistake, stop and move the
   work onto a worktree branch. (Exception: the initial repo bootstrap was committed on `main`.)
2. **Do the full loop.** Inside the worktree: contract first (Rule 1), TDD where practical,
   rebase onto latest `main` before claiming done, re-run the strongest relevant checks
   (Rule 16), re-test after every rebase.
3. **Pushing/merging to `origin/main` is PROHIBITED — no exceptions.** Integration into
   `origin/main` is the user's action alone. Claude may commit on a feature branch and push the
   **feature branch** to open a PR; that is the only push Claude performs. Landing on *local*
   `main` requires the user's explicit permission for that specific merge, and the ONLY permitted
   integration is **rebase + `git merge --ff-only`** — linear history, zero merge commits. After
   landing, tag the new commits `<slug>-N` (oldest-first, local tags only, never pushed).
4. **Verify end-to-end before declaring done — yours, not the user's.** Phase 0 has no prod;
   the strongest check is the eval harness + a full CLI pipeline run on the sample corpus with
   real model calls when an API key is available (say plainly when it wasn't). Once a deploy
   target exists, prod verification becomes the mandatory final step.
5. **Clean up worktrees only after integration or explicit abandonment.** Never silently destroy
   unmerged work.
6. **Mirror any spec/doc produced in a worktree to `~/tmp/`** (same filename, re-copy on every
   edit) so the user can read it without a branch switch. The committed copy is canonical.

## Commands

```bash
npm install                 # deps
npm run typecheck           # tsc --noEmit
npm test                    # vitest (pure-code units: parsing, diffing, blast radius)
npm run build               # tsc → dist/

# Data safeguards — the DB (data/novelfusion.db) is the ONLY copy of everything. Rotating online
# backups are written OUTSIDE the repo (~/.novelfusion/backups) on server/CLI open + every 30 min;
# a startup alarm fires if the DB is unexpectedly empty while backups exist. NEVER `rm -rf data` from
# the repo root; verify/test DBs MUST live under the system temp dir (they are never backed up).
npm run nf -- backup                             # snapshot the DB to the rotating backup store now
npm run nf -- backups                            # list available backups (newest first)
npm run nf -- restore [file]                     # restore from a backup (latest if omitted; safety-copies current first)

# Pipeline CLI — `npm run nf -- --workspace <id> <cmd>` (needs ANTHROPIC_API_KEY for LLM stages)
npm run nf -- --workspace w1 init                # create local SQLite DB (data/novelfusion.db)
npm run nf -- --workspace w1 ingest <file...>    # transcripts → sources/utterances
npm run nf -- --workspace w1 embed               # backfill embeddings + FTS (corpus retrieval; needs OPENAI_API_KEY)
npm run nf -- --workspace w1 query "<question>"  # hybrid retrieval + grounded answer w/ receipts (flag NF_FLAG_CORPUS_QUERY, LLM+OpenAI)
npm run nf -- --workspace w1 extract             # utterances → ranked moments (LLM)
npm run nf -- --workspace w1 slate               # today's slate
npm run nf -- --workspace w1 stubs <momentId>    # weaving stage 1 (LLM)
npm run nf -- --workspace w1 weave <momentId> --format li_post        # draft (LLM)
npm run nf -- --workspace w1 edit <draftId> --file edited.txt --reason off-voice
npm run nf -- --workspace w1 distill             # edits → candidate principles (LLM)
npm run nf -- --workspace w1 ratify              # counterfactual diffs + blast radius (LLM)
npm run nf -- --workspace w1 accept <principleId>   # → shadow (gated on blast radius)
npm run nf -- --workspace w1 promote <principleId>  # → active
npm run nf -- --workspace w1 regress             # recurrence eval on holdouts (LLM)
npm run nf -- --workspace w1 report              # Phase 0 gate metrics vs. thresholds
```

## Architecture

- **TypeScript end-to-end.** CLI pipeline (`src/cli.ts`), no server in Phase 0.
- **Storage:** SQLite via `better-sqlite3` (`data/*.db`), schema in `src/db/schema.sql`.
  Postgres+pgvector is the Phase 1 target; keep SQL portable, keep all queries behind
  `src/db/index.ts`.
- **LLM:** Anthropic SDK, `claude-opus-4-8`, adaptive thinking, structured outputs via
  `client.messages.parse` + `zodOutputFormat`. All calls go through `src/llm/client.ts` —
  never construct ad-hoc clients; that wrapper owns model choice, caching breakpoints, retries,
  and trace logging (Rule 13).
- **Pipeline stages** (`src/pipeline/`): `ingest` → `moments` → `weave` (stubs → draft with
  constitution conditioning: ≤30 in-scope principles in-context + exemplar retrieval + a
  critique-and-revise pass) → `edits` (capture; exemplar store) → `distill` (edits → scoped
  candidate principles with contrast sets) → `counterfactual` (regenerate holdout under a
  candidate; diff; blast radius).
- **Corpus retrieval** (`src/pipeline/retrieval.ts`, flag `NF_FLAG_CORPUS_QUERY`, default OFF):
  research-system-style hybrid — BM25 (SQLite FTS5) + dense (OpenAI `text-embedding-3-small`,
  sidecar `passage_embeddings`) recall legs, fused by RRF. "Retrieval finds, grounding judges":
  legs return `{id,score}` only; ids become passage text ONLY through the workspace-scoped
  choke-point `getUtterancesByIdsOrdered` (a forgotten leg filter degrades to a dropped
  candidate, never a cross-workspace leak). The grounded answer is built per-claim and gated
  HARD/fail-closed: deterministic span-gate (`grounding.ts`, NFKC+difflib) + numeric-token gate
  + a **different-family (OpenAI) faithfulness judge**; zero survivors → a coverage gap, never a
  fabrication. Embeddings/FTS backfill idempotently and NEVER hard-fail ingest. FTS5 is
  non-portable — isolated behind `ftsSearch`/`ftsUpsertPassages` for the Phase-1 pgvector rewrite.
- **Eval harness** (`src/eval/`): edit-recurrence, compliance judge, regression churn. Built
  first, on purpose — **ratification is gated on counterfactual diffs from this harness.**
- **Domain invariants** (violating any of these is a bug, not a judgment call):
  - Every draft sentence that carries a claim maps to utterance IDs (`provenanceMap`). A draft
    with unresolved provenance cannot enter approval.
  - **Consent gating is code, not model.** Provenance touching an utterance without a covering
    consent grant blocks approval deterministically.
  - **Workspace isolation is a hard boundary.** No query, prompt, exemplar retrieval, or cache
    may cross workspaces. Cross-client principle leakage is a sev-1.
  - Principles are **scoped by default** (narrowest observed), enter **shadow** before live, are
    versioned, and are killable/rollbackable in one step.
  - Constitution export strips eval traces, evidence links, and provenance bindings.

## AI Development Operating Rules / Lessons Earned the Hard Way

These rules apply to Claude, Codex, Gemini, or any coding agent in this repository. When they
conflict, prefer correctness and safety over completeness, and completeness over speed, unless
the user explicitly chooses otherwise.

### 1. Start from the contract, not the code.
Every non-trivial change needs an explicit success criterion: "given input X, the system must
produce Y, while preserving Z." For bug fixes, the contract is the failing repro or test. If
unsure whether a change is trivial, treat it as non-trivial.

### 2. Read the existing system and invariants first.
Do not design from memory. Inspect the relevant modules, call sites, tests, schemas, and the
Domain invariants above before editing. Prefer the repository's existing patterns and data
contracts over a new abstraction. Respect operational costs (finite LLM budget — batch and cache
deliberately).

### 3. Distinguish verification strength honestly.
Import-check < typecheck < unit tests < integration < held-out eval < production. Never summarize
weak evidence as strong. Report the exact highest-signal check that ran, the input it used, and
what it proved. For LLM behavior in this repo, the relevant gates are the held-out sets under
`src/eval/` fixtures — not "the draft looked good."

### 4. When production (or a design partner) fails, ask why the eval missed it.
Find the held-out case that should have caught the failure. If there is none, the eval is the
bug: add the case first, watch it fail, then fix the system. If a reproducible eval is
impossible, preserve the raw artifact and state the remaining risk.

### 5. Few-shot examples are training data, not tests.
Every eval case must be held out from every prompt, exemplar, and fixture visible at inference
time. This repo retrieves **exemplar edits into prompts by design** — so eval holdout sets must
be excluded from exemplar retrieval explicitly (see `src/eval/`), and re-checked whenever
retrieval changes.

### 6. Audit-pass is provenance, not correctness.
A provenance chain proving "this text exists at utterance U" does not prove the *right* utterance
was selected, the claim was faithfully rendered, or the scope was right. Never present
"provenance N/N resolved" as evidence of semantic correctness; that requires gold-decision checks
on held-out data.

### 7. Design evals adversarially before prompt work.
LLM features fail at boundaries: similar utterances by different speakers, sarcasm/negation in
transcripts, principles that conflict only on specific inputs, scope bleed across channels or
clients, moments that are novel-sounding but already published. List expected failure modes
first; create at least one held-out case per mode.

### 8. Fix the data contract before the prompt.
Do not ask the model to infer what code can compute. Normalize transcripts, assign stable
utterance IDs, expose speaker + timestamps as structure, validate outputs with zod. When the
model picks a wrong-but-plausible sibling (wrong speaker, wrong span, wrong scope), first ask
whether the visible context contained the discriminator. Classify the failure (missing context /
wrong context / bad tool contract / bad ranking / bad validation / ambiguous task /
instruction-following) — only the last starts with a prompt edit.

### 9. Name patches and hacks out loud.
Before applying any hardcoded string, narrow regex, prompt mention of one customer's trivia, or
one-off branch, state: "this is a patch, not a fix; the principled fix is X — patch or fix?"
Never apply silently.

### 10. Stop when patches compound.
After the second symptom-patch in the same feature, stop coding and audit the design, data
contract, and eval coverage before any more changes.

### 11. Preserve experiment provenance.
Eval outputs and bug reports must record enough to re-run the case: model ID, prompt version,
constitution version, retrieval settings, input artifact IDs, expected vs. observed output, git
SHA. (The `EvalRun` record exists for exactly this.)

### 12. Keep context fresh and bounded.
Reread files before editing them; prefer targeted context over bulk pastes; the current file on
disk is the source of truth, not earlier conversation.

### 13. Build observability into LLM paths.
Logs must explain the decision, not just the crash: candidates visible, selected, rejected;
which principles fired and their dispositions; verifier results; remaining ambiguity. The LLM
wrapper (`src/llm/client.ts`) emits a trace record per call — keep that invariant when adding
stages.

### 14. Review the diff like an adversary.
Before declaring done: behavior changed? invariants preserved? data safety (corrupt/delete/
duplicate/leak)? error paths (empty/malformed input, timeouts, partial failures)? nearby
regressions? security (secrets, tenancy, new input/exec paths)? observability?

### 15. Treat security and privacy as non-negotiable.
Never hardcode secrets, log transcripts or PII beyond what tracing requires, weaken consent
gating or tenancy checks, or add a new external-input/network/exec path without an explicit
security note in the final report. Customer transcripts are confidential source data.

### 16. Ship only after the strongest relevant check runs.
Unit for pure logic (diffing, parsing, blast radius); integration for DB wiring; **held-out eval
for any LLM-behavior change** (extraction, weaving, distillation, judging); the full CLI
pipeline on the sample corpus for cross-stage changes. If the strongest check was not run, say
that plainly and name the residual risk.

### 17. Convene a judge panel for significant or complex decisions AND investigations.
For significant problems, ambiguous designs, or high-blast-radius changes, get independent
critique BEFORE committing. The panel has THREE mandatory members: **Codex (GPT-5.5)** and
**Gemini (3.1 Pro, fallback 2.5 Pro)** headless, PLUS a **code-grounded subagent** that reads the
repo and verifies file:line claims. Write ONE self-contained brief naming exact files and
instructing panelists to read them; dispatch all three in parallel in the background; relay each
recommendation honestly including disagreements; give a synthesized call.

```bash
codex exec --skip-git-repo-check -- "$(cat /tmp/brief.md)" < /dev/null > /tmp/codex.md 2>&1 &
# MUST pass -m (no -m silently downgrades gemini-cli to a weak flash default):
GEMINI_CLI_TRUST_WORKSPACE=true gemini -m gemini-3-pro-preview -p "$(cat /tmp/brief.md)" < /dev/null > /tmp/gemini.md 2>&1 &
# Fallback only on a genuine rate-limit/unavailable error: -m gemini-2.5-pro
```

A CLI panelist that genuinely cannot answer (rate limit, error, empty output, missing auth —
note: gemini-cli currently has no auth configured on this machine) is substituted by an
ADDITIONAL code-grounded subagent with the same brief — never run with fewer than three
perspectives, and say which panelists were substituted.

### 18. The LLM owns meaning — NO regex/keyword heuristics for semantic decisions, ever.
Every semantic decision — what counts as a moment, whether a claim matches an utterance's
meaning, principle scope and conflicts, novelty vs. the published corpus, judge verdicts — is
the LLM's job end to end. No keyword lists or regex branches as primary path, fallback,
pre-filter, or backstop; if the LLM abstains, **fail safe** (quarantine/abstain/explicit gap).
This does NOT ban code for genuinely computable/structural facts: timestamp math, utterance
offsets, diff computation, blast-radius counts, schema validation, tenancy checks, **consent
gating** (deliberately code, per PRD §8). Code owns structure; the model owns meaning — and
meaning never gets a regex shortcut.

### 19. Claude implements by default; escalate only the heaviest work to Codex.
Most work stays with Claude end to end. Escalate to `codex exec` ONLY for genuinely heavy tasks
(high blast radius, security-sensitive, dense multi-subsystem refactors). When escalating: one
self-contained brief (contract + invariants + files + success criterion), dispatch inside the
session's worktree, and **never ship Codex output unverified** — review like an adversary, rerun
the strongest checks, report honestly that it was Codex-authored and Claude-verified.

### 20. Ship user-facing or risky changes behind a flag, default OFF.
Any change altering user-visible behavior or LLM/prompt output ships behind a config flag
(`src/config.ts`, `Field default false`, flip via env) with the old path as the default branch —
byte-identical when OFF. Flip ON only after the strongest relevant check passes. Narrow
exemptions: pure bug fixes restoring intended behavior, internal refactors with no behavior
change, trivial copy fixes. If unsure, flag it. (Phase 0 is pre-launch; the rule binds fully
from the first design-partner deployment.)
