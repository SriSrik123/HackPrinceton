import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { addProjection } from '../src/projection.js';

const query = new URLSearchParams(location.search);
const folder = query.get('data') ?? 'athens-marble';
if (!/^[\w-]+$/.test(folder)) throw new Error('Invalid data folder');
const base = `/${folder}/`;
const videoFile = query.get('video') ?? null;
if (videoFile && !/^[\w.-]+$/.test(videoFile)) throw new Error('Video must be a filename in the data folder');
const status = document.getElementById('status');
const video = document.getElementById('source');
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#15151a');
scene.add(new SparkRenderer({ renderer }));
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.01, 2000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;
const world = new THREE.Group();
const metric = new THREE.Group();
world.add(metric);
scene.add(world);
let projection, collider, meta, locked = true;
const settings = {
  x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, fov: 50,
  opacity: 0.5, fade: 0.12, enabled: true, flip: true, colliderFlip: false,
};
function apply() {
  world.rotation.x = settings.flip ? Math.PI : 0;
  if (collider) collider.rotation.x = settings.colliderFlip ? Math.PI : 0;
  world.updateMatrixWorld(true);
  projection?.update({
    pos: [settings.x, settings.y, settings.z], yaw: settings.yaw,
    pitch: settings.pitch, roll: settings.roll, fov: settings.fov,
    opacity: settings.opacity, fade: settings.fade, enabled: settings.enabled,
  });
  if (locked && projection) {
    camera.position.copy(projection.cam.position);
    camera.quaternion.copy(projection.cam.quaternion);
    camera.fov = settings.fov;
    camera.updateProjectionMatrix();
  }
}
document.getElementById('seat').onclick = () => { locked = true; controls.enabled = false; apply(); };
document.getElementById('orbit').onclick = () => {
  locked = false;
  const forward = camera.getWorldDirection(new THREE.Vector3());
  controls.target.copy(camera.position).addScaledVector(forward, 5);
  controls.enabled = true;
  controls.update();
};
function download(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
document.getElementById('save').onclick = () => {
  if (!projection || !video.videoWidth) { status.textContent = 'Wait for the scene and source video to load.'; return; }
  download('alignment.json', {
    worldId: meta.world_id, dataFolder: folder, settings,
    transformNote: 'Camera is in preview world space. Apply the same flip, metric scale and ground offset to venue and collider before using this seat. Do not load this camera against raw Marble assets.',
    semantics_metadata: meta.semantics_metadata,
    cameras: { schemaVersion: 1, testOnly: false,
      coordinateSystem: { space: 'marble-preview-world', quaternion: 'camera-to-world, [x,y,z,w]', units: 'Marble metric metadata applied', fov: 'vertical degrees' },
      seats: [{ name: 'Valia', pos: projection.cam.position.toArray(), quat: projection.cam.quaternion.toArray(),
        fov: settings.fov, width: video.videoWidth, height: video.videoHeight,
        videoUrl: `${base}${videoFile ?? meta.video ?? 'source.mp4'}`, offsetSeconds: null }],
    },
  });
};
async function main() {
  const response = await fetch(base + 'world.json');
  if (!response.ok) throw new Error(`Missing ${base}world.json. Copy the generated assets first.`);
  meta = await response.json();
  const semantics = meta.semantics_metadata;
  if (semantics?.metric_scale_factor) {
    metric.scale.setScalar(semantics.metric_scale_factor);
    metric.position.y = -(semantics.ground_plane_offset ?? 0);
  }
  world.rotation.x = Math.PI;
  world.updateMatrixWorld(true);
  const origin = metric.localToWorld(new THREE.Vector3());
  Object.assign(settings, { x: origin.x, y: origin.y, z: origin.z });
  const splat = new SplatMesh({ url: base + 'splat-500k.spz' });
  metric.add(splat);
  const gltf = await new GLTFLoader().loadAsync(base + 'collider.glb');
  collider = gltf.scene;
  collider.traverse(object => { if (object.isMesh) object.visible = false; });
  metric.add(collider);
  video.src = base + (videoFile ?? meta.video ?? 'source.mp4');
  await Promise.all([splat.initialized, new Promise((resolve, reject) => {
    video.addEventListener('loadeddata', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error('Source video failed to load')), { once: true });
    if (video.readyState >= 2) resolve();
  })]);
  projection = addProjection(scene, video, collider, { shading: 0, near: 0.01 });
  const gui = new GUI({ title: 'Manual alignment' });
  ['x', 'y', 'z'].forEach(key => gui.add(settings, key).step(0.05).onChange(apply));
  ['yaw', 'pitch', 'roll'].forEach(key => gui.add(settings, key, -180, 180, 0.1).onChange(apply));
  gui.add(settings, 'fov', 10, 120, 0.1).name('vertical FOV').onChange(apply);
  gui.add(settings, 'opacity', 0, 1, 0.05).onChange(apply);
  gui.add(settings, 'fade', 0, 0.4, 0.01).onChange(apply);
  ['enabled', 'flip', 'colliderFlip'].forEach(key => gui.add(settings, key).onChange(apply));
  controls.enabled = false;
  const presetFile = query.get('preset');
  if (presetFile) {
    if (!/^[\w.-]+\.json$/.test(presetFile)) throw new Error('Invalid preset filename');
    const response = await fetch(base + presetFile);
    if (!response.ok) throw new Error('Alignment preset not found');
    const preset = await response.json();
    if (preset.worldId !== meta.world_id) throw new Error('Preset belongs to a different world');
    for (const key of Object.keys(settings)) {
      const value = preset.settings?.[key];
      if (typeof value === typeof settings[key] && (typeof value === 'boolean' || Number.isFinite(value))) settings[key] = value;
    }
    gui.controllersRecursive().forEach(c => c.updateDisplay());
  }
  apply();
  window.marbleAlignment = {
    set(patch) { Object.assign(settings, patch); apply(); gui.controllersRecursive().forEach(c => c.updateDisplay()); },
    get() { return { ...settings }; },
    bounds() { const box = new THREE.Box3().setFromObject(collider); return { min: box.min.toArray(), max: box.max.toArray() }; },
  };
  // Keep video framing independent of window shape; letterbox in the render loop.
  status.textContent = `Loaded world ${meta.world_id ?? ''}.\nUncalibrated starting pose: tune yaw/pitch/FOV first, then position. Download when visually aligned.`;
}
main().catch(error => { status.textContent = error.message; console.error(error); });
addEventListener('resize', () => renderer.setSize(innerWidth, innerHeight));
renderer.setAnimationLoop(() => {
  if (!locked) controls.update();
  projection?.update(0);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, innerWidth, innerHeight);
  renderer.clear();
  const aspect = locked && video.videoWidth ? video.videoWidth / video.videoHeight : innerWidth / innerHeight;
  const width = Math.min(innerWidth, innerHeight * aspect), height = width / aspect;
  camera.aspect = aspect; camera.updateProjectionMatrix();
  renderer.setViewport((innerWidth - width) / 2, (innerHeight - height) / 2, width, height);
  renderer.setScissor((innerWidth - width) / 2, (innerHeight - height) / 2, width, height);
  renderer.setScissorTest(true);
  renderer.render(scene, camera);
});
