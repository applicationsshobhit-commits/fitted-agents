// The Supervisor's code half: checks that need no judgment, run before and after
// each stage. The AI half (agents/supervisor.md) reviews what these cannot.
//
// Every flag carries a suggested way forward, so a problem never arrives without
// a next step.

const flag = (severity, stage, issue, suggestion, options = []) => ({ severity, stage, issue, suggestion, options, source: 'checks' });

/** Is this profile usable, and how far can its sizes be trusted? */
export function checkProfile(p) {
  const out = [];
  if (p?.schema !== 'fitted.body-profile/v1') return [flag('stop', 'capture', 'This is not a Fitted body profile.', 'Send the profile again from the capture page.')];
  if (p.bodyPart !== 'hand') out.push(flag('stop', 'capture', `Body part is "${p.bodyPart}"; only hands have designs so far.`, 'Capture a hand.'));
  const need = ['knuckleSpan', 'palmLength', 'handLength'];
  for (const k of need) if (!Number.isFinite(p.measurements?.[k]?.value)) out.push(flag('stop', 'capture', `Missing measurement: ${k}.`, 'Record again with the whole hand in view.'));
  if (!Number.isFinite(p.motion?.aperture?.max)) out.push(flag('stop', 'capture', 'Missing thumb-to-index opening.', 'Record again with the whole hand in view.'));

  if (p.scale?.method !== 'reference') {
    out.push(flag('warn', 'capture', 'Sizes are estimated from an average adult hand, not measured.',
      'Fine for a first look. For anything you print, recapture with a bank card held beside the hand and click Calibrate.',
      ['Continue with estimates', 'Recapture with a card']));
  }
  if (p.scale?.spreadPct > 15) {
    out.push(flag('warn', 'capture', `Calibration varied ${p.scale.spreadPct}% between frames.`,
      'Recapture with the palm and card flat to the camera, the same distance away.'));
  }
  if ((p.quality?.handFrames ?? 0) < 30) {
    out.push(flag('warn', 'capture', `Only ${p.quality?.handFrames ?? 0} frames had a hand in them.`,
      'Record for at least ten seconds: relaxed, open as wide as possible, then close.'));
  }
  if (p.quality?.frames && p.quality.handFrames / p.quality.frames < 0.5) {
    out.push(flag('warn', 'capture', `The hand was found in only ${Math.round(100 * p.quality.handFrames / p.quality.frames)}% of frames.`,
      'Tracking struggled. Try brighter light, a plain background, and the palm facing the camera. Very tight or curled hands may track poorly; that is a known risk.'));
  }
  const span = p.measurements?.knuckleSpan?.value;
  if (span && (span < 35 || span > 110)) {
    out.push(flag('warn', 'capture', `Knuckle span of ${span} mm is outside the usual 35–110 mm.`, 'Check the calibration, or recapture.'));
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
