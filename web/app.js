/* NovelFusion workbench — vanilla SPA over the local API.
   Keyboard-first: 1-4 views, j/k select, w weave, x reject, . expand, esc back.
   Panel-review fixes applied: render sequence guard, rejecting-state hygiene,
   selection clamping, gated Accept control, CSRF header, contrast tokens. */

const state = {
  ws: localStorage.getItem('nf.ws') || null,
  view: 'slate',
  sel: 0, // selected card index in list views
  detail: null, // { kind: 'draft'|'principle', id } when a detail pane is open
  rejecting: null, // moment id awaiting a reason chip (cleared on every render)
  animate: true, // entrance animation only on view switches, not on every re-render
  budgetMinutes: null, // single daily number, computed from the slate
};

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(`/api/${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-NF-Workbench': '1', // forces CORS preflight; the server rejects requests without it
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast${isError ? ' error' : ''}`;
  el.setAttribute('role', isError ? 'alert' : 'status');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 2600);
}

async function busy(btn, fn) {
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spin" aria-hidden="true">◌</span> working…`;
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

const fmtTime = (sec) => {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

/* ---------- provenance chips (the signature element) ---------- */

function chipHtml(u) {
  const src = u.sourceTitle ? ` · ${esc(u.sourceTitle)}` : '';
  return `<button class="chip" data-utt="${esc(u.id)}" aria-expanded="false">${fmtTime(u.tStartSec)} · ${esc(u.speaker)}${src}</button>`;
}

function wireChips(container, utterances) {
  const byId = Object.fromEntries(utterances.map((u) => [u.id, u]));
  $$('.chip[data-utt]', container).forEach((chip) => {
    chip.addEventListener('click', () => {
      const open = chip.getAttribute('aria-expanded') === 'true';
      chip.setAttribute('aria-expanded', String(!open));
      const row = chip.parentElement;
      // Receipts append AFTER the chip row so expanding never reflows sibling chips.
      $$(`.receipt[data-for="${CSS.escape(chip.dataset.utt)}"]`, row.parentElement).forEach((r) => r.remove());
      if (!open) {
        const u = byId[chip.dataset.utt];
        const r = document.createElement('div');
        r.className = 'receipt';
        r.dataset.for = chip.dataset.utt;
        r.textContent = `${u ? u.speaker : '?'} · ${u?.sourceTitle ?? 'unknown source'} @ ${fmtTime(u?.tStartSec)}\n${u ? u.text : 'utterance not loaded'}`;
        row.after(r);
      }
    });
  });
}

/* ---------- diff rendering ---------- */

function diffHtml(diffText) {
  const lines = diffText
    .split('\n')
    .filter((l) => !/^(===|---|\+\+\+|@@|\\ No newline)/.test(l))
    .map((l) => {
      let cls = '';
      if (l.startsWith('+')) cls = 'add';
      else if (l.startsWith('-')) cls = 'del';
      return `<div class="dline ${cls}">${esc(l) || '&nbsp;'}</div>`;
    });
  return `<div class="diff">${lines.join('')}</div>`;
}

/* ---------- figures: inline SVG charts, theme-aware, direct-labeled ---------- */
// Palette validated via the dataviz skill (4-slot categorical passes CVD + vision
// gates; light-contrast WARN is discharged by direct labels on every mark).

function fmtVal(v, unit) {
  const n = Math.abs(v) >= 1000 ? v.toLocaleString('en-US') : String(Math.round(v * 100) / 100);
  if (unit === '$') return `$${n}`;
  if (unit === '%') return `${n}%`;
  if (unit && unit !== 'x') return `${n} ${unit}`;
  if (unit === 'x') return `${n}×`;
  return n;
}
const seriesColor = (i, single) => (single ? 'var(--pencil)' : `var(--viz-${(i % 4) + 1})`);

function barSvg(series, unit) {
  const max = Math.max(...series.map((s) => s.value), 0) || 1;
  const rh = 30, gap = 12, padL = 4, w = 560;
  const barX = 150, barW = w - barX - 70;
  const h = series.length * (rh + gap);
  const single = series.length === 1;
  const rows = series
    .map((s, i) => {
      const y = i * (rh + gap);
      const fw = Math.max(2, (s.value / max) * barW);
      return `
      <text x="${barX - 10}" y="${y + rh / 2}" text-anchor="end" dominant-baseline="central" class="viz-cat">${esc(s.label)}</text>
      <rect x="${barX}" y="${y}" width="${barW}" height="${rh}" rx="5" class="viz-track"/>
      <rect x="${barX}" y="${y}" width="${fw}" height="${rh}" rx="5" fill="${seriesColor(i, single)}"><title>${esc(s.label)}: ${esc(fmtVal(s.value, unit))}</title></rect>
      <text x="${barX + fw + 8}" y="${y + rh / 2}" dominant-baseline="central" class="viz-val">${esc(fmtVal(s.value, unit))}</text>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${w} ${h}" class="viz-svg" role="img" preserveAspectRatio="xMinYMin meet" style="margin-left:${padL}px">${rows}</svg>`;
}

function pieSvg(series, unit) {
  const total = series.reduce((a, s) => a + s.value, 0) || 1;
  const cx = 90, cy = 90, r = 78, ir = 46;
  let acc = -Math.PI / 2;
  const arc = (start, end, i) => {
    const large = end - start > Math.PI ? 1 : 0;
    const p = (ang, rad) => `${cx + Math.cos(ang) * rad} ${cy + Math.sin(ang) * rad}`;
    return `<path d="M ${p(start, r)} A ${r} ${r} 0 ${large} 1 ${p(end, r)} L ${p(end, ir)} A ${ir} ${ir} 0 ${large} 0 ${p(start, ir)} Z" fill="${seriesColor(i, false)}" class="viz-slice"><title>${esc(series[i].label)}: ${esc(fmtVal(series[i].value, unit))}</title></path>`;
  };
  const slices = series
    .map((s, i) => {
      const start = acc;
      const end = acc + (s.value / total) * Math.PI * 2;
      acc = end;
      return arc(start, end, i);
    })
    .join('');
  const legend = series
    .map(
      (s, i) =>
        `<div class="viz-legend-row"><span class="viz-swatch" style="background:${seriesColor(i, false)}"></span><span class="viz-cat">${esc(s.label)}</span><span class="viz-val">${esc(fmtVal(s.value, unit))}</span></div>`,
    )
    .join('');
  return `<div class="viz-pie"><svg viewBox="0 0 180 180" class="viz-svg" role="img" width="180" height="180">${slices}</svg><div class="viz-legend">${legend}</div></div>`;
}

function lineSvg(series, unit) {
  const w = 560, h = 200, padL = 46, padR = 20, padT = 16, padB = 30;
  const max = Math.max(...series.map((s) => s.value)), min = Math.min(...series.map((s) => s.value), 0);
  const span = max - min || 1;
  const px = (i) => padL + (i / Math.max(1, series.length - 1)) * (w - padL - padR);
  const py = (v) => padT + (1 - (v - min) / span) * (h - padT - padB);
  const pts = series.map((s, i) => `${px(i)},${py(s.value)}`).join(' ');
  const area = `${padL},${py(min)} ${pts} ${px(series.length - 1)},${py(min)}`;
  const dots = series
    .map((s, i) => `<circle cx="${px(i)}" cy="${py(s.value)}" r="4.5" fill="var(--pencil)"><title>${esc(s.label)}: ${esc(fmtVal(s.value, unit))}</title></circle>`)
    .join('');
  const xlabels = series.map((s, i) => `<text x="${px(i)}" y="${h - 8}" text-anchor="middle" class="viz-axis">${esc(s.label)}</text>`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" class="viz-svg" role="img" preserveAspectRatio="xMinYMin meet">
    <line x1="${padL}" y1="${py(min)}" x2="${w - padR}" y2="${py(min)}" class="viz-grid"/>
    <text x="${padL - 8}" y="${py(max)}" text-anchor="end" dominant-baseline="central" class="viz-axis">${esc(fmtVal(max, unit))}</text>
    <polygon points="${area}" class="viz-area"/>
    <polyline points="${pts}" fill="none" stroke="var(--pencil)" stroke-width="2" stroke-linejoin="round"/>
    ${dots}${xlabels}</svg>`;
}

function tableHtml(t) {
  return `<table class="viz-table"><thead><tr>${t.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${t.rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i === 0 ? '' : 'num'}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function statHtml(series, unit) {
  const s = series[0];
  return `<div class="viz-stat"><div class="viz-stat-num">${esc(fmtVal(s.value, unit))}</div><div class="viz-stat-lbl">${esc(s.label)}</div></div>`;
}

function figureHtml(v, utterances) {
  let body = '';
  if (v.kind === 'bar') body = barSvg(v.series, v.unit);
  else if (v.kind === 'pie') body = pieSvg(v.series, v.unit);
  else if (v.kind === 'line') body = lineSvg(v.series, v.unit);
  else if (v.kind === 'table' && v.table) body = tableHtml(v.table);
  else if (v.kind === 'stat') body = statHtml(v.series, v.unit);
  const chips = (v.utteranceIds || [])
    .map((id) => utterances.find((u) => u.id === id))
    .filter(Boolean)
    .map(chipHtml)
    .join('');
  return `<figure class="figure">
    <figcaption class="figure-title">${esc(v.title)}</figcaption>
    <div class="figure-body">${body}</div>
    ${v.caption ? `<p class="figure-caption">${esc(v.caption)}</p>` : ''}
    ${chips ? `<div class="chip-row figure-source">${chips}</div>` : ''}
  </figure>`;
}

/** Render a templated draft: intent-framed sections interleaved with their figures. */
function structuredDraftHtml(d) {
  const vizFor = (key) => d.viz.filter((v) => v.afterSection === key).map((v) => figureHtml(v, d.utterances)).join('');
  const placed = new Set(d.viz.filter((v) => v.afterSection).map((v) => v.afterSection));
  const sections = d.sections
    .map(
      (s) => `<section class="draft-section">
        <h3 class="draft-section-title">${esc(s.title)}</h3>
        <div class="draft-section-body">${esc(s.body)}</div>
        ${vizFor(s.key)}
      </section>`,
    )
    .join('');
  const trailing = d.viz.filter((v) => !v.afterSection || !placed.has(v.afterSection)).map((v) => figureHtml(v, d.utterances)).join('');
  return `<div class="draft-structured">${sections}${trailing}</div>`;
}

/* ---------- views ---------- */

const FORMAT_LABEL = { li_post: 'LinkedIn', x_thread: 'X thread', blog: 'Blog', clip_spec: 'Clip spec' };
const TEMPLATE_LABEL = { freeform: 'Freeform', exec_brief: 'Executive brief', pyramid: 'Pyramid synthesis', data_drop: 'Data drop' };
const TIER_LABEL = { L0_compliance: 'compliance', L1_brand: 'brand rule', L2_channel: 'channel rule', L3_taste: 'taste' };
const STATE_LABEL = { draft: 'in edit', in_approval: 'awaiting approval', approved: 'approved', published: 'published', declined: 'declined' };
const STATE_CLASS = { draft: 'in-edit', in_approval: 'candidate', approved: 'approved', published: 'published', declined: 'rejected' };
const fmtLabel = (f) => FORMAT_LABEL[f] ?? f;
/** Plain-text preview for list rows: strip markdown headings/emphasis, collapse whitespace. */
const preview = (content, n = 76) => {
  const t = content.replace(/^#+\s*/gm, '').replace(/[*_`>]/g, '').replace(/\s+/g, ' ').trim();
  return t.slice(0, n) + (t.length > n ? '…' : '');
};

const REJECT_CHIPS = [
  ['not_our_pov', 'Not our POV'],
  ['too_generic', 'Too generic'],
  ['off_limits_source', 'Off-limits source'],
  ['wrong_speaker', 'Wrong speaker'],
  ['legal_risk', 'Legal risk'],
  ['already_said', 'Already said'],
];

const clampSel = (count) => {
  state.sel = Math.max(0, Math.min(state.sel, Math.max(0, count - 1)));
};

async function renderSlate(view, stale) {
  const moments = await api(`${state.ws}/slate?top=5`);
  if (stale()) return;
  clampSel(moments.length);
  setBudget(moments.length * 4);
  if (moments.length === 0) {
    view.innerHTML = `<div class="empty">The slate is clear.<div class="hint">Ingest a transcript and run Extract to mine new moments.</div></div>
      <div style="text-align:center"><button class="primary" id="extract-btn">Extract moments</button></div>`;
    $('#extract-btn', view)?.addEventListener('click', (e) =>
      busy(e.target, async () => {
        const created = await api(`${state.ws}/extract`, { method: 'POST' });
        toast(`${created.length} moment(s) extracted`);
        render();
      }),
    );
    return;
  }
  view.innerHTML = moments
    .map(
      (m, i) => `
    <article class="card ${i === state.sel ? 'selected' : ''}" data-idx="${i}" data-id="${esc(m.id)}" aria-current="${i === state.sel}">
      <p class="claim">${esc(m.claim)}</p>
      <p class="whynow">${esc(m.judgment.whyNow)}</p>
      <div class="meta-row">
        <span class="pill neutral">novelty ${(m.judgment.novelty * 100).toFixed(0)}</span>
        <span class="pill neutral">credibility ${(m.judgment.credibility * 100).toFixed(0)}</span>
        ${m.judgment.riskFlags.map((r) => `<span class="pill risk" title="${esc(r.note)}">⚠ ${esc(r.kind.replace(/_/g, ' '))}</span>`).join('')}
      </div>
      <div class="chip-row">${m.utterances.map(chipHtml).join('')}</div>
      <div class="card-actions">
        <button class="primary act-weave">Weave</button>
        <div class="chip-picker" role="group" aria-label="Reject with reason">
          <span class="picker-label">Reject —</span>
          ${REJECT_CHIPS.map(([k, label], n) => `<button data-chip="${k}"><kbd>${n + 1}</kbd>${label}</button>`).join('')}
        </div>
      </div>
    </article>`,
    )
    .join('');

  moments.forEach((m, i) => {
    const card = $(`[data-idx="${i}"]`, view);
    wireChips(card, m.utterances);
    $('.act-weave', card).addEventListener('click', (e) => weaveMoment(m.id));
    $$('.chip-picker button[data-chip]', card).forEach((b) =>
      b.addEventListener('click', () => rejectMoment(m.id, b.dataset.chip)),
    );
    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      state.sel = i;
      updateSelection(view);
    });
  });
}

function closeAllPickers(scope = document) {
  $$('.chip-picker.armed', scope).forEach((p) => p.classList.remove('armed'));
  state.rejecting = null;
}

/** Chips are always visible; 'x' ARMS the selected card's chips so keys 1-6 apply to it. */
function armPicker(view, card, momentId) {
  closeAllPickers(view); // only one card armed at a time
  const p = $('.chip-picker', card);
  if (p) {
    p.classList.add('armed');
    state.rejecting = momentId;
  }
}

async function rejectMoment(id, chip) {
  try {
    await api(`${state.ws}/moments/${id}/reject`, { method: 'POST', body: { chip } });
    state.rejecting = null;
    toast(`Rejected — ${chip.replace(/_/g, ' ')}. This feeds the distiller.`);
    // Remove just the card — no full re-render, no scroll jump, no replayed animations.
    const card = $(`.card[data-id="${CSS.escape(id)}"]`, $('#view'));
    if (card) {
      card.classList.add('leaving');
      setTimeout(() => {
        card.remove();
        updateSelection($('#view'));
        if ($$('.card', $('#view')).length === 0) render();
      }, 180);
    } else {
      render();
    }
  } catch (e) {
    toast(e.message, true);
  }
}

const WEAVE_FORMATS = [
  ['li_post', 'LinkedIn post'],
  ['blog', 'Blog post'],
  ['x_thread', 'X thread'],
  ['clip_spec', 'Clip spec'],
];

function openWeaveDialog(momentId) {
  const dlg = $('#weave-dialog');
  const templates = state.templates || [];
  dlg.querySelector('#weave-formats').innerHTML = WEAVE_FORMATS.map(
    ([k, label], i) => `<label class="choice"><input type="radio" name="wformat" value="${k}" ${i === 0 ? 'checked' : ''}/> ${label}</label>`,
  ).join('');
  dlg.querySelector('#weave-templates').innerHTML = templates
    .map(
      (t, i) => `<label class="template-choice">
        <input type="radio" name="wtemplate" value="${esc(t.id)}" ${i === 0 ? 'checked' : ''}/>
        <span class="template-choice-body">
          <span class="template-choice-name">${esc(t.name)}</span>
          <span class="template-choice-blurb">${esc(t.blurb)}</span>
          ${t.sections ? `<span class="template-choice-secs">${t.sections.map((s) => esc(s.title)).join(' · ')}</span>` : ''}
        </span>
      </label>`,
    )
    .join('');
  dlg.dataset.moment = momentId;
  dlg.showModal();
}

async function doWeave(momentId, format, template, btn) {
  await busy(btn, async () => {
    const draft = await api(`${state.ws}/moments/${momentId}/weave`, { method: 'POST', body: { format, template } });
    $('#weave-dialog').close();
    toast(`Draft woven — ${TEMPLATE_LABEL[template] ?? template}, ${FORMAT_LABEL[format] ?? format}`);
    switchView('drafts', { detail: { kind: 'draft', id: draft.id } });
  });
}

function weaveMoment(id) {
  openWeaveDialog(id);
}

async function renderDrafts(view, stale) {
  if (state.detail?.kind === 'draft') return renderDraftDetail(view, state.detail.id, stale);
  const drafts = await api(`${state.ws}/drafts`);
  if (stale()) return;
  // Finished (templated) drafts first; freeform/in-progress sink below.
  drafts.sort((a, b) => (a.template && a.template !== 'freeform' ? 0 : 1) - (b.template && b.template !== 'freeform' ? 0 : 1));
  clampSel(drafts.length);
  if (drafts.length === 0) {
    view.innerHTML = `<div class="empty">No drafts yet.<div class="hint">Weave a moment from the slate.</div></div>`;
    return;
  }
  view.innerHTML = drafts
    .map(
      (d, i) => `
    <button class="list-row ${i === state.sel ? 'selected' : ''}" data-idx="${i}" data-id="${esc(d.id)}">
      <span>
        <span class="title">${esc(preview(d.content))}</span><br/>
        <span class="sub">${esc(fmtLabel(d.format))}${d.template && d.template !== 'freeform' ? ` · ${esc(TEMPLATE_LABEL[d.template] ?? d.template)}` : ''}${d.figureCount ? ` · ▦ ${d.figureCount} figure${d.figureCount === 1 ? '' : 's'}` : ''}${d.holdout ? ' · holdout' : ''}</span>
      </span>
      <span class="pills">
        <span class="pill ${STATE_CLASS[d.state] ?? 'neutral'}">${esc(STATE_LABEL[d.state] ?? d.state)}</span>
        <span class="pill neutral">${d.editCount} edit${d.editCount === 1 ? '' : 's'}</span>
      </span>
    </button>`,
    )
    .join('');
  $$('.list-row', view).forEach((row, i) =>
    row.addEventListener('click', () => {
      state.sel = i;
      state.detail = { kind: 'draft', id: row.dataset.id };
      render();
    }),
  );
}

async function renderDraftDetail(view, id, stale) {
  const d = await api(`${state.ws}/drafts/${id}`);
  if (stale()) return;
  view.innerHTML = `
    <button class="backlink" id="back">← All drafts</button>
    <div class="meta-row">
      <span class="pill ${STATE_CLASS[d.state] ?? 'neutral'}">${esc(STATE_LABEL[d.state] ?? d.state)}</span>
      <span class="pill neutral">${esc(fmtLabel(d.format))}</span>
      <span class="pill neutral">rules v${d.constitutionVersion}</span>
      ${d.template && d.template !== 'freeform' ? `<span class="pill neutral">${esc(TEMPLATE_LABEL[d.template] ?? d.template)}</span>` : ''}
      ${d.holdout ? '<span class="pill shadow" title="Reserved for evaluation — never used as training signal">holdout</span>' : ''}
    </div>
    <div class="draft-content" id="draft-content">${(d.sections && d.sections.length) || (d.viz && d.viz.length) ? structuredDraftHtml(d) : esc(d.content)}</div>
    <div class="card-actions" style="margin-top:14px">
      <button class="primary" id="edit-btn">Edit this draft</button>
    </div>
    <div id="editor-zone" hidden>
      <div class="section-label">Your edit becomes policy</div>
      <textarea class="draft-editor" id="editor" aria-label="Edited draft">${esc(d.content)}</textarea>
      <fieldset class="reason-set">
        <legend class="ws-label">Reason</legend>
        ${['off-voice', 'off-strategy', 'risky', 'not-now', 'factual', 'style'].map((r) => `<label><input type="radio" name="reason" value="${r}"/> ${r}</label>`).join(' ')}
      </fieldset>
      <div class="card-actions">
        <button class="primary" id="save-edit">Capture edit</button>
        <button class="secondary" id="cancel-edit">Cancel</button>
      </div>
    </div>
    <div class="section-label">Receipts — every claim has a source</div>
    <div>${d.provenance.map((p) => `
      <div style="margin-bottom:10px">
        <div style="font-family:var(--serif);font-size:14px">“${esc(p.quote)}”</div>
        <div class="chip-row">${p.utteranceIds.map((uid) => { const u = d.utterances.find((x) => x.id === uid); return u ? chipHtml(u) : ''; }).join('')}</div>
      </div>`).join('') || '<p class="whynow">No grounded claim spans recorded for this draft.</p>'}
    </div>
    ${d.edits.length > 0 ? `<div class="section-label">Edit history</div>${d.edits.map((e) => `<div class="diff-title">${esc(e.id)} · ${esc(e.reasonChip ?? 'unspecified')}</div>${diffHtml(e.diff)}`).join('')}` : ''}
  `;
  wireChips(view, d.utterances);
  $('#back', view).addEventListener('click', () => { state.detail = null; render(); });
  $('#edit-btn', view).addEventListener('click', () => { $('#editor-zone', view).hidden = false; $('#edit-btn', view).hidden = true; $('#editor', view).focus(); });
  $('#cancel-edit', view).addEventListener('click', () => { $('#editor-zone', view).hidden = true; $('#edit-btn', view).hidden = false; });
  $('#save-edit', view).addEventListener('click', (ev) =>
    busy(ev.target.closest('button'), async () => {
      const reason = view.querySelector('input[name="reason"]:checked')?.value;
      const e = await api(`${state.ws}/drafts/${id}/edit`, {
        method: 'POST',
        body: { content: $('#editor', view).value, reason },
      });
      toast(`Edit ${e.id} captured — it feeds Friday's distillation`);
      render();
    }),
  );
}

async function renderConstitution(view, stale) {
  if (state.detail?.kind === 'principle') return renderPrincipleDetail(view, state.detail.id, stale);
  const principles = await api(`${state.ws}/constitution`);
  if (stale()) return;
  const distillBtn = `<div style="text-align:right;margin-bottom:14px"><button class="secondary" id="distill-btn">Distill new candidates from edits</button></div>`;
  if (principles.length === 0) {
    view.innerHTML = `${distillBtn}<div class="empty">The constitution is unwritten.<div class="hint">Capture a few edits on drafts, then distill.</div></div>`;
  } else {
    const order = { candidate: 0, shadow: 1, active: 2, decaying: 3, retired: 4, rejected: 5 };
    principles.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
    clampSel(principles.length);
    view.innerHTML =
      distillBtn +
      principles
        .map(
          (p, i) => `
      <article class="card ${i === state.sel ? 'selected' : ''}" data-idx="${i}" data-id="${esc(p.id)}">
        <div class="meta-row">
          <span class="pill ${esc(p.status)}">${esc(p.status)}</span>
          <span class="pill neutral">${esc(TIER_LABEL[p.tier] ?? p.tier)}</span>
          <span class="pill neutral">scope: ${esc(p.scope.channel ? fmtLabel(p.scope.channel) : 'all channels')}</span>
          ${p.blast ? `<span class="pill ${p.blast.radius > 0.1 ? 'risk' : 'active'}">blast ${(p.blast.radius * 100).toFixed(0)}%</span>` : ''}
        </div>
        <p class="principle-text">${esc(p.text)}</p>
        <p class="counterexample">Does not apply: ${p.counterexamples.map(esc).join(' · ')}</p>
        <div class="card-actions">
          <button class="secondary act-open">Review diffs</button>
          ${p.status === 'candidate' ? `<button class="primary act-ratify">Run counterfactuals</button>` : ''}
          ${p.status === 'shadow' ? `<button class="primary act-promote">Promote to active</button>` : ''}
          ${['candidate', 'shadow'].includes(p.status) ? `<button class="danger-link act-reject-p">Reject</button>` : ''}
        </div>
      </article>`,
        )
        .join('');

    principles.forEach((p, i) => {
      const card = $(`[data-idx="${i}"]`, view);
      $('.act-open', card).addEventListener('click', () => { state.detail = { kind: 'principle', id: p.id }; render(); });
      $('.act-ratify', card)?.addEventListener('click', (e) =>
        busy(e.target.closest('button'), async () => {
          const r = await api(`${state.ws}/principles/${p.id}/ratify`, { method: 'POST' });
          toast(`Counterfactuals run — blast radius ${(r.blast.radius * 100).toFixed(0)}%`);
          state.detail = { kind: 'principle', id: p.id };
          render();
        }),
      );
      $('.act-promote', card)?.addEventListener('click', (e) =>
        busy(e.target.closest('button'), async () => {
          await api(`${state.ws}/principles/${p.id}/promote`, { method: 'POST' });
          toast(`${p.id} is now active`);
          render();
        }),
      );
      $('.act-reject-p', card)?.addEventListener('click', async () => {
        try {
          await api(`${state.ws}/principles/${p.id}/reject`, { method: 'POST' });
          toast(`${p.id} rejected`);
          render();
        } catch (e) {
          toast(e.message, true);
        }
      });
    });
  }
  $('#distill-btn', view)?.addEventListener('click', (e) =>
    busy(e.target.closest('button'), async () => {
      const created = await api(`${state.ws}/distill`, { method: 'POST' });
      toast(created.length > 0 ? `${created.length} candidate principle(s) proposed` : 'No durable patterns yet — capture more edits');
      render();
    }),
  );
}

async function renderPrincipleDetail(view, id, stale) {
  const [principles, report, allDrafts] = await Promise.all([
    api(`${state.ws}/constitution`),
    api(`${state.ws}/principles/${id}/report`),
    api(`${state.ws}/drafts`),
  ]);
  const draftLabel = (draftId) => {
    const d = allDrafts.find((x) => x.id === draftId);
    return d ? `${fmtLabel(d.format)} — “${d.content.slice(0, 56).replace(/\s+/g, ' ')}…”` : draftId;
  };
  if (stale()) return;
  const p = principles.find((x) => x.id === id);
  if (!p) { state.detail = null; return render(); }
  const b = report.blast;
  const total = b.inScopeTotal + b.outOfScopeTotal;
  const changed = report.results.filter((r) => r.changed);
  const blocked = total === 0 || b.radius > 0.1; // the gate is visible in the control, not discovered via toast

  view.innerHTML = `
    <button class="backlink" id="back">← Constitution</button>
    <div class="meta-row"><span class="pill ${esc(p.status)}">${esc(p.status)}</span><span class="pill neutral">${esc(TIER_LABEL[p.tier] ?? p.tier)}</span><span class="pill neutral">scope: ${esc(p.scope.channel ? fmtLabel(p.scope.channel) : 'all channels')}</span></div>
    <p class="principle-text" style="font-size:19px">${esc(p.text)}</p>
    <p class="counterexample">Does not apply: ${p.counterexamples.map(esc).join(' · ')}</p>

    <div class="section-label">Ratify behavior, not prose</div>
    ${total === 0
      ? `<div class="empty">No counterfactual run yet.<div class="hint">Run Ratify to see what this principle would have changed.</div></div>
         <div style="text-align:center"><button class="primary" id="ratify-btn">Run counterfactuals</button></div>`
      : `
    <div class="blast">
      <div><div class="num">${b.inScopeChanged}/${b.inScopeTotal}</div><div class="lbl">in scope changed</div></div>
      <div class="${b.outOfScopeChanged > 0 ? 'bad' : 'ok'}"><div class="num">${b.outOfScopeChanged}/${b.outOfScopeTotal}</div><div class="lbl">out of scope changed</div></div>
      <div class="${b.radius > 0.1 ? 'bad' : 'ok'}"><div class="num">${(b.radius * 100).toFixed(0)}%</div><div class="lbl">blast radius</div></div>
    </div>
    <div class="blast-verdict ${b.radius > 0.1 ? 'bad' : 'ok'}">
      ${b.radius > 0.1
        ? '⛔ Blast radius exceeds 10% — acceptance is blocked. Narrow the scope or reject.'
        : '✓ Within tolerance. Accepting sends this principle to shadow for a week of observation.'}
    </div>
    ${changed.map((r) => `<div class="diff-title ${r.inScope ? '' : 'bleed'}">${esc(draftLabel(r.draftId))} ${r.inScope ? '' : '⚠ OUT OF SCOPE — this is scope bleed'}</div>${diffHtml(r.diff)}`).join('') || '<p class="whynow">No drafts changed under this principle.</p>'}
    `}
    <div class="card-actions" style="margin-top:16px">
      ${p.status === 'candidate' && total > 0
        ? `<button class="primary" id="accept-btn" ${blocked ? 'disabled aria-disabled="true" title="Blocked: blast radius must be ≤10%"' : ''}>Accept → shadow</button>`
        : ''}
      ${p.status === 'shadow' ? `<button class="primary" id="promote-btn">Promote to active</button>` : ''}
      ${['candidate', 'shadow'].includes(p.status) ? `<button class="danger-link" id="reject-btn">Reject</button>` : ''}
    </div>
  `;
  $('#back', view).addEventListener('click', () => { state.detail = null; render(); });
  $('#ratify-btn', view)?.addEventListener('click', (e) =>
    busy(e.target.closest('button'), async () => {
      const r = await api(`${state.ws}/principles/${id}/ratify`, { method: 'POST' });
      toast(`Counterfactuals run — blast radius ${(r.blast.radius * 100).toFixed(0)}%`);
      render();
    }),
  );
  $('#accept-btn', view)?.addEventListener('click', (e) =>
    busy(e.target.closest('button'), async () => {
      await api(`${state.ws}/principles/${id}/accept`, { method: 'POST' });
      toast('Accepted → shadow. It annotates without steering until promoted.');
      render();
    }),
  );
  $('#promote-btn', view)?.addEventListener('click', (e) =>
    busy(e.target.closest('button'), async () => {
      await api(`${state.ws}/principles/${id}/promote`, { method: 'POST' });
      toast('Promoted to active.');
      render();
    }),
  );
  $('#reject-btn', view)?.addEventListener('click', async () => {
    try {
      await api(`${state.ws}/principles/${id}/reject`, { method: 'POST' });
      state.detail = null;
      toast('Rejected.');
      render();
    } catch (e) {
      toast(e.message, true);
    }
  });
}

async function renderGate(view, stale) {
  const metrics = await api(`${state.ws}/gate`);
  if (stale()) return;
  view.innerHTML = `
    <table class="gate-table">
      <thead><tr><th scope="col"><span class="visually-hidden">Status</span></th><th scope="col">Metric</th><th scope="col">Value</th><th scope="col">Threshold</th></tr></thead>
      <tbody>
        ${metrics.map((m) => `
          <tr>
            <td class="status-dot" aria-label="${m.status}">${m.status === 'PASS' ? '✅' : m.status === 'FAIL' ? '❌' : '⬜'}</td>
            <td class="metric">${esc(m.name)}</td>
            <td class="value">${esc(m.value)}</td>
            <td class="threshold">${esc(m.threshold)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    <p class="whynow" style="margin-top:14px">⬜ not yet measurable. The gate decision (SYNTHESIS.md §4) needs every metric measured; blind exec preference and cross-client isolation are verified with the design partner.</p>
  `;
}

/* ---------- shell ---------- */

const VIEWS = {
  slate: { title: 'Slate', render: renderSlate },
  drafts: { title: 'Drafts', render: renderDrafts },
  constitution: { title: 'Constitution', render: renderConstitution },
  gate: { title: 'Phase 0 gate', render: renderGate },
};

function setBudget(minutes) {
  state.budgetMinutes = minutes;
  $('#budget-label').textContent = `~${minutes} min of review today`;
  $('#budget-fill').style.width = `${Math.min(100, (minutes / 45) * 100)}%`;
}

function updateSelection(view) {
  const items = $$('.card, .list-row', view);
  clampSel(items.length);
  items.forEach((el, i) => {
    el.classList.toggle('selected', i === state.sel);
    if (el.classList.contains('card')) el.setAttribute('aria-current', String(i === state.sel));
  });
}

let renderSeq = 0; // sequence guard: a superseded render never touches the DOM
async function render() {
  const seq = ++renderSeq;
  const stale = () => seq !== renderSeq;
  state.rejecting = null; // any re-render invalidates the picker DOM it referred to
  const def = VIEWS[state.view];
  $('#view-title').textContent = def.title;
  $$('.rail-item').forEach((b) => {
    if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  const view = $('#view');
  view.classList.toggle('no-anim', !state.animate);
  state.animate = false;
  view.setAttribute('aria-busy', 'true');
  view.innerHTML = '<span class="visually-hidden">Loading</span>' +
    '<div class="skeleton" aria-hidden="true"><div class="bone w85"></div><div class="bone w60"></div><div class="bone w40"></div></div>'.repeat(3);
  try {
    await def.render(view, stale);
  } catch (e) {
    if (!stale()) view.innerHTML = `<div class="empty">Something went wrong.<div class="hint">${esc(e.message)}</div></div>`;
  }
  if (!stale()) view.removeAttribute('aria-busy');
}

function switchView(name, opts = {}) {
  state.view = name;
  state.sel = 0;
  state.detail = opts.detail ?? null;
  state.rejecting = null;
  state.animate = true;
  render();
}

/* ---------- keyboard grammar ---------- */

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select') || $('#help').open || $('#weave-dialog').open) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  // reject-reason picker: 1-6 pick a chip (armed only while a picker is open)
  if (state.rejecting && /^[1-6]$/.test(e.key)) {
    const chip = REJECT_CHIPS[Number(e.key) - 1]?.[0];
    if (chip) rejectMoment(state.rejecting, chip);
    return;
  }

  const viewKeys = { 1: 'slate', 2: 'drafts', 3: 'constitution', 4: 'gate' };
  if (viewKeys[e.key]) return switchView(viewKeys[e.key]);

  const view = $('#view');
  const items = $$('.card, .list-row', view);
  clampSel(items.length);
  const current = items[state.sel];

  switch (e.key) {
    case 'j':
      if (items.length === 0) break;
      state.sel = Math.min(items.length - 1, state.sel + 1);
      updateSelection(view);
      items[state.sel]?.scrollIntoView({ block: 'nearest' });
      break;
    case 'k':
      if (items.length === 0) break;
      state.sel = Math.max(0, state.sel - 1);
      updateSelection(view);
      items[state.sel]?.scrollIntoView({ block: 'nearest' });
      break;
    case 'Enter': {
      if (e.target.closest('button, a')) return; // native activation wins — never double-fire
      e.preventDefault();
      const open = current?.querySelector('.act-open');
      (open ?? current)?.click();
      break;
    }
    case 'w':
      current?.querySelector('.act-weave')?.click();
      break;
    case 'x': {
      const id = current?.dataset.id;
      if (id && current.querySelector('.chip-picker')) armPicker(view, current, id);
      break;
    }
    case '.':
      current?.querySelector('.chip')?.click();
      break;
    case 'Escape':
      if (state.rejecting) { closeAllPickers(view); break; } // cancel rejection first
      if (state.detail) { state.detail = null; render(); }
      break;
    case '?':
      $('#help').showModal();
      break;
  }
});

/* ---------- boot ---------- */

$$('.rail-item').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

$('#help-btn').addEventListener('click', () => $('#help').showModal());

$('#theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme;
  const next = cur === 'dark' ? 'light' : cur === 'light' ? 'dark' : matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('nf.theme', next);
  $('#theme-toggle').setAttribute('aria-pressed', String(next === 'dark'));
});
if (localStorage.getItem('nf.theme')) document.documentElement.dataset.theme = localStorage.getItem('nf.theme');

$('#ws-select').addEventListener('change', (e) => {
  state.ws = e.target.value;
  localStorage.setItem('nf.ws', state.ws);
  switchView(state.view);
});

// Weave dialog wiring
$('#weave-cancel').addEventListener('click', () => $('#weave-dialog').close());
$('#weave-go').addEventListener('click', (e) => {
  const dlg = $('#weave-dialog');
  const format = dlg.querySelector('input[name="wformat"]:checked')?.value || 'li_post';
  const template = dlg.querySelector('input[name="wtemplate"]:checked')?.value || 'freeform';
  const momentId = dlg.dataset.moment;
  doWeave(momentId, format, template, e.target.closest('button'));
});

(async function boot() {
  let workspaces;
  try {
    workspaces = await api('workspaces');
    state.templates = await api('templates').catch(() => []);
  } catch (e) {
    $('#view').innerHTML = `<div class="empty">Can't reach the workbench server.<div class="hint">${esc(e.message)} — is <code>npm run ui</code> running?</div></div>`;
    return;
  }
  const sel = $('#ws-select');
  if (workspaces.length === 0) {
    $('#view').innerHTML = `<div class="empty">No workspaces yet.<div class="hint">Create one: <code>npm run nf -- --workspace demo init</code> then ingest a transcript.</div></div>`;
    return;
  }
  sel.innerHTML = workspaces.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('');
  if (!state.ws || !workspaces.some((w) => w.id === state.ws)) state.ws = workspaces[0].id;
  sel.value = state.ws;
  render();
})();
