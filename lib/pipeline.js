// Orchestrator. Plain code: the order of the stages never changes, so a model
// deciding it would only cost tokens and add ways to go wrong. AI is used only
// where judgment is needed: Researcher, Designer, Supervisor.
//
//   capture → research → design → build → render → review → archive → (you approve)
//
// Every stage writes its output to the run's folder, so any stage can be
// retried on its own and every file can be inspected.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync, copyFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { ROOT, RUNS, CORPUS, DEVICES, FITTED } from './paths.js';
import { runAgent } from './agent.js';
import { baseline as baselineSizes, BUILTINS } from './devices.js';
import { buildRun } from './build.js';
import { renderStl, canRender } from './render.js';
import { checkProfile, checkBuilt, checkSources } from './checks.js';
import { catalogue, loadIndex } from './corpus.js';
import { forRun, totals } from './budget.js';
import { archive, deviceNote } from './archivist.js';

export const STAGES = ['capture', 'research', 'design', 'build', 'render', 'review', 'archive'];
const AGENT_STAGES = { research: 'researcher', design: 'designer', review: 'supervisor' };

const readJson = (f, fallback = null) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v, null, 2));

// ---------- output schemas ----------

const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    needs: { type: 'array', items: { type: 'string' } },
    principles: { type: 'array', items: { type: 'object', properties: {
      principle: { type: 'string' }, why: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } },
    }, required: ['principle', 'why', 'sources'] } },
    references: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' }, license: { type: 'string' },
      use: { type: 'string', enum: ['adapt', 'cite'] }, relevance: { type: 'string' },
    }, required: ['id', 'title', 'use', 'license', 'relevance'] } },
    deviceIdeas: { type: 'array', items: { type: 'object', properties: {
      name: { type: 'string' }, rationale: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } },
    }, required: ['name', 'rationale', 'sources'] } },
    gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['needs', 'principles', 'references', 'deviceIdeas', 'gaps'],
};

const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    designs: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', properties: {
      id: { type: 'string', pattern: '^[a-z0-9-]{2,40}$' },
      name: { type: 'string' },
      kind: { type: 'string', enum: ['builtin', 'new'] },
      device: { type: 'string', description: 'built-in name, or devices/<id>.mjs for a new type' },
      purpose: { type: 'string' },
      params: { type: 'array', items: { type: 'object', properties: {
        name: { type: 'string' }, value: { type: 'number' }, unit: { type: 'string' }, why: { type: 'string' },
      }, required: ['name', 'value', 'unit', 'why'] } },
      sources: { type: 'array', items: { type: 'object', properties: {
        id: { type: 'string' }, use: { type: 'string', enum: ['adapt', 'cite'] }, how: { type: 'string' },
      }, required: ['id', 'use', 'how'] } },
      printing: { type: 'object', properties: {
        material: { type: 'string' }, infill: { type: 'string' }, orientation: { type: 'string' }, notes: { type: 'string' },
      } },
      risks: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    }, required: ['id', 'name', 'kind', 'device', 'purpose', 'params', 'sources', 'risks', 'confidence'] } },
  },
  required: ['summary', 'designs'],
};

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['ready-for-you', 'concerns', 'stop'] },
    summary: { type: 'string' },
    flags: { type: 'array', items: { type: 'object', properties: {
      severity: { type: 'string', enum: ['info', 'warn', 'stop'] },
      stage: { type: 'string' }, issue: { type: 'string' }, evidence: { type: 'string' },
      suggestion: { type: 'string' }, options: { type: 'array', items: { type: 'string' } },
    }, required: ['severity', 'stage', 'issue', 'suggestion'] } },
    designs: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, verdict: { type: 'string', enum: ['good', 'fix', 'drop'] }, note: { type: 'string' },
    }, required: ['id', 'verdict', 'note'] } },
    bestPath: { type: 'string', description: 'the single next step with least resistance' },
  },
  required: ['verdict', 'summary', 'flags', 'designs', 'bestPath'],
};

// ---------- run ----------

