// Child process: builds every design in <runDir>/design.json into STL files.
// Runs out of process so a new device module that loops forever or crashes
// cannot take the server down with it.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildDesign, writeStl } from './devices.js';

const runDir = process.argv[2];
const design = JSON.parse(readFileSync(join(runDir, 'design.json'), 'utf8'));
const out = join(runDir, 'out');
mkdirSync(out, { recursive: true });

const built = [];
for (const d of design.designs || []) {
  try {
    const r = await buildDesign(d, runDir);
    const file = `${d.id}.stl`;
    writeStl(r.geos, join(out, file));
    built.push({ id: d.id, ok: true, stl: `out/${file}`, params: r.params, report: r.report, problems: r.problems });
  } catch (err) {
    built.push({ id: d.id, ok: false, error: String(err.message || err) });
  }
}
writeFileSync(join(runDir, 'built.json'), JSON.stringify(built, null, 2));
