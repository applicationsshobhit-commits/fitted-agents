// Turns a design (a device type plus its sizes) into geometry, STL files and
// measurements. Built-in devices come from ~/fitted/design; new device types are
// modules the Designer writes, following devices/API.md.
import { writeFileSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FITTED, DEVICES } from './paths.js';

const fitted = () => import(pathToFileURL(join(FITTED, 'design', 'designs.js')).href);

/** The three designs that already exist in ~/fitted, wrapped in the module shape. */
export const BUILTINS = {
  'built-up-grip': {
    meta: {
      name: 'Built-up grip',
      purpose: 'A thick ribbed sleeve over a utensil handle, for hands that cannot close around a thin one.',
      parameters: {
        outerDiameter: { unit: 'mm', min: 22, max: 46, description: 'outside diameter of the grip' },
        length: { unit: 'mm', min: 70, max: 120, description: 'grip length along the handle' },
        boreDiameter: { unit: 'mm', min: 6, max: 14, description: 'hole the utensil handle slides into' },
      },
    },
    build: async p => [(await fitted()).builtUpGeometry(p)],
  },
  'universal-cuff': {
    meta: {
      name: 'Universal cuff',
      purpose: 'A C-shaped band round the palm with a pocket that holds a utensil, so no grip is needed at all.',
      parameters: {
        palmWidth: { unit: 'mm', min: 50, max: 100, description: 'inside width of the band' },
        palmThickness: { unit: 'mm', min: 18, max: 35, description: 'inside thickness of the band' },
        bandWidth: { unit: 'mm', min: 20, max: 50, description: 'strap width, wrist to fingers' },
        wall: { unit: 'mm', min: 2, max: 6, description: 'band wall thickness' },
        slotWidth: { unit: 'mm', min: 6, max: 16, description: 'pocket opening width' },
        slotHeight: { unit: 'mm', min: 2, max: 6, description: 'pocket opening height' },
      },
    },
    build: async p => { const c = (await fitted()).cuffGeometries(p); return [c.bandGeo, c.pocketGeo]; },
  },
  'palm-bulb': {
    meta: {
      name: 'Palm bulb',
      purpose: 'An egg-shaped handle that fills the palm, for hands whose fingers stay curled.',
      parameters: {
        diameter: { unit: 'mm', min: 40, max: 68, description: 'widest diameter of the bulb' },
        boreDiameter: { unit: 'mm', min: 6, max: 14, description: 'hole the utensil handle slides into' },
      },
    },
    build: async p => [(await fitted()).bulbGeometry(p)],
  },
};

/** The baseline sizes ~/fitted computes for its built-in designs. */
export async function baseline(profile) {
  const d = (await fitted()).designFromProfile(profile);
  return {
    'built-up-grip': d.builtUp,
    'universal-cuff': d.cuff,
    'palm-bulb': d.bulb,
    estimated: d.estimated,
  };
}

/**
 * Find a device by reference: a built-in name, a module path inside the run
 * directory, or an approved device in the library (devices/<id>.mjs).
 */
export async function loadDevice(ref, runDir) {
  if (BUILTINS[ref]) return BUILTINS[ref];
  const candidates = [];
  if (runDir) candidates.push(resolve(runDir, ref));
  candidates.push(resolve(DEVICES, ref), resolve(DEVICES, `${ref}.mjs`));
  for (const file of candidates) {
    const allowed = [runDir && resolve(runDir), resolve(DEVICES)].filter(Boolean);
    if (!allowed.some(r => file.startsWith(r + sep))) continue;
    if (!existsSync(file)) continue;
    const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
    if (typeof mod.build !== 'function') throw new Error(`${ref} has no build(params) export`);
    return { meta: mod.meta || {}, build: mod.build, file };
  }
  throw new Error(`unknown device: ${ref}`);
}

