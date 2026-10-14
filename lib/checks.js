// The Supervisor's code half: checks that need no judgment, run before and after
// each stage. The AI half (agents/supervisor.md) reviews what these cannot.
//
// Every flag carries a suggested way forward, so a problem never arrives without
// a next step.

import { BODY_PARTS, labelFor } from './bodyparts.js';

const flag = (severity, stage, issue, suggestion, options = []) => ({ severity, stage, issue, suggestion, options, source: 'checks' });

/**
 * Is this profile usable, and how far can its sizes be trusted?
 * `expected` is the body part the run was started for.
 */
export function checkProfile(p, expected = p?.bodyPart) {
  const out = [];
  if (p?.schema !== 'fitted.body-profile/v1') return [flag('stop', 'capture', 'This is not a Fitted body profile.', 'Send the profile again from the capture page.')];
  const def = BODY_PARTS[p.bodyPart];
  if (!def) return [flag('stop', 'capture', `Unknown body part "${p.bodyPart}".`, 'Capture again from the run\'s link.')];
  if (expected && p.bodyPart !== expected) {
    return [flag('stop', 'capture', `This run is for the ${BODY_PARTS[expected]?.label.toLowerCase()}, but the profile is for the ${def.label.toLowerCase()}.`, 'Capture again from the run\'s link, which sets the body part.')];
  }
  const m = p.measurements || {};
  const name = def.label.toLowerCase();

  // What the camera should have produced.
  if (def.tracker === 'hand') {
    for (const k of ['knuckleSpan', 'palmLength', 'handLength']) if (!Number.isFinite(m[k]?.value)) out.push(flag('stop', 'capture', `Missing measurement: ${labelFor(k)}.`, 'Record again with the whole hand in view.'));
    if (!Number.isFinite(p.motion?.aperture?.max)) out.push(flag('stop', 'capture', 'Missing thumb-to-index opening.', 'Record again with the whole hand in view.'));
  } else if (def.tracker === 'pose' && p.source !== 'tape') {
    for (const k of Object.keys(def.angles)) {
      if (!Number.isFinite(p.motion?.[k]?.max)) out.push(flag('stop', 'capture', `Missing ${labelFor(k).toLowerCase()}.`, `Record again from the side with the ${def.points.join(', ')} in view.`));
    }
  }

  // Tape: required ones missing, or a profile with nothing at all.
  if (def.tracker === 'none' && !Object.keys(m).length) out.push(flag('stop', 'capture', 'No measurements were entered.', 'Enter at least one tape measurement.'));
  if (def.describe && !p.description) out.push(flag('warn', 'capture', 'No description of the body part or goal.', 'Add one in the run\'s notes, or capture again with a description.'));
  const missingTape = def.tape.filter(t => !t.optional && !Number.isFinite(m[t.key]?.value) || !t.optional && m[t.key] && m[t.key].source !== 'tape');
  if (missingTape.length) {
    out.push(flag('warn', 'capture', `No tape measurement for: ${missingTape.map(t => t.label.toLowerCase()).join(', ')}.`,
      `A device that wraps the ${name} needs these to fit. Measure with a soft tape and capture again; the Designer will otherwise have to guess.`,
      ['Continue without them', 'Recapture with tape measurements']));
  }

  // Scale and tracking quality, for parts filmed with a camera.
  const filmed = def.tracker !== 'none' && p.source !== 'tape';
  if (filmed && !['reference', 'measured'].includes(p.scale?.method)) {
    const cal = def.calibrateWith;
    out.push(flag('warn', 'capture', 'Camera lengths are estimated from an average body, not measured.',
      `Angles are still accurate. For real sizes, capture again and type in one measured length${cal ? ` (${cal.label.toLowerCase()})` : ''} in step 2. It takes a ruler and ten seconds.`,
      ['Continue with estimates', 'Recapture with a measured length']));
  }
  if (p.scale?.spreadPct > 15) {
    out.push(flag('warn', 'capture', `Calibration varied ${p.scale.spreadPct}% between frames.`,
      'Recapture with the limb and card flat to the camera, the same distance away.'));
  }
  const tracked = p.quality?.trackedFrames ?? p.quality?.handFrames ?? 0;
  if (filmed && tracked < 30) {
    out.push(flag('warn', 'capture', `Only ${tracked} frames had the ${name} fully in view.`,
      `Record for at least ten seconds. ${def.film || ''}`));
  }
  if (filmed && p.quality?.frames && tracked / p.quality.frames < 0.5) {
    out.push(flag('warn', 'capture', `The ${name} was tracked in only ${Math.round(100 * tracked / p.quality.frames)}% of frames.`,
      'Tracking struggled. Try brighter light, a plain background, and every joint in view. Tight or unusual joints may track poorly; that is a known risk, and tape measurements are the fallback.'));
  }

  // Values outside what a body plausibly measures: usually a slip of the tape or a bad calibration.
  const ranges = { ...def.ranges, ...Object.fromEntries(def.tape.map(t => [t.key, t.range])) };
  for (const [k, [lo, hi]] of Object.entries(ranges)) {
    const v = m[k]?.value;
    if (Number.isFinite(v) && (v < lo || v > hi)) {
      out.push(flag('warn', 'capture', `${labelFor(k)} of ${v} mm is outside the usual ${lo}–${hi} mm.`,
        m[k].source === 'tape' ? 'Check the tape reading and its units (cm or inches).' : 'Check the calibration, or recapture.'));
    }
  }
  return out;
}

