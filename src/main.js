import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { StereoEffect } from "three/addons/effects/StereoEffect.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

import { loadConfig } from "./config.js";
import { LookControls } from "./lookControls.js";
import { addProjection } from "./projection.js";

const cfg = loadConfig();
const WORLD_DIR = "./world/";
const statusEl = document.getElementById("status");
const setStatus = (msg) => { statusEl.textContent = msg; console.log("[party]", msg); };

// ---------------------------------------------------------------------------
// Renderer, scene, camera
// ---------------------------------------------------------------------------
// antialias off: Spark's docs say MSAA doesn't help splats and costs a lot of performance.
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType("local"); // seated / head rotation, no floor tracking needed
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 1000);

// The rig is the "original camera spot". In WebXR three.js applies the headset pose relative
// to the camera's parent, so moving/rotating the rig moves the VR viewer too.
const rig = new THREE.Group();
rig.name = "rig";
rig.rotation.y = THREE.MathUtils.degToRad(cfg.yaw);
rig.add(camera);
scene.add(rig);

const spark = new SparkRenderer({ renderer });
scene.add(spark);

// world (axis flip) > metric (scale + ground offset) > splat + collider
const world = new THREE.Group();
world.name = "world";
if (cfg.flip) world.quaternion.set(1, 0, 0, 0); // 180 deg around X, same as Spark's example
const metric = new THREE.Group();
metric.name = "metric";
world.add(metric);
scene.add(world);

const look = new LookControls(camera, rig, renderer.domElement);
let stereo = null; // StereoEffect when in Cardboard fallback mode
let projection = null;
let video = null;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
async function loadWorldJson() {
  const res = await fetch(WORLD_DIR + "world.json");
  if (!res.ok) throw new Error("No public/world/world.json yet. Run: npm run marble -- path/to/video.mp4");
  return res.json();
}

function applyMetric(meta) {
  const m = meta?.semantics_metadata;
  if (!cfg.metricScale || !m?.metric_scale_factor) return;
  // Order from World Labs' rendering-spz doc: scale, subtract ground offset from Y, then axis flip.
  metric.scale.setScalar(m.metric_scale_factor);
  metric.position.y = -(m.ground_plane_offset ?? 0);
}

async function loadSplat() {
  const url = WORLD_DIR + `splat-${cfg.splat}.spz`;
  setStatus(`Loading splat (${cfg.splat})...`);
  const splat = new SplatMesh({ url });
  splat.name = "splat";
  metric.add(splat);
  await splat.initialized;
  return splat;
}

async function loadCollider() {
  try {
    const gltf = await new GLTFLoader().loadAsync(WORLD_DIR + "collider.glb");
    const surfaces = gltf.scene;
    surfaces.name = "surfaces";
    if (cfg.colliderFlip) surfaces.quaternion.set(1, 0, 0, 0);
    surfaces.traverse((o) => {
      if (!o.isMesh) return;
      if (cfg.debug) {
        o.material = new THREE.MeshBasicMaterial({ color: 0x00ff88, wireframe: true, transparent: true, opacity: 0.35 });
        o.visible = true;
      } else {
        o.visible = false; // hidden; the projection decides what to show
      }
    });
    metric.add(surfaces);
    return surfaces;
  } catch (e) {
    console.warn("collider.glb missing or failed to load", e);
    return new THREE.Group();
  }
}

async function loadVideo(meta) {
  if (!meta?.video) return null;
  const v = document.createElement("video");
  v.src = WORLD_DIR + meta.video;
  v.crossOrigin = "anonymous";
  v.loop = true;
  v.playsInline = true; // iOS: don't jump to fullscreen player
  v.preload = "auto";
  await new Promise((resolve) => {
    v.addEventListener("loadedmetadata", resolve, { once: true });
    v.addEventListener("error", resolve, { once: true });
  });
  return v;
}

function placeViewer() {
  scene.updateMatrixWorld(true);
  if (cfg.cam === "origin") {
    // where the raw Marble origin ends up after flip/scale/offset
    rig.position.copy(metric.localToWorld(new THREE.Vector3(0, 0, 0)));
  } else {
    rig.position.fromArray(cfg.cam);
  }
}

// ---------------------------------------------------------------------------
// Modes: desktop drag, Android WebXR (VRButton), Cardboard fallback (StereoEffect + gyro)
// ---------------------------------------------------------------------------
async function playVideo() {
  if (!video) return;
  try { await video.play(); } catch (e) { console.warn("video.play() blocked", e); }
}

async function startCardboard() {
  // Start the video (and its sound) inside the tap, before the iPhone motion-permission prompt:
  // iOS Safari can drop the user gesture across that await and then block play() with sound.
  playVideo();
  try {
    await look.enableGyro();
  } catch (e) {
    setStatus(e.message);
    return;
  }
  stereo = new StereoEffect(renderer);
  stereo.setEyeSeparation(cfg.eyeSep);
  stereo.setSize(window.innerWidth, window.innerHeight);
  document.body.classList.add("cardboard");
  document.documentElement.requestFullscreen?.().catch(() => {}); // not supported on iPhone, fine
  screen.orientation?.lock?.("landscape").catch(() => {});
  setStatus("");
}

function exitCardboard() {
  stereo = null;
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
  document.body.classList.remove("cardboard");
  document.exitFullscreen?.().catch(() => {});
}

function setupUi() {
  document.getElementById("btn-start").onclick = () => { playVideo(); document.getElementById("btn-start").remove(); };
  document.getElementById("btn-cardboard").onclick = startCardboard;
  document.getElementById("btn-exit").onclick = exitCardboard;
  // in Cardboard mode, tapping the screen recenters (useful after putting the phone in the viewer)
  renderer.domElement.addEventListener("click", () => { if (stereo) look.recenter(); });

  const vrButton = VRButton.createButton(renderer);
  vrButton.id = "VRButton";
  document.body.appendChild(vrButton);
  renderer.xr.addEventListener("sessionstart", () => { playVideo(); exitCardboard(); });
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  if (stereo) stereo.setSize(window.innerWidth, window.innerHeight);
  else renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  if (!renderer.xr.isPresenting) look.update(); // WebXR drives the camera itself
  projection?.update?.(dt);
  if (stereo && !renderer.xr.isPresenting) stereo.render(scene, camera);
  else renderer.render(scene, camera);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main() {
  setupUi();
  if (cfg.debug) scene.add(new THREE.AxesHelper(1));

  let meta = null;
  try {
    meta = await loadWorldJson();
  } catch (e) {
    setStatus(e.message);
    return;
  }
  applyMetric(meta);

  const [, surfaces, vid] = await Promise.all([
    loadSplat().catch((e) => { setStatus("Splat failed to load: " + e.message); throw e; }),
    loadCollider(),
    loadVideo(meta),
  ]);
  video = vid;
  placeViewer();

  projection = addProjection(scene, video, surfaces, { camera, rig, config: cfg, world: meta });

  setStatus(meta.caption ? `Loaded: ${meta.caption}` : "Loaded");
  setTimeout(() => setStatus(""), 4000);

  // handy in the browser console while debugging
  Object.assign(window, { THREE, scene, camera, rig, world, metric, renderer, cfg, video });
}

main();