export class Run {
  static create({ person, side = 'right', goal = '', notes = '' }) {
    const run = new Run();
    run.id = randomBytes(4).toString('hex');
    // The capture link carries this token; anyone on the Wi-Fi with it can send one profile.
    run.captureToken = randomBytes(12).toString('hex');
    Object.assign(run, { person: person.trim(), side, goal: goal.trim(), notes: notes.trim() });
    run.createdAt = new Date().toISOString();
    run.status = 'awaiting-capture';
    run.stages = Object.fromEntries(STAGES.map(s => [s, { status: 'pending' }]));
    run.stages.capture.status = 'waiting';
    run.flags = [];
    run.feedback = [];
    run.approval = null;
    run.init();
    run.save();
    run.emit({ type: 'status', status: run.status });
    return run;
  }

  static load(dir) {
    const saved = readJson(join(dir, 'run.json'));
    if (!saved) return null;
    const run = Object.assign(new Run(), saved);
    run.init();
    // A stage running when the server stopped cannot be resumed.
    for (const [name, s] of Object.entries(run.stages)) {
      if (s.status === 'running') {
        s.status = 'failed'; s.error = 'the server restarted while this stage was running';
        run.flags.push({ severity: 'warn', stage: name, issue: `The ${name} stage was interrupted by a restart.`, suggestion: `Retry ${name}.`, options: [`Retry ${name}`], source: 'orchestrator' });
        run.status = 'needs-you';
      }
    }
    run.save();
    return run;
  }

  static loadAll() {
    mkdirSync(RUNS, { recursive: true });
    return readdirSync(RUNS).map(d => Run.load(join(RUNS, d))).filter(Boolean);
  }

  init() {
    this.dir = join(RUNS, this.id);
    mkdirSync(join(this.dir, 'out'), { recursive: true });
    this.subscribers = new Set();
    this.events = [];
    const log = join(this.dir, 'events.jsonl');
    if (existsSync(log)) this.events = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    this.busy = false;
  }

  save() {
    const { subscribers, events, busy, ...data } = this;
    writeJson(join(this.dir, 'run.json'), data);
  }

  emit(ev) {
    const e = { t: Date.now(), ...ev };
    this.events.push(e);
    try { appendFileSync(join(this.dir, 'events.jsonl'), JSON.stringify(e) + '\n'); } catch {}
    for (const fn of this.subscribers) { try { fn(e); } catch {} }
  }

  subscribe(fn) { this.subscribers.add(fn); return () => this.subscribers.delete(fn); }

  get profile() { return readJson(join(this.dir, 'profile.json')); }

  snapshot() {
    const { subscribers, events, busy, dir, captureToken, ...data } = this;
    return {
      ...data,
      profile: this.profile,
      research: readJson(join(this.dir, 'research.json')),
      design: readJson(join(this.dir, 'design.json')),
      built: readJson(join(this.dir, 'built.json'), []),
      review: readJson(join(this.dir, 'review.json')),
      usage: totals(forRun(this.id)),
      busy,
    };
  }

  setStage(name, patch) {
    Object.assign(this.stages[name], patch);
    this.save();
    this.emit({ type: 'stage', stage: name, ...this.stages[name] });
  }

  setStatus(status) {
    this.status = status;
    this.save();
    this.emit({ type: 'status', status });
  }

  addFlags(flags) {
    if (!flags.length) return;
    this.flags.push(...flags.map(f => ({ ...f, at: Date.now() })));
    this.save();
    this.emit({ type: 'flags', flags });
  }

  // ---------- capture ----------

  /** Capture links only work while the run is waiting for a hand. */
  get accepting() { return !this.busy && this.stages.capture.status !== 'done'; }

  /** Open capture again with a fresh link; earlier results stay until a new profile arrives. */
  reopenCapture() {
    if (this.busy) throw new Error('this run is busy');
    this.captureToken = randomBytes(12).toString('hex');
    this.setStage('capture', { status: 'waiting' });
    this.setStatus('awaiting-capture');
  }

