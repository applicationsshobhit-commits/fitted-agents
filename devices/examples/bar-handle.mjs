// Example device: a straight cylindrical handle with a bore, built with LatheGeometry.
import * as THREE from 'three';

export const meta = {
  name: 'Bar handle',
  bodyPart: 'hand',
  purpose: 'A plain cylindrical handle that slides over a utensil; the simplest reference device.',
  parameters: {
    diameter: { unit: 'mm', min: 18, max: 50, default: 30, description: 'outside diameter' },
    length: { unit: 'mm', min: 50, max: 140, default: 90, description: 'length along the utensil' },
    bore: { unit: 'mm', min: 5, max: 14, default: 9, description: 'hole for the utensil handle' },
  },
};

export function build({ diameter, length, bore }) {
  const R = diameter / 2, r = bore / 2;
  // Closed profile: inner wall up, outer wall down, revolved around Y.
  const pts = [[r, 0], [R - 2, 0], [R, 2], [R, length - 2], [R - 2, length], [r, length], [r, 0]];
  const geo = new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), 96);
  geo.rotateZ(-Math.PI / 2);
  return geo;
}
