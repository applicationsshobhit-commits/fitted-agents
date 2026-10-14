// Turns stored corpus text into the structured records the Researcher searches.
// Uses the extractor agent (Haiku), several documents per call, and caches the
// result in index.json, so each document is only ever extracted once.
//
//   node research/extract.js            # extract anything not yet extracted
//   node research/extract.js --limit 20 # stop after 20 documents
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS, DATA } from '../lib/paths.js';
import { runAgent } from '../lib/agent.js';

const INDEX = join(CORPUS, 'index.json');
const BATCH = 6;
const PER_DOC = 5000;
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;

// Zenodo search is broad; skip records with no assistive-technology words at all
// before spending a model call on them.
const ON_TOPIC = /assistive|disabilit|orthos|orthot|splint|grip|grasp|\bhand|prosthe|rehabilit|cerebral|palsy|utensil|adaptive|impair|accessib|wheelchair|dexterity|spastic|stroke|arthritis|switch|mobility/i;

const RECORD = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    relevant: { type: 'boolean' },
    deviceType: { type: ['string', 'null'], description: 'e.g. "utensil grip", "switch", "hand orthosis"' },
    bodyParts: { type: 'array', items: { type: 'string' } },
    functionalNeed: { type: ['string', 'null'], description: 'what the user cannot do that this helps with' },
    userRange: { type: ['string', 'null'], description: 'age, size or ability range stated' },
    useSetting: { type: ['string', 'null'] },
    materials: { type: ['string', 'null'], description: 'materials and bill of materials, briefly' },
    adjustability: { type: ['string', 'null'] },
    safetyWarnings: { type: ['string', 'null'] },
    evidence: { type: ['string', 'null'], description: 'testing or evaluation reported' },
    clinicalReview: { type: ['string', 'null'], description: 'any clinician involvement or review stated' },
    principles: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string', description: 'one sentence' },
  },
  required: ['id', 'relevant', 'bodyParts', 'principles', 'summary'],
};
const SCHEMA = { type: 'object', properties: { records: { type: 'array', items: RECORD } }, required: ['records'] };

const index = JSON.parse(readFileSync(INDEX, 'utf8'));
const save = () => writeFileSync(INDEX, JSON.stringify(index, null, 2));

const todo = [];
for (const item of index) {
  if (item.extracted || !item.file) continue;
  if (item.source === 'Zenodo' && !ON_TOPIC.test(`${item.title} ${item.description} ${item.topics.join(' ')}`)) {
    item.extracted = { relevant: false, summary: 'Skipped: no assistive-technology terms.', principles: [], bodyParts: [], prefiltered: true };
    continue;
  }
  todo.push(item);
}
save();
const work = todo.slice(0, LIMIT);
console.log(`${work.length} documents to extract (${todo.length} pending in total)`);

let done = 0;
for (let i = 0; i < work.length; i += BATCH) {
  const batch = work.slice(i, i + BATCH);
  const docs = batch.map(it => `<document id="${it.id}">\n${readFileSync(join(CORPUS, it.file), 'utf8').slice(0, PER_DOC)}\n</document>`).join('\n\n');
  try {
    const { output } = await runAgent({
      name: 'extractor', runId: 'corpus', cwd: DATA, schema: SCHEMA,
      task: `Extract one record per document. Ids: ${batch.map(b => b.id).join(', ')}\n\n${docs}`,
    });
    const byId = Object.fromEntries((output?.records || []).map(r => [r.id, r]));
    if (process.env.DEBUG) console.log(JSON.stringify(output).slice(0, 600));
    for (const it of batch) {
      if (byId[it.id]) { const { id, ...rest } = byId[it.id]; it.extracted = rest; done++; }
    }
    save();
    console.log(`  ${Math.min(i + BATCH, work.length)}/${work.length}`);
  } catch (err) {
    console.warn(`  batch ${i / BATCH + 1} failed: ${err.message}`);
  }
}
const relevant = index.filter(i => i.extracted?.relevant).length;
console.log(`Extracted ${done}. Relevant items in the corpus: ${relevant}.`);
