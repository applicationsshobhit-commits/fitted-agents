// Shows an STL file: interactive in the dashboard, still in render.html.
// Rendering the STL itself (not the code that made it) means every render shows
// exactly what will be printed, for built-in and new device types alike.
import * as THREE from 'three';
import { STLLoader } from '/vendor/three/examples/jsm/loaders/STLLoader.js';
import { OrbitControls } from '/vendor/three/examples/jsm/controls/OrbitControls.js';

export async function mountViewer(el, url, { interactive = true, width, height } = {}) {
  const w = width || el.clientWidth || 480, h = height || el.clientHeight || 360;
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: !interactive, alpha: true });
  renderer.setPixelRatio(interactive ? Math.min(devicePixelRatio, 2) : 1);
  renderer.setSize(w, h);
  el.replaceChildren(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a9a96, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(1, 1.4, 1.2); scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.8); rim.position.set(-1.2, 0.4, -1); scene.add(rim);

  const geo = new STLLoader().parse(await (await fetch(url)).arrayBuffer());
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  const center = geo.boundingBox.getCenter(new THREE.Vector3());
  geo.translate(-center.x, -center.y, -center.z);
  const size = geo.boundingBox.getSize(new THREE.Vector3()).length();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x2f9a8a, roughness: 0.65, metalness: 0.05, side: THREE.DoubleSide }));
  scene.add(mesh);

  // Fit the part's bounding sphere to whichever side of the view is tighter.
  const fov = 35, aspect = w / h, radius = size / 2;
  const halfV = THREE.MathUtils.degToRad(fov / 2);
  const halfH = Math.atan(Math.tan(halfV) * aspect);
  const dist = radius / Math.sin(Math.min(halfV, halfH)) * 1.08;
  const camera = new THREE.PerspectiveCamera(fov, aspect, size / 100, size * 20);
  camera.position.copy(new THREE.Vector3(0.95, 0.7, 1.1).normalize().multiplyScalar(dist));
  camera.lookAt(0, 0, 0);

  let controls = null;
  if (interactive) {
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
  } else {
    renderer.render(scene, camera);
  }
  return { renderer, dispose: () => { renderer.setAnimationLoop(null); renderer.dispose(); } };
}
