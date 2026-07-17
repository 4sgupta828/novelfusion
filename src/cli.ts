#!/usr/bin/env node
// NovelFusion Phase 0 CLI — the "spreadsheet-grade UI" the PRD specifies for
// the bench prototype. Product UI comes only after the gate (PRD §12).

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import {
  admitSource,
  ensureWorkspace,
  getDb,
  getDraft,
  getPrinciple,
  listMoments,
  listPrinciples,
  updateMomentState,
  updatePrincipleStatus,
  listClusters,
  updateCluster,
  clusterMemberCounts,
} from './db/index.js';
import { clusterPrinciples } from './pipeline/clusters.js';
import { ingestFile, ingestDocument, ingestUrl } from './pipeline/ingest.js';
import { extractMoments } from './pipeline/moments.js';
import { embedBackfill, answerQuery } from './pipeline/retrieval.js';
import { proposeStubs, weaveDraft } from './pipeline/weave.js';
import { captureEdit } from './pipeline/edits.js';
import { distill } from './pipeline/distill.js';
import { latestBlastRadius, runCounterfactual } from './pipeline/counterfactual.js';
import { runRecurrenceEval } from './eval/harness.js';
import { renderGateReport } from './report/gate.js';
import { assertPrincipleTransition } from './domain/lifecycle.js';
import type { AssetFormat, EditReasonChip, RejectionChip } from './domain/types.js';

const program = new Command();
program.name('nf').description('NovelFusion — governed editorial memory (Phase 0 pipeline)').version('0.1.0');

const ws = (cmd: Command): string => {
  const w = cmd.optsWithGlobals().workspace as string | undefined;
  if (!w) throw new Error('--workspace is required');
  return w;
};

program.option('-w, --workspace <id>', 'workspace id (hard tenancy boundary)');

program
  .command('init')
  .description('create the local database')
  .action(() => {
    getDb();
    console.log(`DB ready at ${config.dbPath}`);
  });

program
  .command('ingest')
  .argument('<files...>', 'transcript files (.txt with "Speaker: text" or "[hh:mm:ss] Speaker: text" lines, or .vtt)')
  .option('--speaker <name>', 'default speaker for unattributed lines', 'Unknown Speaker')
  .option('--title <title>', 'source title')
  .description('ingest transcripts → sources + utterances')
  .action(function (this: Command, files: string[], opts: { speaker: string; title?: string }) {
    const workspaceId = ws(this);
    for (const f of files) {
      const { source, utteranceCount } = ingestFile(workspaceId, f, { speaker: opts.speaker, title: opts.title });
      console.log(`ingested ${source.title} → ${source.id} (${utteranceCount} utterances)`);
    }
  });

program
  .command('ingest-doc')
  .argument('<files...>', 'document files (.md / .txt) — owned company docs (supporting evidence)')
  .option('--title <title>', 'source title')
  .option('--pending', 'ingest to the quarantine (not eligible for extraction until admitted)')
  .description('ingest documents → owned_document segments')
  .action(function (this: Command, files: string[], opts: { title?: string; pending?: boolean }) {
    const workspaceId = ws(this);
    for (const f of files) {
      const { source, segmentCount } = ingestDocument(workspaceId, f, { title: opts.title, admitted: !opts.pending });
      console.log(`ingested doc ${source.title} → ${source.id} (${segmentCount} segments${opts.pending ? ', PENDING review' : ''})`);
    }
  });

program
  .command('ingest-url')
  .argument('<urls...>', 'public web page URLs — external references (supporting evidence)')
  .option('--title <title>', 'source title')
  .option('--pending', 'ingest to the quarantine')
  .description('ingest web pages → public_web segments')
  .action(async function (this: Command, urls: string[], opts: { title?: string; pending?: boolean }) {
    const workspaceId = ws(this);
    for (const u of urls) {
      const { source, segmentCount } = await ingestUrl(workspaceId, u, { title: opts.title, admitted: !opts.pending });
      console.log(`ingested url ${source.title} → ${source.id} (${segmentCount} segments${opts.pending ? ', PENDING review' : ''})`);
    }
  });

program
  .command('admit')
  .argument('<sourceId>')
  .description('admit a quarantined source into the corpus (makes it eligible for extraction)')
  .action(function (this: Command, sourceId: string) {
    admitSource(ws(this), sourceId);
    console.log(`admitted ${sourceId}`);
  });

