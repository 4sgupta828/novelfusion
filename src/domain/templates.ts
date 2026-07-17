// Content templates — named section structures with intent framing, adapted for
// marketing/PR thought leadership. A template turns a weave from "write a post"
// into "argue this position through these load-bearing moves." The model fills
// each section against its intent; the UI frames each with its title + intent.

export interface TemplateSection {
  key: string;
  title: string;
  /** The editorial job of this section — steers the model and frames it for the reader. */
  intent: string;
  /** Where charts naturally belong (the model still decides whether data warrants one). */
  vizAnchor?: boolean;
}

export interface ContentTemplate {
  id: string;
  name: string;
  /** One line shown in the template picker. */
  blurb: string;
  sections: TemplateSection[] | null; // null = freeform (no imposed structure)
}

export const TEMPLATES: ContentTemplate[] = [
  {
    id: 'freeform',
    name: 'Freeform',
    blurb: 'No imposed structure — the writer shapes the piece to the moment.',
    sections: null,
  },
  {
    id: 'exec_brief',
    name: 'Executive POV brief',
    blurb: 'Frame a decision or stake a position — for founder/exec thought leadership.',
    sections: [
      { key: 'at_stake', title: "What's at stake", intent: 'Frame the decision and what a good outcome is judged on.' },
      { key: 'evidence', title: 'Where the evidence points', intent: 'State where the grounded evidence points.', vizAnchor: true },
      { key: 'options', title: 'The paths on the table', intent: 'Lay out the distinct approaches the evidence frames.' },
      { key: 'tradeoffs', title: 'Tradeoffs & precedents', intent: 'Surface the tradeoffs and any precedents cited.' },
      { key: 'confidence', title: 'Confidence & exposure', intent: 'State the confidence level and the downside exposure.' },
      { key: 'the_ask', title: 'The ask', intent: 'State what the decision requires and the concrete call to the reader.' },
    ],
  },
  {
    id: 'pyramid',
    name: 'Pyramid synthesis',
    blurb: 'Synthesize a cluster of insight — for state-of-the-industry / analyst-style pieces.',
    sections: [
      { key: 'gist', title: 'The gist', intent: "One-sentence synthesis of the core insight, grounded in the evidence." },
      { key: 'themes', title: 'The themes', intent: 'The 2–4 dominant themes, each grounded in a specific claim.', vizAnchor: true },
      { key: 'key_findings', title: 'Key findings', intent: 'The most evidentiary, most-quotable findings, attributed.', vizAnchor: true },
      { key: 'tensions_gaps', title: 'Tensions & gaps', intent: 'Contested points, contradictions, or open questions the evidence leaves.' },
    ],
  },
  {
    id: 'data_drop',
    name: 'Data drop',
    blurb: 'A stat-led, chart-forward piece built around the strongest numbers.',
    sections: [
      { key: 'hook', title: 'The number', intent: 'Open on the single strongest quantified claim, stated plainly.', vizAnchor: true },
      { key: 'context', title: 'Why it matters', intent: 'What the number reveals about the reader’s own situation.' },
      { key: 'breakdown', title: 'The breakdown', intent: 'Develop the supporting data — the place charts and tables belong.', vizAnchor: true },
      { key: 'takeaway', title: 'The takeaway', intent: 'The one thing to do about it — the concrete call to the reader.' },
    ],
  },
];

export function getTemplate(id: string | undefined): ContentTemplate {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0]!;
}
