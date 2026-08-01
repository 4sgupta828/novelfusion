// Standalone bridge: {question, answer} JSON → a narrated explainer mp4, spoken as an
// experienced physician giving clear, reassuring guidance. Reuses the EXPERIMENTAL fusion
// generator (renderFusionVideo) via its raw-text `material` path — NO DB source lookup.
//
// This is a SEPARATE add-on entrypoint. It does not touch NovelFusion's own routes or the
// noesis kernel/research core. Input on stdin (or --file PATH); result JSON on the LAST stdout line.
//
//   echo '{"question":"...","answer":"...","title":"..."}' | tsx bin/answer-video.ts
//   tsx bin/answer-video.ts --file /tmp/qa.json
//
// Requires OPENAI_API_KEY (storyboard LLM if NF_MODEL is OpenAI, TTS voiceover) and
// NF_FLAG_FUSION_VIDEO=true. Loaded from novelfusion/.env via src/config.ts (dotenv).

import fs from 'node:fs';
import { config } from '../src/config.js';
import { ensureWorkspace } from '../src/db/index.js';
import { renderFusionVideo } from '../src/pipeline/fusion.js';

const WS = 'noesis-answers';   // one dedicated workspace for all bridged answers

function readInput(): { question: string; answer: string; title?: string } {
  const fileArg = process.argv.indexOf('--file');
  const raw = fileArg >= 0 && process.argv[fileArg + 1]
    ? fs.readFileSync(process.argv[fileArg + 1]!, 'utf8')
    : fs.readFileSync(0, 'utf8');   // stdin
  const obj = JSON.parse(raw);
  if (!obj || typeof obj.question !== 'string' || typeof obj.answer !== 'string') {
    throw new Error('input must be JSON with string "question" and "answer"');
  }
  return obj;
}

/** Frame the Q&A as material a physician-narrator turns into spoken guidance. The doctor
 *  PERSONA lives in the tone + voiceInstructions; the material is the grounded content. */
function physicianMaterial(question: string, answer: string): string {
  return [
    `PATIENT QUESTION: ${question}`,
    ``,
    `EVIDENCE-BASED ANSWER (the ONLY facts to convey — do not add medical claims beyond these):`,
    answer,
    ``,
    `Turn this into guidance an experienced physician would give a patient: explain what the`,
    `evidence says in plain, reassuring language, what it means for them, and sensible next`,
    `steps (including "discuss with your own doctor"). Do not invent statistics, drugs, doses,`,
    `or outcomes that are not in the answer above.`,
  ].join('\n');
}

async function main() {
  if (!config.flags.fusionVideo) {
    throw new Error('fusion video disabled — set NF_FLAG_FUSION_VIDEO=true');
  }
  const { question, answer, title } = readInput();
  ensureWorkspace(WS, 'Noesis answers');
  const video = await renderFusionVideo(WS, {
    material: physicianMaterial(question, answer),
    title: title || question.slice(0, 80),
    origin: 'answer',
    tone: 'an experienced, warm physician giving calm, clear, reassuring guidance to a patient',
    voice: 'onyx',
    voiceInstructions:
      'Speak as a seasoned, empathetic doctor talking directly to a patient: measured, warm, '
      + 'clear and unhurried. Reassuring but honest; never alarmist, never salesy.',
    captions: true,
    format: '16:9',
    theme: 'midnight',
  });
  // LAST line = machine-readable result (earlier lines may hold LLM/ffmpeg progress).
  process.stdout.write('\n' + JSON.stringify({
    filePath: video.filePath, filename: video.filename,
    durationSec: video.durationSec, title: video.title, id: video.id,
  }) + '\n');
}

main().catch((e) => {
  process.stderr.write(`answer-video failed: ${e?.message || e}\n`);
  process.exit(1);
});