program
  .command('embed')
  .description('backfill embeddings + FTS index for admitted passages (corpus retrieval)')
  .action(async function (this: Command) {
    if (!config.flags.corpusQuery) console.warn('note: NF_FLAG_CORPUS_QUERY is off — the Query surface will stay disabled, but embedding still runs.');
    const r = await embedBackfill(ws(this));
    console.log(`embedded ${r.embedded} passage(s); FTS-indexed ${r.ftsIndexed}${r.error ? ` (stopped: ${r.error})` : ''}`);
  });

program
  .command('query')
  .argument('<question...>', 'natural-language question answered from the corpus')
  .description('hybrid retrieval + grounded answer with receipts (LLM; needs OPENAI + ANTHROPIC keys)')
  .action(async function (this: Command, question: string[]) {
    if (!config.flags.corpusQuery) throw new Error('corpus query is disabled — set NF_FLAG_CORPUS_QUERY=true.');
    const workspaceId = ws(this);
    await embedBackfill(workspaceId);
    const r = await answerQuery(workspaceId, question.join(' '));
    if (r.gap) {
      console.log(`\n[coverage gap] the corpus does not support an answer — ${r.trace.coverageReason}.`);
      if (r.trace.dropped.length) console.log('dropped claims:', r.trace.dropped.map((d) => `${d.reason}`).join('; '));
      return;
    }
    console.log(`\n${r.answer}\n`);
    console.log('receipts:');
    for (const c of r.claims) console.log(`  • "${c.supportingSpan}" [${c.spanMethod}] ← ${c.utteranceIds.join(', ')}`);
  });

program
  .command('extract')
  .description('extract ranked moments from ingested utterances (LLM)')
  .action(async function (this: Command) {
    const workspaceId = ws(this);
    const { created, skipped } = await extractMoments(workspaceId);
    console.log(`extracted ${created.length} new moment(s)${skipped ? `, skipped ${skipped} already-extracted` : ''}`);
    for (const m of created.slice(0, 10)) {
      console.log(`  ${m.id}  [${m.score.toFixed(2)}] ${m.claim.slice(0, 90)}`);
    }
  });

program
  .command('slate')
  .option('-n, --top <n>', 'slate size', '5')
  .description("today's slate — top-ranked slated moments")
  .action(function (this: Command, opts: { top: string }) {
    const workspaceId = ws(this);
    const moments = listMoments(workspaceId, 'slated', parseInt(opts.top, 10));
    if (moments.length === 0) return console.log('slate is empty — run `nf extract`');
    for (const m of moments) {
      console.log(`\n${m.id}  score=${m.score.toFixed(2)}  novelty=${m.judgment.novelty.toFixed(2)}  cred=${m.judgment.credibility.toFixed(2)}`);
      console.log(`  “${m.claim}”`);
      console.log(`  why now: ${m.judgment.whyNow}`);
      if (m.judgment.riskFlags.length > 0) console.log(`  ⚠ risks: ${m.judgment.riskFlags.map((r) => r.kind).join(', ')}`);
    }
  });

program
  .command('reject')
  .argument('<momentId>')
  .requiredOption('--chip <chip>', 'not_our_pov | too_generic | off_limits_source | wrong_speaker | legal_risk | already_said')
  .description('reject a moment (typed rejection feeds the distiller)')
  .action(function (this: Command, momentId: string, opts: { chip: RejectionChip }) {
    updateMomentState(ws(this), momentId, 'rejected', opts.chip);
    console.log(`rejected ${momentId} (${opts.chip})`);
  });

program
  .command('stubs')
  .argument('<momentId>')
  .description('weaving surface stage 1 — one-line stubs (LLM)')
  .action(async function (this: Command, momentId: string) {
    const stubs = await proposeStubs(ws(this), momentId);
    for (const s of stubs) console.log(`- [${s.format} · ${s.angle} · ${s.audience}] ${s.stub}`);
  });

