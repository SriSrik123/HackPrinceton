import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { StereoEffect } from "three/addons/effects/StereoEffect.js";
import { SparkRenderer, SplatMesh, SplatEdit, SplatEditSdf, SplatEditSdfType, SplatEditRgbaBlendMode } from "@sparkjsdev/spark";

import { loadConfig } from "./config.js";
import { LookControls } from "./lookControls.js";
import { addProjection } from "./projection.js";
import { loadRotationTrack } from "./rotationTrack.js";
import { addSplatPaint } from "./splatPaint.js";
import { addDepthMesh } from "./depthMesh.js";
import { addTrackedPeople, loadTracks } from "./trackedPeople.js";
import { addFramingPanel, savedFraming } from "./framingPanel.js";
import { addCutout } from "./cutout.js";

const cfg = loadConfig();
const WORLD_DIR = `./${cfg.world}/`;
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

// WASD walk (desktop): W/S forward/back, A/D left/right, Q/E down/up, Shift = faster. Moves the
// rig along where the camera looks, flattened to the floor. P prints the spot as a ?cam= value.
const keys = new Set();
const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName);
window.addEventListener("keydown", (e) => {
  if (typing(e) || e.metaKey || e.ctrlKey) return;
  keys.add(e.code);
  if (e.code === "KeyP") console.log(`[party] ?cam=${rig.position.toArray().map((v) => v.toFixed(2)).join(",")}&yaw=${THREE.MathUtils.radToDeg(rig.rotation.y).toFixed(0)}`);
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => keys.clear());
const walkFwd = new THREE.Vector3(), walkRight = new THREE.Vector3(), walkMove = new THREE.Vector3();
function walk(dt) {
  if (!keys.size) return;
  camera.getWorldDirection(walkFwd);
  walkFwd.y = 0;
  if (walkFwd.lengthSq() < 1e-6) return;
  walkFwd.normalize();
  walkRight.set(-walkFwd.z, 0, walkFwd.x);
  walkMove.set(0, 0, 0);
  if (keys.has("KeyW") || keys.has("ArrowUp")) walkMove.add(walkFwd);
  if (keys.has("KeyS") || keys.has("ArrowDown")) walkMove.sub(walkFwd);
  if (keys.has("KeyD") || keys.has("ArrowRight")) walkMove.add(walkRight);
  if (keys.has("KeyA") || keys.has("ArrowLeft")) walkMove.sub(walkRight);
  if (keys.has("KeyE")) walkMove.y += 1;
  if (keys.has("KeyQ")) walkMove.y -= 1;
  if (walkMove.lengthSq() === 0) return;
  const speed = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 3 : 1.2; // metres per second
  rig.position.addScaledVector(walkMove.normalize(), speed * Math.min(dt, 0.1));
}
let stereo = null; // StereoEffect when in Cardboard fallback mode
let projection = null;
let depthMesh = null;                   // depth mesh (src/depthMesh.js), or null
let paint = null;                       // splat painting (src/splatPaint.js), or null
let people = null;                      // tracked people cards (src/trackedPeople.js), or null
let video = null;
let cutout = null;                      // cut-out person card (src/cutout.js), or null
let track = null;                       // per-frame camera rotation of a panning video, or null
const trackQuat = new THREE.Quaternion();
const trackMatrix = new THREE.Matrix4();

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

// ?cut=x,y,z,w,h,d;... hides every splat inside each box (viewer meters, see config.js).
function applyCuts(splat) {
  const boxes = cfg.cut.split(";").map((b) => b.trim()).filter(Boolean).map((b) => b.split(",").map(Number));
  if (!boxes.length) return;
  const edit = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, sdfSmooth: 0, softEdge: 0 });
  for (const [x, y, z, w, h, d] of boxes) {
    const sdf = new SplatEditSdf({ type: SplatEditSdfType.BOX, opacity: 0 });
    // Edits live in the splat's own frame, so convert the viewer-space box into it.
    scene.updateMatrixWorld(true);
    const c = new THREE.Vector3(x, y, z);
    splat.worldToLocal(scene.localToWorld(c)); // viewer space == scene space
    sdf.position.copy(c);
    const k = 1 / (metric.scale.x || 1);
    sdf.scale.set((w / 2) * k, (h / 2) * k, (d / 2) * k);
    edit.addSdf(sdf);
  }
  splat.add(edit);
  console.log(`[party] hiding ${boxes.length} box(es) of splat`);
}

