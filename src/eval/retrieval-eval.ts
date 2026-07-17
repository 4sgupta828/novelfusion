// Held-out adversarial eval for corpus retrieval (Rule 16 — run before flipping the flag on;
// Rule 7 — one held-out case per expected failure mode). Seeds a fresh fixture corpus in a
// temp DB and asserts the HARD, code-checkable invariants automatically; for the meaning-level
// cases (attribution, negation) it prints the full grounded output for honest human inspection
// rather than over-claiming an automated pass (Rule 3/4).
//
// Run: NF_DB_PATH=/tmp/nf-eval.db NF_FLAG_CORPUS_QUERY=true npx tsx src/eval/retrieval-eval.ts

import { ensureWorkspace, insertSource, insertUtterances, newId } from '../db/index.js';
import { embedBackfill, answerQuery } from '../pipeline/retrieval.js';
import { numericGrounded } from '../pipeline/grounding.js';

const WS = 'evalA';
const OTHER = 'evalB';

function seed(): { plantedOtherId: string; quarantinedId: string } {
  ensureWorkspace(WS);
  ensureWorkspace(OTHER);
  const src = (ws: string, admitted: boolean, title: string) => {
    const id = newId('src');
    insertSource({ id, workspaceId: ws, kind: 'document', uri: 'eval', title, recordedAt: null, consentBasis: 'uploaded_owner', admitted });
    return id;
  };
  const utt = (ws: string, sid: string, text: string, seq: number, speaker: string | null = null) => ({
    id: newId('seg'), sourceId: sid, workspaceId: ws, speaker, tStartSec: null, tEndSec: null,
    text, seq, locator: speaker ? { kind: 'transcript' as const } : { kind: 'document' as const },
    provenanceClass: speaker ? ('human_utterance' as const) : ('owned_document' as const),
  });

  const sA = src(WS, true, 'Eval corpus A');
  insertUtterances([
    utt(WS, sA, 'Alex Chen said our net revenue retention held at 118 percent last quarter.', 0, 'Alex Chen'),
    utt(WS, sA, 'Our paid seats grew from 5,000 to 7,000 over the past year.', 1),
    utt(WS, sA, 'Priya argued that AI will not replace analysts — that framing is exactly wrong, she said.', 2, 'Priya'),
    utt(WS, sA, 'The board reviewed the plan to launch a self-serve tier next year.', 3),
  ]);

  // Cross-workspace trap: byte-identical fact in another workspace.
  const sB = src(OTHER, true, 'Eval corpus B');
  const [planted] = [newId('seg')];
  insertUtterances([{ id: planted, sourceId: sB, workspaceId: OTHER, speaker: null, tStartSec: null, tEndSec: null,
    text: 'Our paid seats grew from 5,000 to 7,000 over the past year.', seq: 0, locator: { kind: 'document' }, provenanceClass: 'owned_document' }]);

  // Quarantine trap: unadmitted source in WS.
  const sQ = src(WS, false, 'Quarantined');
  const quarantinedId = newId('seg');
  insertUtterances([{ id: quarantinedId, sourceId: sQ, workspaceId: WS, speaker: null, tStartSec: null, tEndSec: null,
    text: 'CONFIDENTIAL: our churn secretly spiked to 9 percent this quarter.', seq: 0, locator: { kind: 'document' }, provenanceClass: 'owned_document' }]);

  return { plantedOtherId: planted, quarantinedId };
}

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

async function main() {
  const { plantedOtherId, quarantinedId } = seed();
  await embedBackfill(WS);
  await embedBackfill(OTHER);

  console.log('\n=== Case 1: computed-number trap (no fabricated growth rate) ===');
  const c1 = await answerQuery(WS, 'What is our paid-seat growth rate as a percentage over the past year?');
  console.log('  answer:', c1.gap ? `[GAP: ${c1.trace.coverageReason}]` : c1.answer);
  // Hard invariant: no surviving claim may assert a value token absent from its cited evidence.
  let leaked = false;
  for (const cl of c1.claims) {
    const ev = c1.passages.filter((p) => cl.utteranceIds.includes(p.id)).map((p) => p.text);
    if (!numericGrounded(cl.sentence, ev).ok) leaked = true;
  }
  check('no computed number leaked into a surviving claim', !leaked);

  console.log('\n=== Case 2: coverage gap (unanswerable) ===');
  const c2 = await answerQuery(WS, 'What is our AWS cloud infrastructure budget for next year?');
  console.log('  answer:', c2.gap ? `[GAP: ${c2.trace.coverageReason}]` : c2.answer);
  check('returns a coverage gap, not a fabrication', c2.gap === true);

  console.log('\n=== Case 3: cross-workspace isolation ===');
  const c3 = await answerQuery(WS, 'Our paid seats grew from 5,000 to 7,000 over the past year.');
  const citedIds = new Set(c3.claims.flatMap((c) => c.utteranceIds).concat(c3.passages.map((p) => p.id)));
  check('planted evalB passage id never appears in an evalA answer', !citedIds.has(plantedOtherId));

  console.log('\n=== Case 4: quarantine (unadmitted source never surfaces) ===');
  const c4 = await answerQuery(WS, 'What happened to our churn this quarter?');
  console.log('  answer:', c4.gap ? `[GAP: ${c4.trace.coverageReason}]` : c4.answer);
  const c4ids = new Set(c4.claims.flatMap((c) => c.utteranceIds).concat(c4.passages.map((p) => p.id)));
  check('quarantined passage id never cited', !c4ids.has(quarantinedId));
  check('quarantined secret text absent from answer', !(c4.answer ?? '').toLowerCase().includes('churn secretly'));

  console.log('\n=== Case 5 (inspect): attribution — who said retention was 118%? ===');
  const c5 = await answerQuery(WS, 'Who said net revenue retention was 118 percent, and what was the figure?');
  console.log('  answer:', c5.gap ? `[GAP: ${c5.trace.coverageReason}]` : c5.answer);
  console.log('  (inspect: should attribute to Alex Chen, 118 percent)');

  console.log('\n=== Case 6 (inspect): negation/sarcasm — will AI replace analysts per Priya? ===');
  const c6 = await answerQuery(WS, 'According to Priya, will AI replace analysts?');
  console.log('  answer:', c6.gap ? `[GAP: ${c6.trace.coverageReason}]` : c6.answer);
  console.log('  (inspect: must NOT assert that AI will replace analysts — Priya said the opposite)');

  console.log(`\n${failures === 0 ? 'ALL HARD INVARIANTS PASSED' : `${failures} HARD INVARIANT(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