program
  .command('weave')
  .argument('<momentId>')
  .option('--format <format>', 'li_post | x_thread | blog | clip_spec', 'li_post')
  .option('--angle <angle>', 'editorial angle', 'default')
  .option('--template <id>', 'freeform | exec_brief | pyramid | data_drop', 'freeform')
  .option('--holdout', 'force this draft into the eval holdout set')
  .description('weave a full draft (LLM, constitution-conditioned)')
  .action(async function (this: Command, momentId: string, opts: { format: AssetFormat; angle: string; template: string; holdout?: boolean }) {
    const draft = await weaveDraft(ws(this), momentId, opts.format, opts.angle, { holdout: opts.holdout, template: opts.template });
    console.log(`draft ${draft.id} (template=${draft.template}, holdout=${draft.holdout}, constitution v${draft.constitutionVersion})\n`);
    console.log(draft.content);
    console.log(`\nprovenance: ${draft.provenance.length} claim span(s) · ${draft.sections.length} section(s) · ${draft.viz.length} figure(s)`);
  });

program
  .command('show')
  .argument('<draftId>')
  .option('--out <file>', 'also write draft content to a file (edit it, then `nf edit`)')
  .description('print a draft with provenance')
  .action(function (this: Command, draftId: string, opts: { out?: string }) {
    const d = getDraft(ws(this), draftId);
    if (!d) throw new Error(`draft ${draftId} not found`);
    console.log(d.content);
    console.log('\n--- provenance ---');
    for (const p of d.provenance) console.log(`“${p.quote.slice(0, 60)}…” ← ${p.utteranceIds.join(', ')}`);
    if (opts.out) {
      fs.writeFileSync(opts.out, d.content);
      console.log(`\nwrote ${opts.out}`);
    }
  });

program
  .command('edit')
  .argument('<draftId>')
  .requiredOption('--file <path>', 'file containing the human-edited version')
  .option('--reason <chip>', 'off-voice | off-strategy | risky | not-now | factual | style')
  .description('capture a human edit (the distiller signal)')
  .action(function (this: Command, draftId: string, opts: { file: string; reason?: EditReasonChip }) {
    const e = captureEdit(ws(this), draftId, opts.file, opts.reason ?? null);
    console.log(`captured edit ${e.id} (holdout=${e.holdout})`);
  });

program
  .command('distill')
  .description('distill non-holdout edits into candidate principles (LLM)')
  .action(async function (this: Command) {
    const created = await distill(ws(this));
    console.log(`proposed ${created.length} candidate principle(s):`);
    for (const p of created) console.log(`  ${p.id} [${p.tier}] ${p.text} — scope ${JSON.stringify(p.scope)}`);
    console.log('\nrun `nf ratify` to generate counterfactual-diff reports.');
  });

program
  .command('ratify')
  .option('--principle <id>', 'ratify one principle (default: all candidates)')
  .description('counterfactual-diff reports for candidate principles (LLM) — ratification is gated on these')
  .action(async function (this: Command, opts: { principle?: string }) {
    const workspaceId = ws(this);
    const targets = opts.principle
      ? [opts.principle]
      : listPrinciples(workspaceId, 'candidate').map((p) => p.id);
    if (targets.length === 0) return console.log('no candidates — run `nf distill`');
    for (const id of targets) {
      const r = await runCounterfactual(workspaceId, id);
      const flag = r.blast.radius > 0.1 ? '⛔ blast radius exceeds 10%' : '✅';
      console.log(`${id}: in-scope ${r.blast.inScopeChanged}/${r.blast.inScopeTotal} changed, out-of-scope ${r.blast.outOfScopeChanged}/${r.blast.outOfScopeTotal} ${flag}`);
      console.log(`  report → ${r.reportPath}`);
    }
  });

program
  .command('accept')
  .argument('<principleId>')
  .description('accept a candidate → SHADOW (never straight to active)')
  .action(function (this: Command, principleId: string) {
    const workspaceId = ws(this);
    const principle = getPrinciple(workspaceId, principleId);
    if (!principle) throw new Error(`Principle ${principleId} not found.`);
    assertPrincipleTransition(principle.status, 'accept');
    const blast = latestBlastRadius(workspaceId, principleId);
    if (blast.inScopeTotal + blast.outOfScopeTotal === 0) {
      throw new Error('No counterfactual run for this principle — `nf ratify --principle <id>` first. Ratification is gated on diffs.');
    }
    if (blast.radius > 0.1) {
      throw new Error(`Blast radius ${(blast.radius * 100).toFixed(0)}% > 10% — narrow the scope or reject (see ratification report).`);
    }
    updatePrincipleStatus(workspaceId, principleId, 'shadow');
    console.log(`${principleId} → shadow. Promote with \`nf promote ${principleId}\` after observation.`);
  });

