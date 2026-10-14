// Archivist. Plain code: an Obsidian vault is a folder of Markdown files, so
// logging a design is filling a template. The "why" comes from the Designer,
// who already wrote it; nothing here needs a model.
//
// Vault layout:
//   People/<person>.md                      one per person, a row per capture
//   Designs/<date> <person> - <name>.md     one per design: readings, sizes, reasons, sources
//   Runs/<run id>.md                        one per run: every stage, flags, usage
//   Devices/<device id>.md                  new device types, once approved
//   attachments/<run id>/                   renders and STL files
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT } from './paths.js';

const clean = s => String(s ?? '').replace(/[\\/:*?"<>|#^[\]]/g, '-').replace(/\s+/g, ' ').trim();
const cell = s => String(s ?? '–').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const yaml = v => JSON.stringify(v ?? null);

const LABELS = {
  knuckleSpan: 'Knuckle span', palmLength: 'Palm length', handLength: 'Hand length',
  thumbLength: 'Thumb', indexLength: 'Index finger', middleLength: 'Middle finger',
  ringLength: 'Ring finger', pinkyLength: 'Little finger',
  aperture: 'Thumb-to-index opening', thumbCurl: 'Thumb curl', indexCurl: 'Index curl',
  middleCurl: 'Middle curl', ringCurl: 'Ring curl', pinkyCurl: 'Little finger curl',
};
const unit = u => (u === 'deg' ? '°' : ` ${u}`);

function ensure() {
  for (const d of ['People', 'Designs', 'Runs', 'Devices', 'attachments']) mkdirSync(join(VAULT, d), { recursive: true });
  const readme = join(VAULT, 'README.md');
  if (!existsSync(readme)) {
    writeFileSync(readme, `# Fitted Vault

Every design Fitted's agents produce is logged here, so each one can be traced
back to the readings, the research and the reasons behind it.

| Folder | Holds |
|---|---|
| People | One note per person, with a row for every capture |
| Designs | One note per design: readings, sizes, reasons, sources, approval |
| Runs | One note per pipeline run: stages, flags, token use |
| Devices | New device types, added once a design using them is approved |
| attachments | Renders and STL files, one folder per run |

Written by \`~/fitted-agents\`. Edit notes freely; a run only rewrites its own notes.
`);
  }
}

export const designNoteName = (run, d) => `${run.createdAt.slice(0, 10)} ${clean(run.person)} - ${clean(d.name)} (${run.id})`;

function readingsTable(profile) {
  const rows = [
    ...Object.entries(profile.measurements || {}).map(([k, v]) => `| ${LABELS[k] || k} | ${v.value}${unit(v.unit)} |`),
    ...Object.entries(profile.motion || {}).map(([k, v]) => `| ${LABELS[k] || k} | ${v.min}–${v.max}${unit(v.unit)} |`),
  ];
  return `| Reading | Value |\n|---|---|\n${rows.join('\n')}`;
}

function flagList(flags) {
  if (!flags?.length) return '_None._';
  return flags.map(f => `- **${f.severity}** (${f.stage}) ${f.issue}${f.suggestion ? `\n  - Suggested: ${f.suggestion}` : ''}`).join('\n');
}

/** Copy renders and STLs into the vault so notes can embed them. */
function attach(run) {
  const dir = join(VAULT, 'attachments', run.id);
  mkdirSync(dir, { recursive: true });
  const out = join(run.dir, 'out');
  if (existsSync(out)) for (const f of readdirSync(out)) if (/\.(png|stl)$/.test(f)) copyFileSync(join(out, f), join(dir, f));
  return `attachments/${run.id}`;
}

function designNote(run, d, built, review, research) {
  const b = built.find(x => x.id === d.id) || {};
  const verdict = review?.designs?.find(x => x.id === d.id);
  const status = run.approval?.status === 'approved' ? (run.approval.designs?.includes(d.id) ? 'approved' : 'not chosen') : run.approval?.status || 'awaiting approval';
  const refs = Object.fromEntries((research?.references || []).map(r => [r.id, r]));
  const files = `attachments/${run.id}`;
  const params = d.params || {};

  return `---
person: ${yaml(run.person)}
side: ${yaml(run.side)}
device: ${yaml(d.device)}
kind: ${yaml(d.kind)}
status: ${yaml(status)}
confidence: ${yaml(d.confidence)}
run: ${yaml(run.id)}
date: ${run.createdAt.slice(0, 10)}
estimated_sizes: ${run.profile?.scale?.method !== 'reference'}
sources: ${yaml((d.sources || []).map(s => s.id))}
tags: [fitted/design, fitted/${d.kind}]
---

# ${d.name}

**For:** [[${clean(run.person)}]] · ${run.side} hand · **Goal:** ${run.goal || '–'}
**Status:** ${status} · **Confidence:** ${d.confidence || '–'} · **Run:** [[${run.id}]]

${d.purpose || ''}

${b.ok ? `![[${files}/${d.id}.png]]` : `> [!warning] This design did not build: ${b.error || 'unknown error'}`}

## Sizes and why

| Size | Value | Why |
|---|---|---|
${Object.entries(params).map(([k, v]) => `| ${k} | ${v} ${d.units?.[k] || ''} | ${cell(d.why?.[k])} |`).join('\n')}

${b.report ? `Printed part: **${b.report.sizeMm.join(' × ')} mm**, ${b.report.volumeCm3} cm³, ${b.report.openEdges} open edges.` : ''}
${b.problems?.length ? `\n> [!warning] Build checks\n${b.problems.map(p => `> - ${p}`).join('\n')}` : ''}

## Readings it was sized from

${run.profile ? readingsTable(run.profile) : '_No profile._'}

Scale: ${run.profile?.scale?.method === 'reference' ? `measured against ${run.profile.scale.reference || 'a reference'} (${run.profile.scale.spreadPct ?? '?'}% spread)` : '**estimated** from an average adult hand'}.

## Sources

${(d.sources || []).length ? (d.sources || []).map(s => {
    const r = refs[s.id];
    return `- **${s.use}** — ${r ? `[${r.title}](${r.url || ''})` : s.id} (${r?.license || 'licence unknown'}): ${s.how || ''}`;
  }).join('\n') : '_No sources cited: this design rests on the Designer\'s own reasoning._'}

## Printing

${d.printing ? `- Material: ${d.printing.material || '–'}\n- Infill: ${d.printing.infill || '–'}\n- Orientation: ${d.printing.orientation || '–'}\n- Notes: ${d.printing.notes || '–'}` : '_Not given._'}
- File: [[${files}/${d.id}.stl]]

## Risks

${(d.risks || []).map(r => `- ${r}`).join('\n') || '_None listed._'}

## Supervisor

${verdict ? `**${verdict.verdict}** — ${verdict.note}` : '_Not reviewed._'}

## Approval

${run.approval ? `${run.approval.status} on ${new Date(run.approval.at).toISOString().slice(0, 10)}${run.approval.note ? `: ${run.approval.note}` : ''}` : '_Waiting for approval._'}
`;
}

function runNote(run, design, review, usage) {
  const designs = (design?.designs || []).map(d => `- [[${designNoteName(run, d)}|${d.name}]] (${d.kind})`).join('\n');
  const stageRows = Object.entries(run.stages).map(([k, s]) => `| ${k} | ${s.status} | ${s.endedAt && s.startedAt ? Math.round((s.endedAt - s.startedAt) / 1000) + 's' : '–'} | ${cell(s.error || '')} |`).join('\n');
  const usageRows = Object.entries(usage || {}).map(([agent, u]) => `| ${agent} | ${u.calls} | ${u.fresh.toLocaleString()} | ${u.cacheRead.toLocaleString()} | ${Math.round(u.durationMs / 1000)}s |`).join('\n');
  return `---
person: ${yaml(run.person)}
run: ${yaml(run.id)}
date: ${run.createdAt.slice(0, 10)}
status: ${yaml(run.status)}
tags: [fitted/run]
---

# Run ${run.id}

**Person:** [[${clean(run.person)}]] · ${run.side} hand · **Goal:** ${run.goal || '–'}
${run.notes ? `\n**Notes:** ${run.notes}\n` : ''}
## Designs

${designs || '_None yet._'}

## Supervisor's summary

${review?.summary || '_Not reviewed._'}
${review?.bestPath ? `\n**Suggested first step:** ${review.bestPath}` : ''}

## Flags

${flagList(run.flags)}

## Stages

| Stage | Status | Time | Error |
|---|---|---|---|
${stageRows}

## Token use

| Agent | Calls | Fresh tokens | Cache reads | Time |
|---|---|---|---|---|
${usageRows || '| – | – | – | – | – |'}
`;
}

/** Add or update this run's row in the person's note, leaving the rest alone. */
function personNote(run) {
  const file = join(VAULT, 'People', `${clean(run.person)}.md`);
  const row = `| ${run.createdAt.slice(0, 10)} | ${run.side} | ${cell(run.goal)} | [[${run.id}]] | ${run.status} |`;
  if (!existsSync(file)) {
    writeFileSync(file, `---\ntags: [fitted/person]\n---\n\n# ${run.person}\n\n## Runs\n\n| Date | Hand | Goal | Run | Status |\n|---|---|---|---|---|\n${row}\n`);
    return;
  }
  const text = readFileSync(file, 'utf8');
  const re = new RegExp(`^\\|[^\\n]*\\[\\[${run.id}\\]\\][^\\n]*$`, 'm');
  writeFileSync(file, re.test(text) ? text.replace(re, row) : text.replace(/(\|---\|---\|---\|---\|---\|\n(?:\|.*\n)*)/, `$1${row}\n`));
}

/** Write or rewrite every note for this run. Returns the note paths, relative to the vault. */
export function archive(run, { design, built = [], review, research, usage }) {
  ensure();
  attach(run);
  const written = [];
  for (const d of design?.designs || []) {
    const name = `Designs/${designNoteName(run, d)}.md`;
    writeFileSync(join(VAULT, name), designNote(run, d, built, review, research));
    written.push(name);
  }
  writeFileSync(join(VAULT, 'Runs', `${run.id}.md`), runNote(run, design, review, usage));
  written.push(`Runs/${run.id}.md`);
  personNote(run);
  written.push(`People/${clean(run.person)}.md`);
  return written;
}

/** A new device type, once a design using it is approved. */
export function deviceNote(run, d, libraryFile) {
  ensure();
  const name = `Devices/${clean(d.device.replace(/^devices\//, '').replace(/\.mjs$/, ''))}.md`;
  writeFileSync(join(VAULT, name), `---\ntags: [fitted/device]\nfirst_run: ${yaml(run.id)}\nmodule: ${yaml(libraryFile)}\n---\n\n# ${d.name}\n\n${d.purpose || ''}\n\nFirst designed for [[${clean(run.person)}]] in run [[${run.id}]]: [[${designNoteName(run, d)}]].\n\nModule: \`${libraryFile}\`. Future runs can size it for other hands.\n`);
  return name;
}
