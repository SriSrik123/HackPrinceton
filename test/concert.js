import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { recordedViews } from './camera-poses.js';
import { addProjection } from '../src/projection.js';

const status = document.getElementById('status');
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#171b24');
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 1000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
let views = [];
let selected = null;
const selector = document.getElementById('view');
const cameraInfo = document.getElementById('camera-info');
const reference = document.getElementById('reference');
const compare = document.getElementById('compare');
const blend = document.getElementById('blend');
const referenceInfo = document.getElementById('reference-info');
let referenceReady = false;
let referenceRequest = 0;
const project = document.getElementById('project');
const distance = document.getElementById('panel-distance');
const inspectPanel = document.getElementById('inspect-panel');
const returnSeat = document.getElementById('return-seat');
const projectionInfo = document.getElementById('projection-info');
let projection = null;
let panel = null;
let panelTexture = null;
let panelView = null;
let panelIndex = '';

function clearProjection() {
  projection?.dispose();
  projection = null;
  if (panel) {
    panel.removeFromParent();
    panel.geometry.dispose();
    panel.material.dispose();
    panel = null;
  }
  panelTexture?.dispose();
  panelTexture = null;
}

function makeProjection(image) {
  clearProjection();
  panelView = selected;
  panelIndex = selector.value;
  panelTexture = new THREE.Texture(image);
  panelTexture.needsUpdate = true;
  const depth = Number(distance.value);
  const height = 2 * depth * Math.tan(THREE.MathUtils.degToRad(panelView.fov / 2));
  panel = new THREE.Mesh(
    new THREE.PlaneGeometry(height * panelView.aspect, height),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  const localPose = panelView.pose.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, -depth));
  localPose.decompose(panel.position, panel.quaternion, panel.scale);
  root.add(panel);
  root.updateMatrixWorld(true);
  const worldPose = root.matrixWorld.clone().multiply(panelView.pose);
  const position = new THREE.Vector3().setFromMatrixPosition(worldPose);
  const rotation = new THREE.Euler().setFromRotationMatrix(worldPose, 'YXZ');
  projection = addProjection(scene, panelTexture, [panel], {
    pos: position.toArray(), yaw: THREE.MathUtils.radToDeg(rotation.y),
    pitch: THREE.MathUtils.radToDeg(rotation.x), roll: THREE.MathUtils.radToDeg(rotation.z),
    fov: panelView.fov, near: 0.01, fade: 0.08, opacity: 1,
    shading: 0, brightness: 1, saturation: 1, tint: '#ffffff', enabled: project.checked,
  });
  project.disabled = false;
  inspectPanel.disabled = returnSeat.disabled = false;
  projectionInfo.textContent = `Panel ready for ${panelView.name}. Enable projection, then orbit to inspect.`;
}

