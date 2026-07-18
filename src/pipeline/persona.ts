// Voice-persona distillation — the brand's voice AND soul, inferred from its PUBLISHED output
// (the voice-tagged corpus), the third conditioning layer alongside grounding and the constitution.
// Rule 18: the LLM owns the semantic read (what the brand sounds like and believes); code owns
// structure — it grounds every judgemental trait against the real voice passages (drops fabricated
// example ids), so the persona is inspectable and receipted, not a black box.

import { z } from 'zod/v4';
import { structured } from '../llm/client.js';
import { listVoiceUtterances, saveVoicePersona } from '../db/index.js';
import type { VoicePersonaProfile } from '../domain/types.js';

const MAX_INPUT_CHARS = 20000; // bound the distillation input; sample across sources if larger

const ProfileSchema = z.object({
  summary: z.string().describe('one line: who this brand sounds like'),
  register: z.string().describe('tone & cadence — formal↔casual, confident↔humble, sentence rhythm, how it opens/closes'),
  rhetoric: z.string().describe('how it builds an argument (data-first? story-first? contrarian?) and its go-to moves'),
  lexicon: z.object({
    embraces: z.array(z.string()).describe('words/jargon it uses'),
    avoids: z.array(z.string()).describe('words it conspicuously avoids (the negative space)'),
    signaturePhrases: z.array(z.string()).describe('distinctive recurring phrases'),
  }),
  beliefs: z
    .array(z.object({ statement: z.string(), exampleUtteranceIds: z.array(z.string()) }))
    .describe('the positions/worldview it stakes out REPEATEDLY — the soul. Cite the passage ids showing each.'),
  obsessions: z.array(z.string()).describe('the 3–5 themes it returns to'),
  dos: z.array(z.object({ rule: z.string(), exampleUtteranceIds: z.array(z.string()) })),
  donts: z.array(z.object({ rule: z.string(), exampleUtteranceIds: z.array(z.string()) })),
});

const SYSTEM = `You distill a company's VOICE and SOUL from a sample of its own PUBLISHED output (blog posts, social posts, talks, marketing).
Produce an inspectable brand persona: register (tone & cadence), rhetoric (how it argues), lexicon (words it embraces / conspicuously avoids / signature phrases), BELIEFS (the positions and worldview it stakes out repeatedly — this is the soul, not the style), obsessions (recurring themes), and do/don'ts for writing in this voice.

Rules:
- Read for what is DISTINCTIVE. The soul lives in the outliers and the sharpest lines, not the median — do not describe a generic, average, "professional B2B" voice. If the corpus is bland, say so plainly rather than inventing personality.
- Ground the judgemental traits (beliefs, dos, donts): cite the passage IDs (verbatim, as given) that show each. Do not cite an id you were not given.
- Capture the negative space too — what this brand would never say.
- If the corpus doesn't support a trait, leave it out. Abstaining beats padding.`;

/** Distill + persist the brand persona from the workspace's voice corpus (published output). */
export async function distillPersona(workspaceId: string): Promise<VoicePersonaProfile & { version: number }> {
  const passages = listVoiceUtterances(workspaceId);
  if (passages.length === 0) {
    throw new Error('No voice corpus yet. In Corpus, mark the sources that are the company\'s PUBLISHED output (blog, socials, talks) as "voice", then distill.');
  }

  // Sample across sources round-robin so no single source dominates, up to the char budget.
  const bySource = new Map<string, typeof passages>();
  for (const p of passages) { const arr = bySource.get(p.sourceId) ?? []; arr.push(p); bySource.set(p.sourceId, arr); }
  const queues = [...bySource.values()];
  const picked: typeof passages = [];
  let chars = 0;
  let anyLeft = true;
  while (anyLeft) {
    anyLeft = false;
    for (const q of queues) {
      const p = q.shift();
      if (!p) continue;
      anyLeft = true;
      if (chars + p.text.length > MAX_INPUT_CHARS) { anyLeft = false; break; }
      picked.push(p);
      chars += p.text.length;
    }
  }
  const validIds = new Set(picked.map((p) => p.id));
  const input = picked.map((p) => `${p.id}: ${p.text}`).join('\n');

  const profile = await structured({
    stage: 'distill-persona',
    system: SYSTEM,
    user: `PUBLISHED VOICE CORPUS (${picked.length} passages${picked.length < passages.length ? `, sampled from ${passages.length}` : ''}; format "id: text"):\n\n${input}`,
    schema: ProfileSchema,
    maxTokens: 6000,
  });

  // Ground the receipts: keep only example ids that are real voice passages (code owns structure).
  const clean = (ids: string[]) => ids.filter((id) => validIds.has(id));
  const grounded: VoicePersonaProfile = {
    summary: profile.summary.trim(),
    register: profile.register.trim(),
    rhetoric: profile.rhetoric.trim(),
    lexicon: {
      embraces: profile.lexicon.embraces,
      avoids: profile.lexicon.avoids,
      signaturePhrases: profile.lexicon.signaturePhrases,
    },
    beliefs: profile.beliefs.map((b) => ({ statement: b.statement, exampleUtteranceIds: clean(b.exampleUtteranceIds) })),
    obsessions: profile.obsessions,
    dos: profile.dos.map((d) => ({ rule: d.rule, exampleUtteranceIds: clean(d.exampleUtteranceIds) })),
    donts: profile.donts.map((d) => ({ rule: d.rule, exampleUtteranceIds: clean(d.exampleUtteranceIds) })),
  };
  const saved = saveVoicePersona(workspaceId, grounded);
  return { ...grounded, version: saved.version };
}
