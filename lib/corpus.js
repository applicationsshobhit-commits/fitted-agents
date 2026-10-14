// The Researcher's view of the corpus built by research/build.js and extract.js.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS } from './paths.js';

export function loadIndex() {
  const f = join(CORPUS, 'index.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
}

/** Items worth showing the Researcher: relevant extracted items, plus cite-only references. */
export function usable(index = loadIndex()) {
  return index.filter(i => i.extracted?.relevant || (i.source === 'reference'));
}

/** One short line per item, so the whole catalogue fits in a prompt. */
export function catalogue(index = loadIndex()) {
  return usable(index).map(i => {
    const e = i.extracted || {};
    const parts = [i.id, i.use, i.license, e.deviceType || '', (e.bodyParts || []).join('/'), e.functionalNeed || i.description || '', i.title];
    return parts.map(s => String(s).replace(/\s*\|\s*/g, ' ').slice(0, 110)).join(' | ');
  }).join('\n');
}

export function stats(index = loadIndex()) {
  const by = k => index.reduce((m, i) => ((m[i[k]] = (m[i[k]] || 0) + 1), m), {});
  return {
    total: index.length, bySource: by('source'), byUse: by('use'),
    extracted: index.filter(i => i.extracted && !i.extracted.prefiltered).length,
    relevant: usable(index).length,
  };
}
