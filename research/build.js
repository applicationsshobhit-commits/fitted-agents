// Builds the Researcher's corpus from open sources, applying the licence policy
// in sources.json. Plain code, no AI: fetching and licence checks are rules.
//
//   node research/build.js          # fetch what's new, keep what's cached
//   node research/build.js --fresh  # refetch everything
//
// Output: data/corpus/index.json (one row per item) and data/corpus/items/<id>.md
// (stored text, for items whose licence allows it).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { ROOT, CORPUS } from '../lib/paths.js';

const SOURCES = JSON.parse(readFileSync(join(ROOT, 'research', 'sources.json'), 'utf8'));
const ITEMS = join(CORPUS, 'items');
const INDEX = join(CORPUS, 'index.json');
const FRESH = process.argv.includes('--fresh');
const MAX_TEXT = 16_000;
mkdirSync(ITEMS, { recursive: true });

const previous = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, 'utf8')) : [];
const prevById = Object.fromEntries(previous.map(i => [i.id, i]));

// ---------- licence policy ----------

/** Normalise any licence string to an SPDX-like id. */
function normalise(raw = '') {
  const s = String(raw).toLowerCase();
  if (/cern.?ohl/.test(s)) return 'CERN-OHL';
  if (/(cc.?by.?nc|noncommercial|non-commercial)/.test(s)) return 'CC-BY-NC';
  if (/(cc.?by.?sa|attribution.?share.?alike)/.test(s)) return 'CC-BY-SA-4.0';
  if (/(cc.?zero|cc0|public domain dedication)/.test(s)) return 'CC0-1.0';
  if (/(cc.?by|creative commons attribution)/.test(s)) return 'CC-BY-4.0';
  if (/apache/.test(s)) return 'Apache-2.0';
  if (/\bmit\b/.test(s)) return 'MIT';
  if (/\bbsd\b/.test(s)) return 'BSD';
  if (/(gpl|gnu general public)/.test(s)) return 'GPL-3.0';
  return raw ? 'unclear' : 'none';
}

/** adapt | cite | link, from a set of licence ids. Hardware or docs licences decide. */
function useFor(licenses) {
  if (licenses.some(l => SOURCES.adaptLicenses.includes(l))) return 'adapt';
  if (licenses.some(l => SOURCES.citeLicenses.some(c => l.startsWith(c)))) return 'cite';
  return 'link';
}

// ---------- GitHub ----------

function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  for (const gh of [join(homedir(), 'bin', 'gh'), 'gh']) {
    const r = spawnSync(gh, ['auth', 'token'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  console.warn('No GitHub token: using the unauthenticated limit of 60 requests an hour.');
  return null;
}
const TOKEN = githubToken();

async function gh(path, { raw = false } = {}) {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      'User-Agent': 'fitted-agents',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${path}: ${res.status} ${await res.text().then(t => t.slice(0, 200))}`);
  return raw ? res.text() : res.json();
}

async function orgRepos(org) {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await gh(`orgs/${org}/repos?per_page=100&page=${page}&type=public`);
    if (!batch?.length) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out.filter(r => !r.fork);
}

/** GitHub often can't name multi-licence repos; read the files ourselves. */
async function repoLicenses(repo) {
  const spdx = repo.license?.spdx_id;
  if (spdx && spdx !== 'NOASSERTION') return [normalise(spdx)];
  const root = (await gh(`repos/${repo.full_name}/contents`)) || [];
  const found = new Set();
  const licDir = root.find(f => f.type === 'dir' && /^licen[cs]es?$/i.test(f.name));
  if (licDir) {
    for (const f of (await gh(`repos/${repo.full_name}/contents/${licDir.name}`)) || []) {
      const l = normalise(f.name.replace(/[_.]/g, ' '));
      if (l !== 'unclear') found.add(l);
    }
  }
  const licFile = root.find(f => f.type === 'file' && /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f.name));
  if (licFile) {
    const text = (await gh(`repos/${repo.full_name}/contents/${licFile.name}`, { raw: true })) || '';
    for (const pat of ['CERN-OHL', 'CERN Open Hardware', 'Attribution-ShareAlike', 'CC BY-SA', 'Attribution 4.0', 'CC BY 4.0', 'MIT License', 'Apache License', 'GNU General Public', 'NonCommercial', 'CC0']) {
      if (text.toLowerCase().includes(pat.toLowerCase())) found.add(normalise(pat));
    }
  }
  return found.size ? [...found] : ['none'];
}

/** README plus the first Markdown guide in Documentation/, trimmed. */
async function repoText(repo) {
  const parts = [];
  const readme = await gh(`repos/${repo.full_name}/readme`, { raw: true });
  if (readme) parts.push(stripMmcBoilerplate(readme));
  const docs = await gh(`repos/${repo.full_name}/contents/Documentation`);
  const guide = Array.isArray(docs) && docs.find(f => /\.md$/i.test(f.name) && /(user|maker|build|guide|assembly)/i.test(f.name));
  if (guide) {
    const t = await gh(`repos/${repo.full_name}/contents/Documentation/${encodeURIComponent(guide.name)}`, { raw: true });
    if (t) parts.push(`\n\n---\n# ${guide.name}\n\n${t}`);
  }
  return parts.join('').slice(0, MAX_TEXT);
}

const stripMmcBoilerplate = s => s.replace(/<!-- ABOUT MMC START -->[\s\S]*?<!-- ABOUT MMC END -->/g, '').trim();

async function githubItem(repo, label) {
  const id = `gh-${repo.full_name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const prev = prevById[id];
  if (!FRESH && prev && prev.updated === repo.pushed_at) return prev;
  const licenses = await repoLicenses(repo);
  const use = useFor(licenses);
  const item = {
    id, source: label, title: repo.name.replace(/[-_]/g, ' '), url: repo.html_url,
    license: licenses.join(' + '), use, updated: repo.pushed_at,
    description: repo.description || '', topics: repo.topics || [],
  };
  if (use !== 'link') {
    const text = await repoText(repo);
    writeFileSync(join(ITEMS, `${id}.md`), header(item) + text);
    item.file = `items/${id}.md`;
    item.chars = text.length;
  }
  return item;
}

// ---------- Zenodo ----------

const stripHtml = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

async function zenodo(q, size) {
  const res = await fetch(`https://zenodo.org/api/records?q=${encodeURIComponent(q)}&size=${size}&sort=bestmatch`, {
    headers: { Accept: 'application/json', 'User-Agent': 'fitted-agents/0.1 (research corpus builder)' },
  });
  if (!res.ok) throw new Error(`Zenodo "${q}": ${res.status}`);
  return (await res.json()).hits?.hits || [];
}

