// fitted-agents server. No framework, like ~/fitted's server.
//
// Two audiences:
// - The dashboard and its API: this Mac only.
// - The capture page: anyone on the same Wi-Fi who has a run's capture link.
//   The link's token is the only thing that lets a profile in.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
import { ROOT, FITTED, RUNS, PORT, VAULT } from './lib/paths.js';
import { Run, STAGES, listLibrary } from './lib/pipeline.js';
import { billingStatus } from './lib/billing.js';
import { totals, readLedger, limits } from './lib/budget.js';
import { stats as corpusStats } from './lib/corpus.js';
import { partList, BODY_PARTS } from './lib/bodyparts.js';

const LAN = process.env.FITTED_LAN !== '0';
const runs = new Map(Run.loadAll().map(r => [r.id, r]));
const byToken = token => [...runs.values()].find(r => r.captureToken === token);

const PUBLIC_MOUNTS = [
  ['/capture/', join(FITTED, 'capture')],
  ['/vendor/tasks-vision/', join(FITTED, 'node_modules', '@mediapipe', 'tasks-vision')],
  ['/vendor/three/', join(ROOT, 'node_modules', 'three')],
];
const LOCAL_MOUNTS = [
  ['/ui/', join(ROOT, 'ui')],
  ['/runs/', RUNS],
];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.task': 'application/octet-stream',
  '.map': 'application/json', '.png': 'image/png', '.stl': 'model/stl', '.md': 'text/markdown; charset=utf-8',
};

/** Every address this Mac answers on, so a Wi-Fi link opened on the Mac itself can be spotted. */
function ownAddresses() {
  const out = new Set();
  for (const list of Object.values(networkInterfaces())) for (const a of list || []) { out.add(a.address); out.add(`::ffff:${a.address}`); }
  return out;
}

const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && /^(10|172|192)\./.test(a.address)) return a.address;
  }
  return null;
}

export function captureLinks(run) {
  const path = `/capture/?t=${run.captureToken}`;
  const lan = LAN && lanAddress();
  return { local: `http://localhost:${PORT}${path}`, wifi: lan ? `http://${lan}:${PORT}${path}` : null };
}

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

async function body(req, max = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw Object.assign(new Error('request too large'), { code: 413 });
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString();
  try { return text ? JSON.parse(text) : {}; }
  catch { throw Object.assign(new Error('body must be JSON'), { code: 400 }); }
}

async function serveFile(res, dir, rel) {
  const file = normalize(join(dir, rel));
  // Never serve anything outside the mount, whatever the URL says.
  if (file !== dir && !file.startsWith(dir + sep)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const info = await stat(file);
    const target = info.isDirectory() ? join(file, 'index.html') : file;
    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': TYPES[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
}

const view = run => ({ ...run.snapshot(), captureLinks: run.accepting ? captureLinks(run) : null });

async function api(req, res, path) {
  const m = path.match(/^\/api\/runs\/([0-9a-f]{8})(?:\/(\w+))?$/);
  const run = m && runs.get(m[1]);
  if (m && !run) return json(res, 404, { error: 'no such run' });
  const action = m?.[2];

  if (path === '/api/status' && req.method === 'GET') {
    return json(res, 200, { billing: billingStatus(), corpus: corpusStats(), vault: VAULT, library: listLibrary(), bodyParts: partList(), lan: LAN ? lanAddress() : null, stages: STAGES });
  }
  if (path === '/api/usage' && req.method === 'GET') {
    return json(res, 200, { totals: totals(readLedger()), limits: limits() });
  }
  if (path === '/api/runs' && req.method === 'GET') {
    return json(res, 200, [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(r => ({
      id: r.id, person: r.person, side: r.side, bodyPart: r.bodyPart, partName: r.partName, goal: r.goal, status: r.status, createdAt: r.createdAt,
      flags: r.flags.filter(f => f.severity !== 'info').length,
    })));
  }
  if (path === '/api/runs' && req.method === 'POST') {
    const b = await body(req);
    if (!b.person?.trim()) return json(res, 400, { error: 'person is required' });
    let created;
    try { created = Run.create(b); } catch (err) { return json(res, 400, { error: err.message }); }
    runs.set(created.id, created);
    return json(res, 200, view(created));
  }
  if (run && !action && req.method === 'GET') return json(res, 200, view(run));
  if (run && !action && req.method === 'DELETE') {
    if (run.busy) return json(res, 409, { error: 'run is busy' });
    run.remove(); runs.delete(run.id);
    return json(res, 200, { ok: true });
  }
  if (run && action === 'stream' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    for (const ev of run.events.slice(-400)) send(ev);
    const unsub = run.subscribe(send);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); unsub(); });
    return;
  }
  try {
    if (run && action === 'recapture' && req.method === 'POST') { run.reopenCapture(); return json(res, 200, view(run)); }
    if (run && action === 'profile' && req.method === 'POST') { run.receiveProfile(await body(req)); return json(res, 200, view(run)); }
    if (run && action === 'retry' && req.method === 'POST') { const b = await body(req); run.retry(b.stage, b.note || '').catch(() => {}); return json(res, 200, { ok: true }); }
    if (run && action === 'skip' && req.method === 'POST') { const b = await body(req); run.skip(b.stage).catch(() => {}); return json(res, 200, { ok: true }); }
    if (run && action === 'decide' && req.method === 'POST') { const r = run.decide(await body(req)); return json(res, 200, { ...view(run), ...r }); }
  } catch (err) {
    return json(res, err.code || 409, { error: String(err.message || err) });
  }
  json(res, 404, { error: 'not found' });
}