  receiveProfile(profile) {
    if (this.busy) throw new Error('this run is busy');
    if (!this.accepting) throw new Error('This run already has its capture. Ask for a new link to capture again.');
    writeJson(join(this.dir, 'profile.json'), profile);
    // A new capture invalidates everything built from the old one.
    for (const s of STAGES) this.stages[s] = { status: 'pending' };
    this.flags = this.flags.filter(f => f.stage !== 'capture');
    const flags = checkProfile(profile);
    this.addFlags(flags);
    this.emit({ type: 'profile', side: profile.side, scale: profile.scale?.method });
    if (flags.some(f => f.severity === 'stop')) {
      this.setStage('capture', { status: 'failed', error: 'the profile is not usable', endedAt: Date.now() });
      this.setStatus('needs-you');
      return;
    }
    this.setStage('capture', { status: 'done', endedAt: Date.now() });
    this.advance();
  }

  // ---------- control ----------

  /** Run every pending stage in order, stopping at the first that fails. */
  async advance() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const name of STAGES.slice(1)) {
        const s = this.stages[name];
        if (s.status === 'done' || s.status === 'skipped') continue;
        if (s.status === 'failed') { this.setStatus('needs-you'); return; }
        this.setStatus(`running:${name}`);
        this.setStage(name, { status: 'running', startedAt: Date.now(), endedAt: null, error: null });
        try {
          await this[`stage_${name}`]();
          this.setStage(name, { status: 'done', endedAt: Date.now() });
        } catch (err) {
          const msg = String(err.message || err);
          this.setStage(name, { status: 'failed', endedAt: Date.now(), error: msg });
          this.addFlags([failureFlag(name, err)]);
          this.setStatus('needs-you');
          return;
        }
      }
      this.setStatus(this.approval ? this.approval.status : 'awaiting-approval');
    } finally {
      this.busy = false;
      this.save();
    }
  }

  /** Reset a stage and everything after it, optionally with feedback for the agent, then continue. */
  retry(stage, note = '') {
    if (this.busy) throw new Error('this run is busy');
    if (!STAGES.includes(stage) || stage === 'capture') throw new Error(`cannot retry ${stage}`);
    if (note.trim()) this.feedback.push({ stage, note: note.trim(), at: Date.now() });
    const from = STAGES.indexOf(stage);
    for (const s of STAGES.slice(from)) this.stages[s] = { status: 'pending' };
    // Keep flags about earlier stages; the Supervisor's flags go whenever anything it reviewed is redone.
    const reviewAt = STAGES.indexOf('review');
    this.flags = this.flags.filter(f => f.source === 'supervisor' ? from > reviewAt : STAGES.indexOf(f.stage) >= 0 && STAGES.indexOf(f.stage) < from);
    this.approval = null;
    this.save();
    this.emit({ type: 'retry', stage, note });
    return this.advance();
  }

  /** Mark a failed stage skipped and carry on. */
  skip(stage) {
    if (this.busy) throw new Error('this run is busy');
    if (!['render', 'review', 'archive'].includes(stage)) throw new Error(`${stage} cannot be skipped: later stages depend on it`);
    this.setStage(stage, { status: 'skipped' });
    return this.advance();
  }

  // ---------- stages ----------

  brief() {
    const flags = this.flags.filter(f => f.stage === 'capture');
    const fb = this.feedback.map(f => `- (${f.stage}) ${f.note}`).join('\n');
    return `# Brief

- Person: ${this.person}
- Hand: ${this.side}
- Goal: ${this.goal || 'not given — design for everyday grip tasks'}
${this.notes ? `- Notes from the family: ${this.notes}\n` : ''}
## Capture warnings
${flags.map(f => `- ${f.issue}`).join('\n') || '- none'}

## Feedback from earlier attempts
${fb || '- none'}
`;
  }

  agentEvents() {
    return ev => this.emit(ev);
  }

  async stage_research() {
    const cat = catalogue();
    if (!cat) throw new Error('the research corpus is empty; run `npm run research` first');
    writeFileSync(join(this.dir, 'brief.md'), this.brief());
    const { output } = await runAgent({
      name: 'researcher', runId: this.id, cwd: this.dir, schema: RESEARCH_SCHEMA,
      readRoots: [CORPUS], onEvent: this.agentEvents(),
      task: `${this.brief()}
## Hand readings
${readingSummary(this.profile)}

## Corpus
Full text: ${join(CORPUS, 'items')}/<id>.md

id | use | licence | device type | body parts | need | title
${cat}`,
    });
    // Fill in each reference's URL and licence from the index, whatever the model wrote.
    const byId = Object.fromEntries(loadIndex().map(i => [i.id, i]));
    output.references = (output.references || []).filter(r => byId[r.id]).map(r => ({
      ...r, url: byId[r.id].url, license: byId[r.id].license, use: byId[r.id].use === 'adapt' ? r.use : 'cite',
    }));
    writeJson(join(this.dir, 'research.json'), output);
  }

  async stage_design() {
    writeFileSync(join(this.dir, 'brief.md'), this.brief());
    const base = await baselineSizes(this.profile);
    writeJson(join(this.dir, 'baseline.json'), base);
    mkdirSync(join(this.dir, 'devices'), { recursive: true });
    const tryCmd = `node ${join(ROOT, 'lib', 'try-device.js')}`;
    const { output } = await runAgent({
      name: 'designer', runId: this.id, cwd: this.dir, schema: DESIGN_SCHEMA,
      readRoots: [DEVICES, join(FITTED, 'design')], onEvent: this.agentEvents(), idleMs: 6 * 60_000,
      bashAllow: [new RegExp(`^${escapeRe(tryCmd)}\\s`)],
      task: `Design 2–4 devices for this brief. Read brief.md, profile.json, research.json and baseline.json first.

Device API: ${join(DEVICES, 'API.md')}
Example module: ${join(DEVICES, 'examples', 'bar-handle.mjs')}
Built-in devices and their size ranges:
${Object.entries(BUILTINS).map(([id, b]) => `- ${id}: ${b.meta.purpose} Params: ${Object.entries(b.meta.parameters).map(([k, p]) => `${k} (${p.min}–${p.max} ${p.unit})`).join(', ')}`).join('\n')}
Approved device types from earlier runs: ${listLibrary().join(', ') || 'none yet'}

Test command (the only one you may run, from this directory):
  ${tryCmd} <built-in name | devices/<id>.mjs> '<params JSON>'`,
    });
    // Store sizes as name → value, with units and reasons alongside.
    const designs = output.designs.map(d => ({
      ...d,
      params: Object.fromEntries(d.params.map(p => [p.name, p.value])),
      units: Object.fromEntries(d.params.map(p => [p.name, p.unit])),
      why: Object.fromEntries(d.params.map(p => [p.name, p.why])),
    }));
    for (const d of designs) {
      if (d.kind === 'new' && !/^devices\/[a-z0-9-]+\.mjs$/.test(d.device)) throw new Error(`${d.name}: new device module must be devices/<id>.mjs, got ${d.device}`);
      if (d.kind === 'builtin' && !BUILTINS[d.device]) throw new Error(`${d.name}: unknown built-in ${d.device}`);
    }
    writeJson(join(this.dir, 'design.json'), { summary: output.summary, designs });
  }

  async stage_build() {
    const design = readJson(join(this.dir, 'design.json'));
    const built = await buildRun(this.dir);
    const flags = [...checkBuilt(design, built), ...checkSources(design, loadIndex())];
    writeJson(join(this.dir, 'checks.json'), flags);
    this.addFlags(flags);
    if (flags.some(f => f.severity === 'stop')) throw new Error('no design built successfully');
  }

  async stage_render() {
    if (!canRender()) { this.addFlags([{ severity: 'info', stage: 'render', issue: 'Chrome is not installed, so there are no renders.', suggestion: 'Install Google Chrome, then retry render.', source: 'orchestrator' }]); return; }
    const built = readJson(join(this.dir, 'built.json'), []);
    for (const b of built.filter(b => b.ok)) {
      try { await renderStl(`/runs/${this.id}/${b.stl}`, join(this.dir, 'out', `${b.id}.png`)); }
      catch (err) { this.addFlags([{ severity: 'info', stage: 'render', issue: `No render for ${b.id}: ${err.message}.`, suggestion: 'Retry render; the STL is unaffected.', source: 'orchestrator' }]); }
    }
  }

  async stage_review() {
    writeJson(join(this.dir, 'usage.json'), totals(forRun(this.id)));
    const { output } = await runAgent({
      name: 'supervisor', runId: this.id, cwd: this.dir, schema: REVIEW_SCHEMA, onEvent: this.agentEvents(),
      task: `Review this run. Start with brief.md, then design.json and built.json. The renders are out/*.png.`,
    });
    writeJson(join(this.dir, 'review.json'), output);
    this.addFlags((output.flags || []).map(f => ({ ...f, source: 'supervisor' })));
  }

  async stage_archive() {
    const notes = archive(this, this.archiveInputs());
    this.vaultNotes = notes;
    this.emit({ type: 'archived', notes });
  }

  archiveInputs() {
    return {
      design: readJson(join(this.dir, 'design.json')),
      built: readJson(join(this.dir, 'built.json'), []),
      review: readJson(join(this.dir, 'review.json')),
      research: readJson(join(this.dir, 'research.json')),
      usage: totals(forRun(this.id)),
    };
  }

  // ---------- approval ----------

  /** The person's decision. Approved new device types join the library for future runs. */
  decide({ status, designs = [], note = '' }) {
    if (this.busy) throw new Error('this run is busy');
    if (!['approved', 'rejected'].includes(status)) throw new Error('status must be approved or rejected');
    const design = readJson(join(this.dir, 'design.json'));
    if (!design) throw new Error('nothing to approve yet');
    const ids = status === 'approved' ? (designs.length ? designs : design.designs.map(d => d.id)) : [];
    this.approval = { status, designs: ids, note: note.trim(), at: Date.now() };
    const promoted = [];
    for (const d of design.designs.filter(d => ids.includes(d.id) && d.kind === 'new')) {
      const name = `${basename(d.device, '.mjs')}.mjs`;
      const target = join(DEVICES, name);
      if (!existsSync(target)) {
        copyFileSync(join(this.dir, d.device), target);
        deviceNote(this, d, `devices/${name}`);
        promoted.push(name);
      }
    }
    this.status = status;
    this.save();
    archive(this, this.archiveInputs());
    this.emit({ type: 'decision', ...this.approval, promoted });
    this.emit({ type: 'status', status });
    return { promoted };
  }

  remove() { rmSync(this.dir, { recursive: true, force: true }); }
}