function zenodoItem(rec) {
  const m = rec.metadata || {};
  const id = `zenodo-${rec.id}`;
  const license = normalise(m.license?.id || '');
  const use = useFor([license]);
  const item = {
    id, source: 'Zenodo', title: m.title, url: rec.links?.html || `https://zenodo.org/records/${rec.id}`,
    license: m.license?.id || 'none', use, updated: m.publication_date,
    description: stripHtml(m.description).slice(0, 400), topics: m.keywords || [],
    type: m.resource_type?.type,
  };
  if (use === 'adapt') {
    // Abstracts only: the files themselves are often large PDFs or CAD archives.
    const text = `${stripHtml(m.description)}\n\nKeywords: ${(m.keywords || []).join(', ')}\nCreators: ${(m.creators || []).map(c => c.name).join('; ')}\nDOI: ${m.doi || ''}`;
    writeFileSync(join(ITEMS, `${id}.md`), header(item) + text.slice(0, MAX_TEXT));
    item.file = `items/${id}.md`;
    item.chars = text.length;
  }
  return item;
}

const header = i => `---\nid: ${i.id}\ntitle: ${JSON.stringify(i.title)}\nsource: ${i.source}\nurl: ${i.url}\nlicense: ${i.license}\nuse: ${i.use}\nupdated: ${i.updated}\n---\n\n`;

// ---------- run ----------

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k]); }
      catch (err) { console.warn(`  skipped: ${err.message}`); }
    }
  }));
  return out.filter(Boolean);
}

const items = [];

for (const { org, label } of SOURCES.github) {
  const repos = await orgRepos(org);
  console.log(`${label}: ${repos.length} repositories`);
  items.push(...await pool(repos, 6, r => githubItem(r, label)));
}
for (const full of SOURCES.githubRepos || []) {
  const repo = await gh(`repos/${full}`);
  if (repo) items.push(await githubItem(repo, full.split('/')[0]));
}

const seen = new Set();
for (const q of SOURCES.zenodo.queries) {
  let hits = [];
  try { hits = await zenodo(q, SOURCES.zenodo.perQuery); }
  catch (err) { console.warn(`  ${err.message}; skipped`); continue; }
  let added = 0;
  for (const h of hits) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    items.push(zenodoItem(h));
    added++;
  }
  console.log(`Zenodo "${q}": ${added} new`);
}

for (const c of SOURCES.citeOnly) {
  items.push({ ...c, source: 'reference', use: c.license === 'unclear' ? 'link' : 'cite', updated: null, description: c.summary, topics: [] });
}

// Keep extraction results from earlier runs when the stored text hasn't changed.
for (const it of items) {
  const prev = prevById[it.id];
  if (prev?.extracted && prev.updated === it.updated) it.extracted = prev.extracted;
}

writeFileSync(INDEX, JSON.stringify(items, null, 2));
const count = u => items.filter(i => i.use === u).length;
console.log(`\n${items.length} items → ${INDEX}\n  adapt: ${count('adapt')}   cite: ${count('cite')}   link only: ${count('link')}`);
