// Template advisor — the LLM recommends which content template best fits a moment, with reasoning
// (Rule 18: which shape suits this content is a semantic call the model owns). Advisory only: the
// weave dialog pre-selects the recommendation and the user can override. Fails SOFT — if the model
// is unavailable, the caller falls back to the plain default (freeform), so weaving still works.

import { z } from 'zod/v4';
import { structured } from '../llm/client.js';
import { getMoment, getUtterancesByIds } from '../db/index.js';
import { TEMPLATES } from '../domain/templates.js';
import type { AssetFormat } from '../domain/types.js';

const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);
const FORMAT_IDS: AssetFormat[] = ['li_post', 'x_thread', 'blog', 'clip_spec'];

// LLM proposes free strings; code validates against the known-id allowlists (the sanctioned Rule-18
// pattern) and fails safe to sensible defaults rather than trusting an off-list value.
const SuggestionSchema = z.object({
  template: z.string().describe('the id of the best-fitting template'),
  format: z.string().describe('the id of the best-fitting asset format'),
  reasoning: z.string().describe('one or two sentences: why this template fits THIS moment specifically'),
});

export interface TemplateSuggestion {
  template: string;
  format: AssetFormat;
  reasoning: string;
}

const classOf = (pc: string) => (pc === 'human_utterance' ? 'SPOKEN' : pc === 'owned_document' ? 'DOC' : 'WEB');

export async function suggestTemplate(workspaceId: string, momentId: string): Promise<TemplateSuggestion> {
  const moment = getMoment(workspaceId, momentId);
  if (!moment) throw new Error(`Moment ${momentId} not found.`);
  const cited = getUtterancesByIds(workspaceId, moment.utteranceIds);
  const allTranscript = cited.length > 0 && cited.every((u) => u.locator.kind === 'transcript');

  const catalog = TEMPLATES.map((t) => {
    const secs = t.sections ? ` Sections: ${t.sections.map((s) => s.title).join(' → ')}.` : ' (no imposed structure).';
    return `- ${t.id} — "${t.name}": ${t.blurb}${secs}`;
  }).join('\n');
  const evidence = cited.map((u) => `[${classOf(u.provenanceClass)}] ${u.text}`).join('\n');

  const system = `You pick the best CONTENT TEMPLATE for turning a publishable "moment" into a marketing draft, and briefly say why.
Templates:
${catalog}

How to choose:
- data_drop → the moment's punch is one or more strong NUMBERS/stats; the piece should lead with the figure and a chart.
- exec_brief → the moment stakes a POSITION or frames a DECISION/tradeoff for a leadership audience.
- pyramid → the moment SYNTHESIZES several themes or findings into a state-of-the-industry view.
- freeform → a single sharp story/insight that doesn't need imposed structure.
Also pick an asset format: li_post (default), x_thread, blog (longer, more sections), or clip_spec.
IMPORTANT: clip_spec is ONLY valid when every cited passage is [SPOKEN] transcript (it needs video timing). This moment is ${allTranscript ? 'all transcript-grounded — clip_spec is allowed' : 'NOT all transcript-grounded — do NOT pick clip_spec'}.
Return the template id, the format id, and one or two sentences of reasoning specific to THIS moment.`;

  const user = `MOMENT: ${moment.claim}\nWHY NOW: ${moment.judgment.whyNow}\n\nGROUNDING PASSAGES:\n${evidence}`;

  const out = await structured({ stage: 'suggest-template', system, user, schema: SuggestionSchema, maxTokens: 1200 });

  // Validate against allowlists; fail safe.
  let template = TEMPLATE_IDS.includes(out.template) ? out.template : 'freeform';
  let format = (FORMAT_IDS as string[]).includes(out.format) ? (out.format as AssetFormat) : 'li_post';
  if (format === 'clip_spec' && !allTranscript) format = 'li_post'; // enforce the transcript constraint in code
  return { template, format, reasoning: out.reasoning.trim() };
}
