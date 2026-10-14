import { mountViewer } from './viewer.js';

const $ = (sel, root = document) => root.querySelector(sel);
const h = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids.flat().filter(k => k != null)); return n; };

const AGENT_STAGES = new Set(['research', 'design', 'review']);
const STATUS_TEXT = {
  'awaiting-capture': 'waiting for capture', 'needs-you': 'needs you', 'awaiting-approval': 'ready for approval',
  approved: 'approved', rejected: 'rejected',
};

let current = null;      // run id
let stream = null;
let viewers = [];
let lastRender = '';

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body && JSON.stringify(opts.body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || res.statusText);
  return out;
}

// ---------- header ----------

async function loadStatus() {
  const s = await api('/api/status');
  const chips = [
    h('span', { className: `chip ${s.billing.safe ? 'ok' : 'err'}`, textContent: s.billing.safe ? 'Billing: Pro plan' : 'Billing: unsafe', title: s.billing.warnings.join(' ') }),
    h('span', { className: `chip ${s.corpus.relevant ? 'ok' : 'warn'}`, textContent: `Research: ${s.corpus.relevant} sources`, title: `${s.corpus.total} items, ${s.corpus.extracted} extracted` }),
    h('span', { className: 'chip', textContent: `Device library: ${s.library.length}`, title: s.library.join(', ') }),
    h('span', { className: `chip ${s.lan ? 'ok' : 'warn'}`, textContent: s.lan ? `Wi-Fi: ${s.lan}` : 'Wi-Fi: off' }),
  ];
  $('#sysline').replaceChildren(...chips);
  window.__vault = s.vault;
}

// ---------- run list ----------

async function loadRuns() {
  const runs = await api('/api/runs');
  $('#runList').replaceChildren(...runs.map(r => {
    const li = h('li', { className: r.id === current ? 'sel' : '' },
      h('b', { textContent: `${r.person} · ${r.side}` }),
      h('small', { textContent: `${STATUS_TEXT[r.status] || r.status.replace(':', ': ')}${r.flags ? ` · ${r.flags} flag${r.flags > 1 ? 's' : ''}` : ''}` }),
      h('small', { textContent: `${r.goal || 'no goal given'} · ${r.createdAt.slice(0, 10)}` }),
    );
    li.onclick = () => select(r.id);
    return li;
  }));
}

$('#newRun').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const run = await api('/api/runs', { method: 'POST', body: Object.fromEntries(f) });
    e.target.reset();
    await select(run.id);
  } catch (err) { alert(err.message); }
});

// ---------- one run ----------

async function select(id) {
  current = id;
  location.hash = id;
  lastRender = '';
  stream?.close();
  await refresh();
  const log = $('[data-f=log]');
  if (log) log.replaceChildren();
  stream = new EventSource(`/api/runs/${id}/stream`);
  let pending = null;
  stream.onmessage = m => {
    const ev = JSON.parse(m.data);
    appendLog(ev);
    // Coalesce bursts of events into one refresh.
    if (['stage', 'status', 'flags', 'profile', 'archived', 'decision'].includes(ev.type)) {
      clearTimeout(pending);
      pending = setTimeout(refresh, 250);
    }
  };
  loadRuns();
}

async function refresh() {
  if (!current) return;
  let run;
  try { run = await api(`/api/runs/${current}`); }
  catch { current = null; $('#detail').replaceChildren(h('div', { className: 'empty', textContent: 'That run no longer exists.' })); return; }
  render(run);
  loadRuns();
}

function f(root, name) { return root.querySelector(`[data-f=${name}]`); }

