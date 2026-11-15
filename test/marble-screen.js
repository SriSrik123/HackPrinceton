import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

const base = '/athens-marble/';
const video = document.getElementById('video');
const status = document.getElementById('status');
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
const screenScene = new THREE.Scene();
scene.background = new THREE.Color('#080810');
scene.add(new SparkRenderer({ renderer }));
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.01, 1000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan = false;
const texture = new THREE.VideoTexture(video);
texture.colorSpace = THREE.SRGBColorSpace;
const screen = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
  map: texture, side: THREE.DoubleSide, toneMapped: false, depthTest: false,
}));
// Render after the splat so generated geometry cannot cut holes in the video.
screen.renderOrder = 10000;
screen.position.set(0, 2.5, -7);
screenScene.add(screen);
const seats = [
  { name: 'Valia' },
  { name: 'Can' },
  { name: 'Krhtikos' },
];
let selected = 0, switching = 0;
function sizeScreen() {
  const width = Number(document.getElementById('size').value);
  screen.scale.set(width, width / (video.videoWidth / video.videoHeight || 16 / 9), 1);
}
function returnToSeat() {
  camera.position.fromArray(seats[selected].pos);
  camera.lookAt(screen.position);
  // Orbit around the viewer's head for seated looking, not around the screen.
  controls.target.copy(camera.position).add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(0.001));
  controls.enableZoom = false;
  controls.update();
}
async function selectSeat(index, autoplay = true) {
  const request = ++switching;
  const time = video.currentTime || 0;
  selected = index;
  video.pause();
  video.src = base + seats[index].file;
  status.textContent = `Loading ${seats[index].name}…`;
  document.querySelectorAll('#seats button').forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
  returnToSeat();
  await new Promise((resolve, reject) => {
    video.onloadeddata = resolve;
    video.onerror = () => reject(new Error('Could not load ' + seats[index].file));
    video.load();
  });
  if (request !== switching) return;
  video.currentTime = Math.min(time, Math.max(0, video.duration - 0.1));
  sizeScreen();
  const seat = seats[index];
  const location = seat.area ?? `Gate ${seat.gate}, Row ${seat.row}, Seat ${seat.seat}`;
  status.textContent = `${seat.name} · ${location} · position approximate · audio offset unknown`;
  if (autoplay) await video.play().catch(() => { status.textContent += ' · press Play'; });
}
seats.forEach((seat, i) => {
  const button = document.createElement('button');
  button.textContent = seat.name;
  button.onclick = () => selectSeat(i).catch(showError);
  document.getElementById('seats').append(button);
});
function showError(error) { status.textContent = error.message; }
document.getElementById('size').oninput = sizeScreen;
document.getElementById('view').onclick = returnToSeat;
document.getElementById('orbit').onclick = () => {
  controls.target.copy(screen.position);
  controls.enableZoom = true;
  controls.update();
};
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});
renderer.setAnimationLoop(() => {
  renderer.autoClear = true;
  renderer.render(scene, camera);
  // Spark uses the transparent render queue; draw the screen in a separate
  // pass so its opaque material cannot be covered by the venue splats.
  renderer.autoClear = false;
  renderer.clearDepth();
  renderer.render(screenScene, camera);
});
async function main() {
  const layoutResponse = await fetch('./athens-seat-layout.json');
  if (!layoutResponse.ok) throw new Error('Missing manual Athens seat layout');
  const layout = await layoutResponse.json();
  layout.seats.forEach((seat, index) => Object.assign(seats[index], seat));
  const response = await fetch(base + 'world.json');
  if (!response.ok) throw new Error('Missing Athens world assets');
  const meta = await response.json();
  const world = new THREE.Group();
  world.rotation.x = Math.PI;
  const metric = new THREE.Group();
  metric.scale.setScalar(meta.semantics_metadata?.metric_scale_factor ?? 1);
  metric.position.y = -(meta.semantics_metadata?.ground_plane_offset ?? 0);
  world.add(metric);
  scene.add(world);
  const splat = new SplatMesh({ url: base + 'splat-500k.spz' });
  metric.add(splat);
  await Promise.all([splat.initialized, selectSeat(0, false)]);
  window.marbleScreen = { selectSeat, screen, camera, video, seats };
}
main().catch(showError);
