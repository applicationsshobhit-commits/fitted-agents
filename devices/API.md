# Device module API

A device type is one ES module. The pipeline builds it, checks it, exports STL,
and renders it. Units are millimetres throughout.

```js
import * as THREE from 'three';

export const meta = {
  name: 'Strap-on spoon holder',
  bodyPart: 'hand',
  purpose: 'One sentence: what it does and who it is for.',
  // Every size the device takes. min/max are hard limits: values outside them
  // are flagged, never silently clamped. default is used when a value is missing.
  parameters: {
    width: { unit: 'mm', min: 40, max: 110, default: 70, description: 'inside width across the palm' },
  },
};

/** Return one BufferGeometry, or an array that prints as one part. */
export function build(p) {
  const geo = new THREE.BoxGeometry(p.width, 10, 30);
  return geo;
}
```

## Rules

- Only import `three` and its `three/examples/jsm/...` modules. No file or network access.
- Return closed solids. Open edges are counted; more than 50 is flagged.
- No dimension under 3 mm or over 300 mm.
- Keep it deterministic: same params, same geometry.
- Walls at least 2 mm thick for PLA/PETG, 2.5 mm for TPU.
- Put the build plate face on the XZ plane (y = 0) when the part has a flat side.

## Testing

    node <fitted-agents>/lib/try-device.js devices/my-device.mjs '{"width": 72}'

Prints size, volume, open edges and any problems. Exit 0 = clean, 2 = problems, 1 = crashed.

## Useful three.js shapes

| Shape | Use |
|---|---|
| `LatheGeometry(points, 96)` | Revolved handles and sleeves; close the profile to get a hole through it |
| `ExtrudeGeometry(shape, { depth })` | Flat profiles extruded: cuffs, clips, straps, holders |
| `TubeGeometry(curve, n, r, 24, false)` | Bent rods; cap ends yourself or overlap them into another part |
| `Shape` + `holes` | Slots and openings in extruded parts |

Overlap separate pieces by about 1 mm so they print as one part.