function render(run) {
  const root = $('#detail');
  // Rebuild the designs only when they change, so 3D views don't reset on every event.
  const key = JSON.stringify([run.design, run.built, run.review?.designs, run.approval]);
  const rebuildDesigns = key !== lastRender;
  lastRender = key;

  let view = root.querySelector('.run-view');
  if (!view || view.dataset.id !== run.id) {
    view = h('div', { className: 'run-view' });
    view.dataset.id = run.id;
    view.style.display = 'grid'; view.style.gap = '16px';
    view.append($('#tplRun').content.cloneNode(true));
    root.replaceChildren(view);
    wire(view);
  }

  f(view, 'title').textContent = `${run.person} · ${run.side} hand`;
  f(view, 'goal').textContent = run.goal ? `Goal: ${run.goal}${run.notes ? ` — ${run.notes}` : ''}` : (run.notes || 'No goal given.');
  const pill = f(view, 'status');
  pill.textContent = run.busy && run.status.startsWith('running') ? `running ${run.status.split(':')[1]}` : STATUS_TEXT[run.status] || run.status;
  pill.className = `pill ${run.status.startsWith('running') ? 'running' : run.status}`;

  // stages
  f(view, 'stages').replaceChildren(...Object.entries(run.stages).map(([name, s]) => {
    const secs = s.startedAt && s.endedAt ? `${Math.round((s.endedAt - s.startedAt) / 1000)}s` : '';
    return h('li', { className: `${s.status} ${AGENT_STAGES.has(name) ? 'agent' : ''}`, title: s.error || '' },
      h('b', { textContent: name }), h('small', { textContent: `${s.status}${secs ? ` · ${secs}` : ''}` }));
  }));

  // capture
  const cap = f(view, 'capture');
  cap.hidden = !run.captureLinks;
  if (!cap.hidden) {
    const link = run.captureLinks.wifi || run.captureLinks.local;
    f(view, 'wifi').href = link; f(view, 'wifi').textContent = link;
    f(view, 'local').href = run.captureLinks.local;
    const qr = f(view, 'qr');
    if (qr.dataset.link !== link && window.QRCode) {
      qr.replaceChildren();
      new QRCode(qr, { text: link, width: 168, height: 168, correctLevel: QRCode.CorrectLevel.M });
      qr.dataset.link = link;
    }
  }

  // flags
  const flags = run.flags.filter(x => x.severity !== 'info' || x.source === 'supervisor');
  const info = run.flags.filter(x => x.severity === 'info' && x.source !== 'supervisor');
  f(view, 'attention').hidden = !run.flags.length;
  f(view, 'attnTitle').textContent = run.status === 'needs-you' ? 'Needs your attention' : `Flags (${run.flags.length})`;
  f(view, 'attention').classList.toggle('urgent', run.status === 'needs-you');
  const best = f(view, 'best');
  best.hidden = !run.review?.bestPath;
  best.textContent = run.review?.bestPath ? `Supervisor's suggested next step: ${run.review.bestPath}` : '';
  f(view, 'flags').replaceChildren(...[...flags, ...info].map(fl => h('li', { className: fl.severity },
    h('div', {}, h('span', { className: 'sev', textContent: `${fl.severity} · ${fl.stage} · ${fl.source || ''}` }), fl.issue),
    fl.evidence ? h('div', { className: 'sugg', textContent: `Evidence: ${fl.evidence}` }) : null,
    h('div', { className: 'sugg', textContent: `→ ${fl.suggestion}` }),
    optionButtons(run, fl),
  )));

  // designs
  const design = run.design;
  f(view, 'designsWrap').hidden = !design;
  f(view, 'feedbackWrap').hidden = !design && run.stages.research.status !== 'failed';
  f(view, 'recapture').hidden = !!run.captureLinks;
  if (design && rebuildDesigns) {
    f(view, 'designSummary').textContent = design.summary || '';
    viewers.forEach(v => v.dispose?.()); viewers = [];
    f(view, 'designs').replaceChildren(...design.designs.map(d => designCard(run, d)));
  }
  const approvable = run.status === 'awaiting-approval' || run.status === 'approved' || run.status === 'rejected';
  f(view, 'approve').querySelectorAll('button').forEach(b => { b.disabled = !approvable || run.busy; });
  f(view, 'decided').textContent = run.approval
    ? `${run.approval.status} ${new Date(run.approval.at).toLocaleString()}${run.approval.note ? ` — ${run.approval.note}` : ''}. Logged in the vault.`
    : approvable ? '' : 'Approval opens once the Supervisor has reviewed the designs.';

  // research
  const r = run.research;
  f(view, 'researchWrap').hidden = !r;
  if (r) f(view, 'research').replaceChildren(
    h('h3', { textContent: 'Needs' }), h('ul', {}, r.needs.map(n => h('li', { textContent: n }))),
    h('h3', { textContent: 'Principles' }), h('ul', { className: 'principles' }, r.principles.map(p => h('li', {},
      h('b', { textContent: p.principle }), ` — ${p.why} `, h('span', { className: 'muted small', textContent: p.sources.length ? `[${p.sources.join(', ')}]` : '[own reasoning]' })))),
    h('h3', { textContent: 'Device ideas' }), h('ul', {}, r.deviceIdeas.map(i => h('li', {}, h('b', { textContent: i.name }), ` — ${i.rationale}`))),
    h('h3', { textContent: 'Sources used' }), h('ul', {}, r.references.map(s => h('li', {},
      h('a', { href: s.url, target: '_blank', textContent: s.title }), h('span', { className: 'muted small', textContent: ` · ${s.license} · ${s.use}` })))),
    r.gaps.length ? h('h3', { textContent: 'Gaps' }) : null, h('ul', {}, r.gaps.map(g => h('li', { textContent: g }))),
  );

  // usage
  f(view, 'usage').replaceChildren(...Object.entries(run.usage || {}).map(([agent, u]) => h('tr', {},
    h('td', { textContent: agent }), h('td', { className: 'num', textContent: u.calls }),
    h('td', { className: 'num', textContent: u.fresh.toLocaleString() }), h('td', { className: 'num', textContent: u.cacheRead.toLocaleString() }),
    h('td', { className: 'num', textContent: `${Math.round(u.durationMs / 1000)}s` }))));

  f(view, 'vault').textContent = run.vaultNotes?.length ? `Logged to ${window.__vault}` : '';
}