/** After building: did every design produce a sane, printable part? */
export function checkBuilt(design, built) {
  const out = [];
  const byId = Object.fromEntries(built.map(b => [b.id, b]));
  for (const d of design.designs || []) {
    const b = byId[d.id];
    if (!b) { out.push(flag('warn', 'build', `${d.name}: was not built.`, 'Retry the build stage.')); continue; }
    if (!b.ok) {
      out.push(flag('warn', 'build', `${d.name}: the 3D model failed to build (${b.error}).`,
        d.kind === 'new' ? 'Retry the design stage so the Designer can fix its device module, or drop this design.' : 'Retry the build stage; if it fails again the built-in design code needs a look.',
        ['Retry design', 'Continue without it']));
      continue;
    }
    for (const p of b.problems) out.push(flag('warn', 'build', `${d.name}: ${p}.`, 'Retry the design stage with this note, or approve knowing the issue.'));
    for (const k of Object.keys(d.params || {})) {
      if (!d.why?.[k]) out.push(flag('info', 'design', `${d.name}: no reason recorded for ${k}.`, 'Ask the Designer to explain it, or accept the default.'));
    }
  }
  if (!built.some(b => b.ok)) out.push(flag('stop', 'build', 'No design built successfully.', 'Retry the design stage.', ['Retry design']));
  return out;
}

/** Sources a design leans on must be ones the licence policy lets it use. */
export function checkSources(design, corpusIndex) {
  const out = [];
  const byId = Object.fromEntries(corpusIndex.map(i => [i.id, i]));
  for (const d of design.designs || []) {
    for (const s of d.sources || []) {
      const item = byId[s.id || s];
      if (!item) { out.push(flag('info', 'design', `${d.name}: cites "${s.id || s}", which is not in the corpus.`, 'Treat that citation as unverified.')); continue; }
      if (item.use !== 'adapt' && s.use === 'adapt') {
        out.push(flag('warn', 'design', `${d.name}: adapts "${item.title}", whose licence (${item.license}) only allows citing it.`,
          'Keep the idea but do not copy its geometry, or drop the source.'));
      }
      if (/SA/i.test(item.license) && s.use === 'adapt') {
        out.push(flag('info', 'design', `${d.name}: adapts "${item.title}" (${item.license}).`,
          'If this design is shared or sold, it must carry the same share-alike licence and credit the source.'));
      }
    }
  }
  return out;
}