// ---------- helpers ----------

export function listLibrary() {
  try { return readdirSync(DEVICES).filter(f => f.endsWith('.mjs')).map(f => f.replace(/\.mjs$/, '')); } catch { return []; }
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function readingSummary(p) {
  if (!p) return 'none';
  const m = Object.entries(p.measurements || {}).map(([k, v]) => `${k}: ${v.value} ${v.unit}`).join(', ');
  const mo = Object.entries(p.motion || {}).map(([k, v]) => `${k}: ${v.min}–${v.max} ${v.unit}`).join(', ');
  return `Scale: ${p.scale?.method}${p.scale?.spreadPct != null ? ` (${p.scale.spreadPct}% spread)` : ''}\nSizes: ${m}\nMotion (5th–95th percentile across the recording): ${mo}`;
}

/** A failed stage becomes a flag with the cheapest way forward. */
function failureFlag(stage, err) {
  const kind = err.kind || '';
  const msg = String(err.message || err);
  let suggestion = `Retry ${stage}.`;
  const options = [`Retry ${stage}`];
  if (kind === 'billing') suggestion = 'Billing is not on your subscription. Check that no API key is set, then retry.';
  else if (kind === 'stuck') suggestion = `Retry ${stage}. If it gets stuck again, add a note narrowing the goal, so the agent has less to explore.`;
  else if (kind === 'error_max_turns') suggestion = `The agent ran out of steps. Retry ${stage} with a note asking for fewer designs.`;
  else if (/rate|limit|usage/i.test(msg)) suggestion = 'Your plan\'s usage limit was probably reached. Wait for it to reset, then retry.';
  else if (stage === 'build') { suggestion = 'Retry design with a note to simplify the new device, or retry build.'; options.push('Retry design'); }
  else if (stage === 'render' || stage === 'review' || stage === 'archive') { options.push(`Skip ${stage}`); }
  if (AGENT_STAGES[stage]) options.push('Look at the activity log for what the agent was doing');
  return { severity: 'stop', stage, issue: `The ${stage} stage failed: ${msg}`, suggestion, options, source: 'orchestrator' };
}