program
  .command('promote')
  .argument('<principleId>')
  .description('promote a shadow principle → ACTIVE')
  .action(function (this: Command, principleId: string) {
    const workspaceId = ws(this);
    const principle = getPrinciple(workspaceId, principleId);
    if (!principle) throw new Error(`Principle ${principleId} not found.`);
    assertPrincipleTransition(principle.status, 'promote');
    updatePrincipleStatus(workspaceId, principleId, 'active');
    console.log(`${principleId} → active`);
  });

program
  .command('cluster')
  .description('auto-cluster unclustered principles into themes (LLM), then list clusters')
  .action(async function (this: Command) {
    const workspaceId = ws(this);
    const { created, assigned } = await clusterPrinciples(workspaceId);
    console.log(`created ${created.length} cluster(s), assigned ${assigned} principle(s)`);
    const counts = clusterMemberCounts(workspaceId);
    for (const c of listClusters(workspaceId)) {
      console.log(`  ${c.enabled ? '[ON ]' : '[OFF]'} ${c.name} — ${counts.get(c.id) ?? 0} principle(s)  ${c.id}`);
    }
  });

program
  .command('cluster-toggle')
  .argument('<clusterId>')
  .argument('<on|off>')
  .description('enable/disable a cluster (escape hatch — suspends its active principles from generation)')
  .action(function (this: Command, clusterId: string, state: string) {
    const workspaceId = ws(this);
    updateCluster(workspaceId, clusterId, { enabled: state === 'on' });
    console.log(`cluster ${clusterId} → ${state === 'on' ? 'enabled' : 'disabled (suspended from generation)'}`);
  });

program
  .command('reject-principle')
  .argument('<principleId>')
  .description('reject a candidate/shadow principle')
  .action(function (this: Command, principleId: string) {
    const workspaceId = ws(this);
    const principle = getPrinciple(workspaceId, principleId);
    if (!principle) throw new Error(`Principle ${principleId} not found.`);
    assertPrincipleTransition(principle.status, 'reject');
    updatePrincipleStatus(workspaceId, principleId, 'rejected');
    console.log(`${principleId} → rejected`);
  });

program
  .command('constitution')
  .description('list principles by status')
  .action(function (this: Command) {
    const all = listPrinciples(ws(this));
    if (all.length === 0) return console.log('constitution is empty');
    for (const p of all) {
      console.log(`${p.id} [${p.status}] (${p.tier}, scope ${JSON.stringify(p.scope)})\n  ${p.text}`);
    }
  });

program
  .command('regress')
  .option('--pairs <n>', 'max holdout pairs', '10')
  .description('recurrence eval: constitution-on vs. baseline against human-edited holdouts (LLM)')
  .action(async function (this: Command, opts: { pairs: string }) {
    const r = await runRecurrenceEval(ws(this), parseInt(opts.pairs, 10));
    console.log(`pairs: ${r.pairs}`);
    console.log(`mean distance to human final — baseline: ${r.meanDistanceBaseline.toFixed(3)}, constitution: ${r.meanDistanceConstitution.toFixed(3)}`);
    console.log(`edit-recurrence reduction: ${(r.reductionFraction * 100).toFixed(0)}% (gate: ≥30%)`);
  });

program
  .command('report')
  .description('Phase 0 gate metrics vs. pre-registered thresholds')
  .action(function (this: Command) {
    const workspaceId = ws(this);
    const md = renderGateReport(workspaceId);
    console.log(md);
    fs.mkdirSync(config.reportsDir, { recursive: true });
    const p = path.join(config.reportsDir, `gate-${workspaceId}.md`);
    fs.writeFileSync(p, md);
    console.log(`\nwritten → ${p}`);
  });

// Workspace bootstrap convenience.
program
  .command('workspace')
  .argument('<id>')
  .option('--name <name>')
  .description('create a workspace')
  .action((id: string, opts: { name?: string }) => {
    ensureWorkspace(id, opts.name);
    console.log(`workspace ${id} ready`);
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