async function handle(req, res) {
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); return res.end('bad path'); }

  // ----- reachable from the Wi-Fi: capture only -----
  const cap = path.match(/^\/api\/capture\/([0-9a-f]{24})$/);
  if (cap) {
    const run = byToken(cap[1]);
    if (!run) return json(res, 404, { error: 'This capture link is not valid any more. Ask for a new one.' });
    if (req.method === 'GET') return json(res, 200, { person: run.person, side: run.side, bodyPart: run.bodyPart, accepting: run.accepting });
    if (req.method === 'POST') {
      try {
        const profile = await body(req);
        if (profile.bodyPart !== run.bodyPart) {
          return json(res, 400, { error: `This link is for the ${run.partName}, but the capture is for the ${BODY_PARTS[profile.bodyPart]?.label.toLowerCase() || 'unknown body part'}. Reload the link and capture again.` });
        }
        if (BODY_PARTS[run.bodyPart].sided && profile.side !== run.side) {
          return json(res, 400, { error: `This link is for the ${run.partName}, but the capture says ${profile.side}. Change the side and record again.` });
        }
        run.receiveProfile(profile);
        return json(res, 200, { ok: true, message: 'Sent. You can close this page.' });
      } catch (err) { return json(res, err.code || 409, { error: String(err.message || err) }); }
    }
  }
  // The Wi-Fi link opened on this Mac: browsers only allow the camera on localhost
  // (or https), so send it there. Same path and token, live camera works.
  if (path.startsWith('/capture') && !isLocal(req) && ownAddresses().has(req.socket.remoteAddress)) {
    res.writeHead(302, { Location: `http://localhost:${PORT}${req.url}` });
    return res.end();
  }
  if (path === '/capture') { res.writeHead(302, { Location: '/capture/' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '') }); return res.end(); }
  for (const [prefix, dir] of PUBLIC_MOUNTS) if (path.startsWith(prefix)) return serveFile(res, dir, path.slice(prefix.length));

  // ----- this Mac only -----
  if (!isLocal(req)) { res.writeHead(403); return res.end('The dashboard is only available on the Mac running Fitted.'); }
  if (path === '/') { res.writeHead(302, { Location: '/ui/' }); return res.end(); }
  if (path.startsWith('/api/')) return api(req, res, path).catch(err => json(res, 500, { error: String(err.message || err) }));
  for (const [prefix, dir] of LOCAL_MOUNTS) if (path.startsWith(prefix)) return serveFile(res, dir, path.slice(prefix.length));
  res.writeHead(404); res.end('not found');
}

const hosts = LAN ? ['0.0.0.0', '::1'] : ['127.0.0.1', '::1'];
for (const host of hosts) createServer(handle).listen(PORT, host).on('error', err => console.warn(`not listening on ${host}: ${err.message}`));
console.log(`fitted-agents → http://localhost:${PORT}/`);
if (LAN && lanAddress()) console.log(`capture links work on this Wi-Fi via http://${lanAddress()}:${PORT}`);