function optionButtons(run, fl) {
  const wrap = h('div', { className: 'opts' });
  for (const opt of fl.options || []) {
    const m = opt.match(/^(Retry|Skip) (\w+)$/i);
    if (!m) continue;
    const stage = m[2].toLowerCase();
    const b = h('button', { textContent: opt, disabled: run.busy });
    b.onclick = () => act(m[1].toLowerCase(), { stage });
    wrap.append(b);
  }
  return wrap.childElementCount ? wrap : null;
}

function designCard(run, d) {
  const b = (run.built || []).find(x => x.id === d.id) || {};
  const v = run.review?.designs?.find(x => x.id === d.id);
  const chosen = run.approval?.designs?.includes(d.id) ?? (v?.verdict !== 'drop');
  const viewer = h('div', { className: 'viewer' });
  const card = h('article', { className: `design ${b.ok === false ? 'bad' : ''}` },
    viewer,
    h('div', { className: 'design-body' },
      h('div', { className: 'design-top' },
        h('h3', { textContent: d.name }),
        h('div', { className: 'tags' },
          h('span', { className: `tag ${d.kind}`, textContent: d.kind === 'new' ? 'new type' : 'built-in' }),
          h('span', { className: 'tag', textContent: `${d.confidence} confidence` }),
          v ? h('span', { className: `tag ${v.verdict}`, textContent: `supervisor: ${v.verdict}` }) : null)),
      h('p', { className: 'purpose', textContent: d.purpose }),
      b.report ? h('p', { className: 'muted small', textContent: `Prints at ${b.report.sizeMm.join(' × ')} mm · ${b.report.volumeCm3} cm³` }) : null,
      h('table', {}, h('thead', {}, h('tr', {}, h('th', { textContent: 'Size' }), h('th', { textContent: 'Value' }), h('th', { textContent: 'Why' }))),
        h('tbody', {}, Object.entries(d.params).map(([k, val]) => h('tr', {},
          h('td', { textContent: k }), h('td', { className: 'num', textContent: `${val} ${d.units?.[k] || ''}` }), h('td', { textContent: d.why?.[k] || '' }))))),
      d.sources?.length ? h('div', {}, h('b', { className: 'small', textContent: 'Sources' }),
        h('ul', {}, d.sources.map(s => h('li', { textContent: `${s.use}: ${s.id} — ${s.how}` })))) : h('p', { className: 'muted small', textContent: 'No sources: Designer\'s own reasoning.' }),
      d.risks?.length ? h('div', {}, h('b', { className: 'small', textContent: 'Risks' }), h('ul', {}, d.risks.map(r => h('li', { textContent: r })))) : null,
      d.printing ? h('p', { className: 'muted small', textContent: `Print: ${[d.printing.material, d.printing.infill, d.printing.orientation].filter(Boolean).join(' · ')}${d.printing.notes ? `. ${d.printing.notes}` : ''}` }) : null,
      v ? h('div', { className: 'verdict', textContent: v.note }) : null,
      h('div', { className: 'design-files' },
        b.ok ? h('a', { href: `/runs/${run.id}/out/${d.id}.stl`, download: `${run.person}-${d.id}.stl`, textContent: 'Download STL' }) : null,
        d.kind === 'new' ? h('a', { href: `/runs/${run.id}/${d.device}`, target: '_blank', textContent: 'Device code' }) : null),
      h('label', { className: 'pick' }, h('input', { type: 'checkbox', checked: chosen, value: d.id, className: 'choose' }), 'Approve this design'),
    ));
  if (b.ok) {
    // Only build 3D views when the card scrolls into view: each one is a WebGL context.
    const io = new IntersectionObserver(async entries => {
      if (!entries.some(e => e.isIntersecting)) return;
      io.disconnect();
      try { viewers.push(await mountViewer(viewer, `/runs/${run.id}/${b.stl}`)); viewer.append(h('span', { className: 'hint', textContent: 'drag to turn' })); }
      catch (err) { viewer.replaceChildren(h('div', { className: 'fail', textContent: `3D view failed: ${err.message}` })); }
    });
    io.observe(viewer);
  } else {
    viewer.replaceChildren(h('div', { className: 'fail', textContent: b.error ? `Did not build: ${b.error}` : 'Not built yet.' }));
  }
  return card;
}