/** Check sizes against the device's declared ranges. Returns problems, never adjusts. */
export function checkParams(meta, params) {
  const problems = [];
  for (const [k, spec] of Object.entries(meta.parameters || {})) {
    const v = params[k];
    if (v === undefined) { if (spec.default === undefined) problems.push(`${k} is missing`); continue; }
    if (!Number.isFinite(v)) { problems.push(`${k} is not a number`); continue; }
    if (spec.min !== undefined && v < spec.min) problems.push(`${k} = ${v} is below its minimum ${spec.min}`);
    if (spec.max !== undefined && v > spec.max) problems.push(`${k} = ${v} is above its maximum ${spec.max}`);
  }
  return problems;
}

const withDefaults = (meta, params) => {
  const out = {};
  for (const [k, spec] of Object.entries(meta.parameters || {})) if (spec.default !== undefined) out[k] = spec.default;
  return { ...out, ...params };
};

/** Solid volume in mm³, from the signed tetrahedron sum. */
function volume(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.attributes.position;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let v = 0;
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    v += a.dot(b.clone().cross(c)) / 6;
  }
  return Math.abs(v);
}

/**
 * Edges used by exactly one triangle. A printable solid has none; a few usually
 * mean a seam a slicer will repair, many mean the shape is not closed.
 */
function openEdges(geo) {
  const g = mergeVertices(geo.clone().deleteAttribute('normal').deleteAttribute('uv'), 1e-3);
  const idx = g.index ? g.index.array : [...Array(g.attributes.position.count).keys()];
  const count = new Map();
  for (let i = 0; i < idx.length; i += 3) {
    for (const [u, v] of [[idx[i], idx[i + 1]], [idx[i + 1], idx[i + 2]], [idx[i + 2], idx[i]]]) {
      if (u === v) continue;
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      count.set(key, (count.get(key) || 0) + 1);
    }
  }
  let open = 0;
  for (const n of count.values()) if (n === 1) open++;
  return open;
}

export function measure(geos) {
  const box = new THREE.Box3();
  let finite = true, triangles = 0, open = 0;
  for (const g of geos) {
    g.computeBoundingBox();
    box.union(g.boundingBox);
    const arr = g.attributes.position.array;
    for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) { finite = false; break; }
    triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
    open += openEdges(g);
  }
  const s = box.getSize(new THREE.Vector3());
  return {
    sizeMm: [s.x, s.y, s.z].map(v => Math.round(v * 10) / 10),
    volumeCm3: Math.round(geos.reduce((sum, g) => sum + volume(g), 0) / 100) / 10,
    triangles, openEdges: open, finite,
  };
}

export function writeStl(geos, file) {
  const group = new THREE.Group();
  for (const g of geos) group.add(new THREE.Mesh(g));
  const data = new STLExporter().parse(group, { binary: true });
  writeFileSync(file, Buffer.from(data.buffer));
}

/** Build one design. Throws on code errors; returns problems for bad output. */
export async function buildDesign(design, runDir) {
  const device = await loadDevice(design.device, runDir);
  const params = withDefaults(device.meta, design.params || {});
  const problems = checkParams(device.meta, params);
  let geos = await device.build(params);
  if (!Array.isArray(geos)) geos = [geos];
  geos = geos.filter(Boolean);
  if (!geos.length || geos.some(g => !g?.attributes?.position)) throw new Error('build() must return BufferGeometry objects');
  const m = measure(geos);
  if (!m.finite) problems.push('geometry contains NaN or infinite coordinates');
  if (m.sizeMm.some(v => v < 3)) problems.push(`a dimension is under 3 mm (${m.sizeMm.join(' × ')})`);
  if (m.sizeMm.some(v => v > 300)) problems.push(`a dimension is over 300 mm (${m.sizeMm.join(' × ')}); check units are millimetres`);
  if (m.openEdges > 50) problems.push(`${m.openEdges} open edges: the shape may not be a closed solid`);
  return { geos, params, report: m, problems, meta: device.meta };
}