async function loadSplat() {
  const url = WORLD_DIR + `splat-${cfg.splat}.spz`;
  setStatus(`Loading splat (${cfg.splat})...`);
  const splat = new SplatMesh({ url });
  splat.name = "splat";
  metric.add(splat);
  await splat.initialized;
  applyCuts(splat);
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
  if (!renderer.xr.isPresenting) walk(dt);
  if (track && video && projection) {
    if (cfg.anchor && track.sampleMatrix) {
      projection.aimMatrix(track.sampleMatrix(video.currentTime, projection.cam.position, rig.rotation.y, trackMatrix));
    } else {
      projection.aim(trackQuat, track.sample(video.currentTime, trackQuat));
    }
  }
  projection?.update?.(dt);
  paint?.update();
  depthMesh?.update();
  people?.update();
  cutout?.update();
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

  const [splat, surfaces, vid, rotation, tracks] = await Promise.all([
    loadSplat().catch((e) => { setStatus("Splat failed to load: " + e.message); throw e; }),
    loadCollider(),
    loadVideo(meta),
    cfg.track ? loadRotationTrack(WORLD_DIR + "rotation.json") : null,
    cfg.people ? loadTracks(WORLD_DIR + "tracks.json") : null,
  ]);
  video = vid;
  placeViewer();

  projection = addProjection(scene, video, surfaces, { camera, rig, config: cfg, world: meta });

  // Cut-out person: world.json "cutout" {at: [x, z], height} plays meta.video (stacked alpha) on a
  // card standing in the room instead of projecting it. ?cutout=x,z and ?cutoutH=1.7 move and size it.
  if (meta.cutout && video) {
    projection.update({ enabled: false });
    const at = cfg.cutout ? cfg.cutout.split(",").map(Number) : meta.cutout.at;
    cutout = addCutout(scene, video, { at, height: cfg.cutoutH || meta.cutout.height, viewer: rig });
  }

  // Start spot: world.json "start" [x, z] or ?start=x,z moves the viewer off the Marble origin
  // (metres, +x = right, -z = ahead). Placed after the cutout so she stays put in the room.
  const start = cfg.start ? cfg.start.split(",").map(Number) : meta.start;
  if (Array.isArray(start) && start.every(Number.isFinite)) {
    rig.position.add(new THREE.Vector3(start[0], 0, start[1]).applyAxisAngle(new THREE.Vector3(0, 1, 0), rig.rotation.y));
  }

  // A panning video: the projector follows the camera's tracked rotation (npm run track).
  track = rotation;
  if (track) {
    console.log(`[party] rotation track loaded, ${track.duration.toFixed(1)} s, ${track.vfov} degree vertical FOV (${track.source})`);
    // Aim the projector for the video's first frame, unless the URL tunes it by hand.
    const url = new URLSearchParams(location.search);
    const aimAt = {};
    if (!url.has("projFov")) aimAt.fov = track.vfov;
    // Marble's room is close to the video but not identical, so blend the frame's edge wider.
    if (!url.has("projFade")) aimAt.fade = 0.25;
    if (track.base) {
      if (!url.has("projYaw")) aimAt.yaw = cfg.yaw + track.base.yaw;
      if (!url.has("projPitch")) aimAt.pitch = track.base.pitch;
      if (!url.has("projRoll")) aimAt.roll = track.base.roll;
    }
    projection.update(aimAt);
  }

  // Paint mode: the video colours the room's splats, so the overlay layer is switched off.
  // (Not with the depth mesh: its cut-outs would show the smeared paint instead of the clean room.)
  // Tracked people (npm run track-people): each person is a cut-out card in the room instead of the
  // whole frame on the walls. Paint and the depth mesh would draw the people a second time, so they stay off.
  const usePeople = !!(tracks && video);
  const useDepth = !usePeople && !!(cfg.depth && meta.depth && video);
  const wantPaint = !usePeople && !useDepth && (new URLSearchParams(location.search).has("paint") ? cfg.paint : (cfg.paint || meta.paint));
  if (wantPaint && video) {
    // The painted splats carry the colour; the drawn layer stays on at half strength for sharpness
    // (the Framing panel's "Overlay layer" slider, ?projOverlay=0 for paint only).
    paint = addSplatPaint(splat, projection);
    console.log("[party] painting the video into the splats");
  }

  // Depth mesh: the video at the depths measured by scripts/depth-video.py (opt in with ?depth=1).
  if (useDepth) {
    try {
      depthMesh = await addDepthMesh(scene, projection, video, { base: WORLD_DIR, meta: meta.depth, scale: cfg.depthScale });
      console.log("[party] depth mesh on");
    } catch (e) {
      console.warn("[party] depth mesh failed, keeping the flat overlay", e);
    }
  }

  if (usePeople) {
    try {
      people = await addTrackedPeople(scene, projection, video, { base: WORLD_DIR, tracks, depth: meta.depth, scale: cfg.depthScale });
      console.log(`[party] ${tracks.tracks.length} tracked people in the room`);
    } catch (e) {
      console.warn("[party] tracked people failed, keeping the flat overlay", e);
    }
  }

  // Framing: where the video sits in the room and how it looks. Lowest to highest priority:
  // projection.js defaults, the rotation track, world.json "projection", what the Framing panel
  // saved in this browser, then ?proj... in the URL.
  if (video) {
    const url = new URLSearchParams(location.search);
    const fromUrl = (key) => url.has("proj" + key[0].toUpperCase() + key.slice(1));
    const keep = (obj) => Object.fromEntries(Object.entries(obj ?? {}).filter(([key]) => !fromUrl(key)));
    const paintDefaults = wantPaint ? keep({ overlay: 0.5 }) : {};
    const initial = { ...projection.params, ...paintDefaults, ...keep(meta.projection) };
    delete initial.pos; // the panel never moves the projector off the viewer's spot
    projection.update({ ...paintDefaults, ...keep(meta.projection), ...keep(savedFraming(cfg.world)) });
    if (people || cutout) projection.update({ enabled: false }); // the framing reset above must not bring the overlay back
    addFramingPanel(projection, { world: cfg.world, initial, viewer: { camera, rig }, paint: !!wantPaint });
  }

  setStatus(meta.caption ? `Loaded: ${meta.caption}` : "Loaded");
  setTimeout(() => setStatus(""), 4000);

  // handy in the browser console while debugging
  Object.assign(window, { cutout, paint, depthMesh, people, THREE, scene, camera, rig, world, metric, renderer, cfg, video, projection, track, look });
}

main();