function wire(view) {
  view.addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const a = btn.dataset.act;
    if (a === 'approve' || a === 'reject') {
      const designs = [...view.querySelectorAll('.choose:checked')].map(c => c.value);
      if (a === 'approve' && !designs.length) return alert('Tick at least one design to approve.');
      await act('decide', { status: a === 'approve' ? 'approved' : 'rejected', designs, note: f(view, 'decisionNote').value });
    } else if (a === 'retry') {
      await act('retry', { stage: f(view, 'retryStage').value, note: f(view, 'retryNote').value });
      f(view, 'retryNote').value = '';
    } else if (a === 'recapture') {
      await act('recapture', {});
    } else if (a === 'delete') {
      if (!confirm('Delete this run and its files? Notes already in the vault stay.')) return;
      await api(`/api/runs/${current}`, { method: 'DELETE' });
      current = null; location.hash = '';
      $('#detail').replaceChildren(h('div', { className: 'empty', textContent: 'Run deleted.' }));
      loadRuns();
    }
  });
  f(view, 'upload').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try { await api(`/api/runs/${current}/profile`, { method: 'POST', body: JSON.parse(await file.text()) }); refresh(); }
    catch (err) { alert(`Could not use that profile: ${err.message}`); }
  });
}

async function act(action, body) {
  try { await api(`/api/runs/${current}/${action}`, { method: 'POST', body }); }
  catch (err) { alert(err.message); }
  setTimeout(refresh, 200);
}

// ---------- activity log ----------

function appendLog(ev) {
  const log = $('[data-f=log]');
  if (!log) return;
  const t = new Date(ev.t).toLocaleTimeString();
  let text;
  switch (ev.type) {
    case 'stage': text = [`stage`, `${ev.stage} ${ev.status}${ev.error ? `: ${ev.error}` : ''}`]; break;
    case 'status': text = ['status', ev.status]; break;
    case 'text': text = [ev.agent, ev.text.slice(0, 600)]; break;
    case 'tool': text = [ev.agent, `${ev.name} ${ev.input}`]; break;
    case 'denied': text = [ev.agent, `blocked ${ev.tool}: ${ev.message}`]; break;
    case 'budget': text = ['budget', ev.warning]; break;
    case 'flags': text = ['flags', ev.flags.map(x => `${x.severity}: ${x.issue}`).join('\n')]; break;
    case 'profile': text = ['capture', `profile received (${ev.side} hand, ${ev.scale} scale)`]; break;
    case 'archived': text = ['archivist', `wrote ${ev.notes.length} notes`]; break;
    case 'decision': text = ['you', `${ev.status}${ev.promoted?.length ? `; added ${ev.promoted.join(', ')} to the device library` : ''}`]; break;
    case 'retry': text = ['you', `redo ${ev.stage}${ev.note ? `: ${ev.note}` : ''}`]; break;
    default: return;
  }
  log.append(h('li', {}, `${t} `, h('b', { textContent: text[0] }), ` ${text[1]}`));
  log.scrollTop = log.scrollHeight;
}

// ---------- start ----------

loadStatus().catch(() => {});
loadRuns().then(() => { if (location.hash.length > 1) select(location.hash.slice(1)); });
setInterval(loadStatus, 60_000);
