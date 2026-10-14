// Checks the parts of the pipeline that need no model: profile checks, building,
// licence checks, and the budget arithmetic. `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkProfile, checkBuilt, checkSources } from './checks.js';
import { buildDesign, baseline, BUILTINS } from './devices.js';
import { summarizeUsage } from './budget.js';
import { ROOT } from './paths.js';

const profile = {
  schema: 'fitted.body-profile/v1', bodyPart: 'hand', side: 'right',
  scale: { method: 'reference', reference: 'card', spreadPct: 3 },
  measurements: { knuckleSpan: { value: 61, unit: 'mm' }, palmLength: { value: 98, unit: 'mm' }, handLength: { value: 190, unit: 'mm' } },
  motion: { aperture: { min: 40, max: 110, unit: 'mm' } },
  quality: { frames: 300, handFrames: 290 },
};

test('a calibrated, well-tracked profile raises no flags', () => {
  assert.deepEqual(checkProfile(profile), []);
});

test('an estimated profile warns but does not stop', () => {
  const flags = checkProfile({ ...profile, scale: { method: 'estimated' } });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].severity, 'warn');
});

const knee = {
  schema: 'fitted.body-profile/v1', bodyPart: 'knee', side: 'left', source: 'video',
  scale: { method: 'reference', reference: { label: 'card', mm: 85.6 }, spreadPct: 4 },
  measurements: {
    thighLength: { value: 420, unit: 'mm', source: 'camera' }, shinLength: { value: 380, unit: 'mm', source: 'camera' },
    thighCircumference: { value: 480, unit: 'mm', source: 'tape' }, kneeCircumference: { value: 370, unit: 'mm', source: 'tape' },
    calfCircumference: { value: 340, unit: 'mm', source: 'tape' },
  },
  motion: { kneeBend: { min: 8, max: 115, unit: 'deg' } },
  quality: { frames: 300, trackedFrames: 270 },
};

test('a complete knee profile raises no flags', () => {
  assert.deepEqual(checkProfile(knee, 'knee'), []);
});

test('a knee profile without tape warns about the missing circumferences', () => {
  const { thighCircumference, calfCircumference, ...rest } = knee.measurements;
  const flags = checkProfile({ ...knee, measurements: rest }, 'knee');
  assert.equal(flags.length, 1);
  assert.match(flags[0].issue, /thigh.*calf/);
});

test('a profile for the wrong body part stops the run', () => {
  const flags = checkProfile(knee, 'elbow');
  assert.equal(flags[0].severity, 'stop');
});

test('a tape reading in the wrong units is flagged', () => {
  const flags = checkProfile({ ...knee, measurements: { ...knee.measurements, kneeCircumference: { value: 37, unit: 'mm', source: 'tape' } } }, 'knee');
  assert.ok(flags.some(f => /units/.test(f.suggestion)));
});

test('a tape-only "other" profile needs at least one measurement', () => {
  const other = { schema: 'fitted.body-profile/v1', bodyPart: 'other', side: 'none', source: 'tape', description: 'neck', scale: { method: 'none' }, measurements: {}, motion: {}, quality: { frames: 0, trackedFrames: 0 } };
  assert.ok(checkProfile(other, 'other').some(f => f.severity === 'stop'));
  const ok = { ...other, scale: { method: 'tape' }, measurements: { neck: { value: 340, unit: 'mm', source: 'tape', label: 'Around the neck' } } };
  assert.deepEqual(checkProfile(ok, 'other'), []);
});

test('a profile missing measurements stops the run', () => {
  const flags = checkProfile({ ...profile, measurements: {} });
  assert.ok(flags.some(f => f.severity === 'stop'));
});

test('every built-in device builds a closed solid from the baseline sizes', async () => {
  const base = await baseline(profile);
  for (const id of Object.keys(BUILTINS)) {
    const { why, ...params } = base[id];
    const r = await buildDesign({ device: id, params });
    assert.deepEqual(r.problems, [], id);
    assert.equal(r.report.openEdges, 0, id);
  }
});

test('out-of-range sizes are flagged, not clamped', async () => {
  const r = await buildDesign({ device: 'built-up-grip', params: { outerDiameter: 60, length: 90, boreDiameter: 9 } });
  assert.equal(r.params.outerDiameter, 60);
  assert.ok(r.problems.some(p => p.includes('outerDiameter')));
});

test('the example device module builds from the library folder', async () => {
  const r = await buildDesign({ device: 'examples/bar-handle.mjs', params: {} });
  assert.deepEqual(r.report.sizeMm, [90, 30, 30]);
});

test('device modules outside the run or library are refused', async () => {
  await assert.rejects(buildDesign({ device: '../../etc/passwd', params: {} }, join(ROOT, 'data')), /unknown device/);
});

test('a failed build is flagged with a way forward', () => {
  const design = { designs: [{ id: 'a', name: 'A', kind: 'new', params: {} }] };
  const flags = checkBuilt(design, [{ id: 'a', ok: false, error: 'boom' }]);
  assert.ok(flags.some(f => f.severity === 'stop'));
  assert.ok(flags.every(f => f.suggestion));
});

test('adapting a cite-only source is flagged', () => {
  const design = { designs: [{ id: 'a', name: 'A', sources: [{ id: 'who', use: 'adapt' }] }] };
  const flags = checkSources(design, [{ id: 'who', title: 'WHO', license: 'CC-BY-NC-SA-3.0-IGO', use: 'cite' }]);
  assert.ok(flags.some(f => f.severity === 'warn'));
});

test('usage rows add up across models', () => {
  const u = summarizeUsage({
    a: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 20 },
    b: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  }, 0.5);
  assert.equal(u.fresh, 37);
  assert.equal(u.cacheRead, 100);
});

test('agent prompt files parse', () => {
  for (const name of ['researcher', 'designer', 'supervisor', 'extractor']) {
    const raw = readFileSync(join(ROOT, 'agents', `${name}.md`), 'utf8');
    assert.match(raw, /^---\n(?:.*\n)*?model: \w+/);
  }
});