project.onchange = () => {
  if (project.checked) {
    compare.checked = false;
    updateReference();
  }
  projection?.update({ enabled: project.checked });
};
distance.oninput = () => {
  document.getElementById('distance-value').textContent = Number(distance.value).toFixed(2);
  if (selected && referenceReady) makeProjection(reference);
};
inspectPanel.onclick = () => {
  if (!panel) return;
  const orientation = camera.quaternion.clone();
  controls.enabled = false;
  controls.enableDamping = false;
  controls.update(); // drain residual orbit damping before applying the recorded pose
  camera.quaternion.copy(orientation);
  camera.up.set(0, 1, 0).applyQuaternion(orientation);
  controls.target.copy(panel.getWorldPosition(new THREE.Vector3()));
  selected = null;
  selector.value = '';
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  controls.enabled = true;
  controls.update();
  controls.enableDamping = true;
  compare.checked = false;
  updateReference();
  cameraInfo.textContent = 'Orbiting the frozen projection panel. Drag sideways to see its flat surface.';
};
returnSeat.onclick = () => {
  selector.value = panelIndex;
  selectView();
};
function updateReference() {
  reference.hidden = !selected || !referenceReady || !compare.checked;
  reference.style.opacity = blend.value;
  document.getElementById('blend-value').textContent = `${Math.round(Number(blend.value) * 100)}%`;
  if (selected) {
    const width = Math.min(innerWidth, innerHeight * selected.aspect);
    const height = width / selected.aspect;
    Object.assign(reference.style, {
      width: `${width}px`, height: `${height}px`,
      left: `${(innerWidth - width) / 2}px`, top: `${(innerHeight - height) / 2}px`,
    });
  }
}
compare.onchange = updateReference;
blend.oninput = updateReference;
function loadReference() {
  const request = ++referenceRequest;
  referenceReady = false;
  compare.disabled = blend.disabled = true;
  updateReference();
  if (!selected) {
    referenceInfo.textContent = 'Select a recorded viewpoint to compare.';
    return;
  }
  const name = selected.name;
  referenceInfo.textContent = `Loading source: ${name}`;
  const image = new Image();
  image.onload = () => {
    if (request !== referenceRequest) return;
    reference.src = image.src;
    referenceReady = true;
    compare.disabled = blend.disabled = false;
    referenceInfo.textContent = '0% = splat, 100% = source photo. Look for doubled edges at 50%.';
    updateReference();
    try {
      makeProjection(image);
    } catch (error) {
      projectionInfo.textContent = `Projection setup failed: ${error.message}`;
      console.error('Projection setup failed', error);
    }
  };
  image.onerror = () => {
    if (request !== referenceRequest) return;
    referenceInfo.textContent = `Missing source photo: ${name}. Check the copied images folder.`;
    projectionInfo.textContent = 'Projection needs the source photo. Check the images folder.';
  };
  image.src = `/concert-test/${name.split('/').map(encodeURIComponent).join('/')}`;
}
function reset() {
  selected = null;
  selector.value = '';
  controls.enabled = true;
  camera.up.set(0, 1, 0);
  camera.fov = 60;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  camera.position.set(0, 1.5, 4);
  controls.target.set(0, 0, 0);
  controls.update();
  cameraInfo.textContent = 'Orbit mode';
  loadReference();
}
reset();
scene.add(new SparkRenderer({ renderer }));
const root = new THREE.Group();
scene.add(root);
document.getElementById('reset').onclick = reset;
document.getElementById('flip').onclick = () => {
  root.rotation.x = root.rotation.x === 0 ? Math.PI : 0;
  if (selected) selectView();
};

function selectView() {
  if (selector.value === '') { reset(); return; }
  selected = views[Number(selector.value)];
  projectionInfo.textContent = `Preparing projection for ${selected.name}...`;
  project.disabled = true;
  inspectPanel.disabled = returnSeat.disabled = true;
  clearProjection();
  controls.enabled = false;
  root.updateMatrixWorld(true);
  const pose = root.matrixWorld.clone().multiply(selected.pose);
  pose.decompose(camera.position, camera.quaternion, new THREE.Vector3());
  camera.fov = selected.fov;
  camera.aspect = selected.aspect;
  camera.updateProjectionMatrix();
  cameraInfo.textContent = `${selected.name} | vertical FOV ${selected.fov.toFixed(1)} degrees`;
  loadReference();
}
selector.onchange = selectView;

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

async function loadCameras() {
  try {
    const [meta, parser] = await Promise.all([
      json('/concert-test/transforms.json'), json('/concert-test/dataparser_transforms.json'),
    ]);
    views = recordedViews(meta, parser);
    selector.replaceChildren(new Option('Free orbit', ''));
    views.forEach((view, i) => selector.add(new Option(`${i + 1}: ${view.name}`, String(i))));
    selector.disabled = false;
    cameraInfo.textContent = `${views.length} recorded viewpoints ready. Choose one above.`;
  } catch (error) {
    cameraInfo.textContent = `Camera load failed: ${error.message}`;
    console.error(error);
  }
}
loadCameras();

async function load() {
  try {
    const splat = new SplatMesh({ url: '/concert-test/venue-test.spz' });
    root.add(splat);
    await splat.initialized;
    status.textContent = 'Loaded. Orbit and zoom to inspect the reconstructed table.';
  } catch (error) {
    status.textContent = `Load failed: ${error.message}. Check public/concert-test/venue-test.spz.`;
    console.error(error);
  }
}
load();
window.addEventListener('resize', () => {
  camera.aspect = selected ? selected.aspect : innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  updateReference();
});
renderer.setAnimationLoop(() => {
  if (controls.enabled) controls.update();
  projection?.update(0);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, innerWidth, innerHeight);
  renderer.clear();
  if (selected) {
    const width = Math.min(innerWidth, innerHeight * selected.aspect);
    const height = width / selected.aspect;
    const x = (innerWidth - width) / 2;
    const y = (innerHeight - height) / 2;
    renderer.setViewport(x, y, width, height);
    renderer.setScissor(x, y, width, height);
    renderer.setScissorTest(true);
  }
  renderer.render(scene, camera);
});
