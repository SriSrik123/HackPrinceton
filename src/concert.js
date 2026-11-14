// Concert mode (KAN-14): stand at one of the seats where fans filmed, look around, and jump to
// another seat by looking at its marker. Each seat shows its own clip, projected onto the stage
// from that seat's spot. All clips play from one master clock (src/masterClock.js).
//
// Data (all optional while the venue is being built; the page falls back to a dummy scene):
//   public/concert/cameras.json   seats, see src/seats.js (Neven's scripts/export-cameras.mjs writes it)
//   public/concert/stage.glb      invisible stage panel (and floor) the clips are projected onto
//   public/concert/venue.spz      the venue splat that fills in around the projection (venue-test.spz also works)
// Without stage.glb, each real seat projects onto its own flat panel ?panelDist in front of it.
//
// URL options: ?data=concert-test read another folder of public/ · ?seat=N start seat (1-based) ·
// ?t=SECONDS start master time · ?video=URL use one real video for every seat without one ·
// ?reveal=0 skips the video-only intro (default: only the video rectangle shows until the first tap after Start, then the venue fades in) · ?dwell=1.5 gaze seconds · ?autoplay=1 start the clock on load · ?venueFlip=1 rotate venue, stage and
// seats together 180 degrees around X · ?panelDist=1 stand-in panel distance (scene units) ·
// ?markerScale= seat marker size (default from the seat spacing) · ?debug=1 wireframes + frustum + readout.
// Per-projection options from src/projection.js (?projFov=...) also apply to every seat.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { StereoEffect } from "three/addons/effects/StereoEffect.js";
import { VideoClip } from "./videoClip.js";
import { SeatTransition } from "./seatTransition.js";
import { LookControls } from "./lookControls.js";
import { addProjection } from "./projection.js";
import { MasterClock, clipTime } from "./masterClock.js";
import { parseSeats, dummySeats, verticalFov, seatSpacing } from "./seats.js";

const params = new URLSearchParams(location.search);
const DATA_DIR = /^[\w-]+$/.test(params.get("data") ?? "") ? `./${params.get("data")}/` : "./concert/"; // a folder name only
const num = (key, fallback) => (params.has(key) && Number.isFinite(Number(params.get(key))) ? Number(params.get(key)) : fallback);
const opt = {
  seat: num("seat", 1) - 1,
  t: num("t", 0),
  dwell: num("dwell", 0), // opt in; Cardboard defaults to explicit screen taps
  reveal: num("reveal", 1), // 0 = show the venue right away; otherwise the video shows alone until the first tap after Start
  video: params.get("video"),
  autoplay: params.get("autoplay") === "1",
  venueFlip: params.get("venueFlip") === "1",
  panelDist: num("panelDist", 1),
  markerScale: num("markerScale", null),
  debug: params.get("debug") === "1",
};
const rad = THREE.MathUtils.degToRad;
let markerScale = 1;
const REVEAL_FADE = 1.5; // seconds the venue and markers take to fade in
let venue = null;
let revealT = opt.reveal > 0 ? null : Infinity; // null until the reveal tap, then seconds since it
const beginReveal = () => { if (revealT === null && clock.playing) revealT = 0; };
const COOLDOWN = 1.0; // seconds after a jump before the next gaze selection can fire

const statusEl = document.getElementById("status");
const setStatus = (msg) => { statusEl.textContent = msg; };

// ---------------------------------------------------------------------------
// Renderer, scene, camera, rig (same setup as the party viewer)
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType("local");
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07070b);
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 1000);
const rig = new THREE.Group(); // the viewer's seat: moved on every jump
rig.add(camera);
scene.add(rig);

const look = new LookControls(camera, rig, renderer.domElement);
const clock = new MasterClock();
let stereo = null;

// ---------------------------------------------------------------------------
// Clips: what a seat plays. A real video, or a fake clip that draws its own clip time.
// ---------------------------------------------------------------------------
// Stand-in for a clip while there is no footage: shows the seat name and its own clip time, so the
// master clock and offsets can be seen working.
class FakeClip {
  // aspect: the seat's frame shape (portrait clips are < 1), so the fake frame covers the same area
  constructor(label, hue, aspect = 16 / 9) {
    this.label = label;
    this.hue = hue;
    const [W, H] = aspect >= 1 ? [1280, Math.round(1280 / aspect)] : [Math.round(1280 * aspect), 1280];
    this.canvas = Object.assign(document.createElement("canvas"), { width: W, height: H });
    this.source = new THREE.CanvasTexture(this.canvas);
    this.lastTenth = NaN;
  }
  sync(t) {
    if (t < 0) return "before";
    const tenth = Math.floor(t * 10);
    if (tenth !== this.lastTenth) {
      this.lastTenth = tenth;
      const { width: W, height: H } = this.canvas;
      const u = Math.min(W, H) / 720; // text and grid scale with the short side
      const g = this.canvas.getContext("2d");
      g.fillStyle = `hsl(${this.hue} 55% 28%)`;
      g.fillRect(0, 0, W, H);
      g.strokeStyle = "#fff4";
      g.lineWidth = 2;
      for (let x = 0; x <= W; x += 80 * u) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
      for (let y = 0; y <= H; y += 80 * u) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
      g.fillStyle = "#fff";
      g.textAlign = "center";
      g.font = `bold ${Math.round(Math.min(150 * u, (W * 0.9) / Math.max(4, this.label.length) * 1.8))}px sans-serif`;
      g.fillText(this.label, W / 2, H / 2 - 60 * u);
      g.font = `bold ${Math.round(100 * u)}px monospace`;
      g.fillText(`clip ${t.toFixed(1)} s`, W / 2, H / 2 + 100 * u);
      g.fillStyle = "#ffd84a"; // a bar that sweeps once every 10 clip seconds
      g.fillRect(((t % 10) / 10) * (W - 100 * u), H / 2 + 200 * u, 100 * u, 60 * u);
      this.source.needsUpdate = true;
    }
    return "playing";
  }
}

// ---------------------------------------------------------------------------
// Loading: seats, stage surfaces, venue splat
// ---------------------------------------------------------------------------
const isHtml = (res) => (res.headers.get("content-type") || "").includes("html"); // dev server answers unknown paths with index.html

async function loadSeats() {
  try {
    const res = await fetch(DATA_DIR + "cameras.json", { headers: { Accept: "application/json" } });
    if (!res.ok || isHtml(res)) return { seats: dummySeats(opt.video), dummy: true };
    const data = await res.json();
    return { seats: parseSeats(data, { flip: opt.venueFlip, requireOffsets: !data.testOnly }), dummy: false, production: !data.testOnly };
  } catch (e) {
    if (e instanceof SyntaxError || /Seat|cameras\.json/.test(e.message)) throw e; // a broken file should be loud
    return { seats: dummySeats(opt.video), dummy: true };
  }
}

// The stage panel the clips are projected onto. Hidden unless ?debug=1; projection.js makes the
// hidden meshes catch the video. Real seats without a stage.glb get null here and a panel each
// (seatPanel), because the dummy stage below is sized in meters for the dummy seats.
async function loadStage(dummy) {
  if (!dummy) {
    try {
      const head = await fetch(DATA_DIR + "stage.glb", { method: "HEAD" });
      if (!head.ok || isHtml(head)) return null;
      const gltf = await new GLTFLoader().loadAsync(DATA_DIR + "stage.glb");
      gltf.scene.traverse((o) => { if (o.isMesh) o.visible = false; });
      if (opt.venueFlip) gltf.scene.quaternion.set(1, 0, 0, 0); // same frame as the venue and seats
      scene.add(gltf.scene);
      return gltf.scene;
    } catch (e) {
      console.warn("[concert] stage.glb failed to load; using a panel in front of each seat", e);
      return null;
    }
  }
  const group = new THREE.Group();
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(8, 4.5), new THREE.MeshBasicMaterial());
  panel.position.set(0, 2.25, -8);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.MeshBasicMaterial());
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, -3);
  group.add(panel, floor);
  group.children.forEach((m) => {
    if (opt.debug) { m.material = new THREE.MeshBasicMaterial({ color: 0x00ff88, wireframe: true, transparent: true, opacity: 0.3 }); }
    else m.visible = false;
  });
  scene.add(group);
  // something to look at around the stage so the dummy scene is not a black void
  const grid = new THREE.GridHelper(14, 14, 0x445, 0x223);
  grid.position.set(0, 0.01, -3);
  scene.add(grid);
  [[-5, 0.5, -6], [5, 0.5, -6], [-6, 0.5, 2], [6, 0.5, 2], [0, 0.5, 5]].forEach(([x, y, z], i) => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(i / 5, 0.4, 0.3) }));
    box.position.set(x, y, z);
    scene.add(box);
  });
  return group;
}

// The venue splat (venue.spz, or Neven's venue-test.spz). It shares the seats' frame (both come out
// of the same splatfacto run), so it is not moved. ?venueFlip=1 turns venue, stage and seats together.
async function loadVenue() {
  try {
    let file = null;
    for (const name of ["venue.spz", "venue-test.spz"]) {
      const head = await fetch(DATA_DIR + name, { method: "HEAD" });
      if (head.ok && !isHtml(head)) { file = name; break; }
    }
    if (!file) return null;
    const { SparkRenderer, SplatMesh } = await import("@sparkjsdev/spark");
    scene.add(new SparkRenderer({ renderer }));
    const splat = new SplatMesh({ url: DATA_DIR + file });
    if (opt.venueFlip) splat.quaternion.set(1, 0, 0, 0);
    scene.add(splat);
    await splat.initialized;
    return splat;
  } catch (e) {
    console.warn("[concert] venue.spz failed to load; continuing without it", e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Seats: one projection and one marker per seat
// ---------------------------------------------------------------------------
let seats = [];
let current = 0;
let stageSurfaces = null;

function makeLabel(text) {
  const canvas = Object.assign(document.createElement("canvas"), { width: 256, height: 64 });
  const g = canvas.getContext("2d");
  g.font = "bold 34px sans-serif";
  g.textAlign = "center";
  g.fillStyle = "#fff";
  g.shadowColor = "#000";
  g.shadowBlur = 6;
  g.fillText(text, 128, 44);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true }));
  sprite.scale.set(1.2, 0.3, 1);
  sprite.position.y = 0.55;
  return sprite;
}

const seatVerticalFov = (data) => (data.fovAxis === "horizontal" ? verticalFov(data.fov, data.aspect ?? 16 / 9) : data.fov);

// Stand-in surface for a real seat when there is no stage.glb yet: a flat panel facing the seat,
// ?panelDist in front of it and a bit larger than its frame (what Neven's test/concert.html does).
function seatPanel(data) {
  const aspect = data.aspect ?? 16 / 9;
  const h = 2 * opt.panelDist * Math.tan(rad(seatVerticalFov(data)) / 2) * 1.2;
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(h * aspect, h), opt.debug
    ? new THREE.MeshBasicMaterial({ color: 0x00ff88, wireframe: true, transparent: true, opacity: 0.3 })
    : new THREE.MeshBasicMaterial({ visible: false }));
  panel.position.set(...data.pos);
  panel.rotation.set(rad(data.pitch), rad(data.yaw), rad(data.roll), "YXZ");
  panel.translateZ(-opt.panelDist);
  scene.add(panel);
  return panel;
}

function buildSeat(data, index) {
  const url = data.videoUrl ?? opt.video;
  const clip = url ? new VideoClip(url) : new FakeClip(data.name, (index * 110 + 200) % 360, data.aspect ?? 16 / 9);
  const projection = addProjection(scene, clip.source, stageSurfaces ?? [seatPanel(data)], {
    pos: data.pos, yaw: data.yaw, pitch: data.pitch, roll: data.roll, fov: seatVerticalFov(data),
    near: Math.min(0.1, opt.panelDist / 10),
    enabled: false, order: index + 1, debug: opt.debug && index === 0, // one frustum helper is enough
  });
  // A horizontal FOV can only be converted once the real frame size is known.
  if (data.fovAxis === "horizontal" && clip.video) {
    clip.video.addEventListener("loadedmetadata", () => {
      projection.update({ fov: verticalFov(data.fov, clip.video.videoWidth / clip.video.videoHeight) });
    }, { once: true });
  }

  const marker = new THREE.Group();
  marker.position.set(...data.pos);
  marker.scale.setScalar(markerScale);
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.22, 24, 16), new THREE.MeshBasicMaterial({ color: 0x4fd1ff }));
  const fill = new THREE.Mesh(new THREE.CircleGeometry(0.42, 40), new THREE.MeshBasicMaterial({ color: 0xffd84a, transparent: true, opacity: 0.85, depthTest: false }));
  fill.scale.setScalar(0.001); // grows while you look at the marker
  fill.renderOrder = 999;
  const hit = new THREE.Mesh(new THREE.SphereGeometry(0.7, 12, 8), new THREE.MeshBasicMaterial({ visible: false })); // forgiving gaze target
  marker.add(orb, fill, hit, makeLabel(data.name));
  scene.add(marker);

  return { data, clip, projection, marker, fill, hit, shown: false };
}

function placeSeat(i, master = clock.time()) {
  if (i === current && rig.userData.placed) return;
  current = i;
  const s = seats[i].data;
  rig.userData.placed = true;
  rig.position.set(...s.pos);
  look.baseYaw = THREE.MathUtils.degToRad(s.yaw); // face the stage the way the filming phone did
  look.yaw = 0;
  look.roll = rad(s.roll);
  look.pitch = THREE.MathUtils.clamp(rad(s.pitch), -1.5, 1.5); // desktop: start tilted like the phone was
  look.recenter();
  rig.rotation.y = look.baseYaw;
  gaze.target = null;
  gaze.t = 0;
  gaze.cooldown = COOLDOWN;
  // Pause/mute the old clip before starting the target, including when switching backwards.
  seats.forEach((seat, k) => { if (k !== i) seat.clip.sync(0, false, false); });
  seats[i].clip.sync(clipTime(master, s.offsetSeconds), clock.playing, true, true);
  seats.forEach((seat, k) => { seat.marker.visible = k !== i; });
  document.querySelectorAll("#seats button").forEach((b, k) => b.classList.toggle("current", k === i));
}

const transition = new SeatTransition({
  time: () => clock.time(),
  teleport: placeSeat,
  setFov: fov => { camera.fov = fov; camera.updateProjectionMatrix(); },
  hide: () => seats.forEach(s => { s.shown = false; s.projection.update({ enabled: false }); }),
});
function selectSeat(i) {
  if (!Number.isInteger(i) || !seats[i] || transition.active) return false;
  if (!rig.userData.placed) { placeSeat(i); return true; }
  if (i === current) return false;
  return transition.start(i, camera.fov);
}

// ---------------------------------------------------------------------------
// Gaze: look at a marker for `dwell` seconds, or tap while looking at it, to jump there
// ---------------------------------------------------------------------------
const gaze = { target: null, t: 0, cooldown: 0, ray: new THREE.Raycaster(), center: new THREE.Vector2(0, 0) };
const camPos = new THREE.Vector3();

function updateGaze(dt) {
  if (transition.active) return;
  gaze.cooldown = Math.max(0, gaze.cooldown - dt);
  gaze.ray.setFromCamera(gaze.center, camera);
  const candidates = seats.filter((s, k) => k !== current).map((s) => s.hit);
  const hit = gaze.ray.intersectObjects(candidates, false)[0];
  const target = hit ? seats.findIndex((s) => s.hit === hit.object) : null;
  if (target !== gaze.target) { gaze.target = target; gaze.t = 0; }
  if (target !== null && gaze.cooldown === 0) {
    gaze.t += dt;
    if (opt.dwell > 0 && gaze.t >= opt.dwell) { selectSeat(target); return; }
  }
  camera.getWorldPosition(camPos);
  seats.forEach((s, k) => {
    s.fill.scale.setScalar(k === gaze.target && gaze.cooldown === 0 && opt.dwell > 0 ? Math.max(0.001, gaze.t / opt.dwell) : 0.001);
    s.fill.lookAt(camPos); // the disc always faces the viewer
  });
}

// ---------------------------------------------------------------------------
// UI: desktop drag, Android WebXR, Cardboard fallback (StereoEffect + gyro)
// ---------------------------------------------------------------------------
function startPlayback() {
  clock.play();
  seats[current]?.clip.sync(clipTime(clock.time(), seats[current].data.offsetSeconds), true, true, true);
}

async function startCardboard() {
  try { await look.enableGyro(); } catch (e) { setStatus(e.message); return; }
  stereo = new StereoEffect(renderer);
  stereo.setEyeSeparation(0.064);
  stereo.setSize(window.innerWidth, window.innerHeight);
  document.body.classList.add("cardboard");
  document.documentElement.requestFullscreen?.().catch(() => {});
  screen.orientation?.lock?.("landscape").catch(() => {});
  startPlayback();
  setStatus("");
}

function exitCardboard() {
  stereo = null;
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
  document.body.classList.remove("cardboard");
  document.exitFullscreen?.().catch(() => {});
}

function handleTap() {
  if (transition.active) return;
  beginReveal();
  if (gaze.target !== null) {
    if (gaze.cooldown === 0) selectSeat(gaze.target);
  } else if (stereo) look.recenter();
}

function setupUi() {
  document.getElementById("btn-start").onclick = () => { startPlayback(); document.getElementById("btn-start").remove(); };
  document.getElementById("btn-cardboard").onclick = startCardboard;
  document.getElementById("btn-exit").onclick = exitCardboard;
  // A tap (the Cardboard button) selects the marker you are looking at; otherwise it recenters.
  renderer.domElement.addEventListener("click", handleTap);
  const vrButton = VRButton.createButton(renderer);
  vrButton.id = "VRButton";
  document.body.appendChild(vrButton);
  renderer.xr.addEventListener("sessionstart", () => {
    startPlayback(); exitCardboard();
    renderer.xr.getSession().addEventListener("select", handleTap); // WebXR taps do not click the canvas
  });
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
let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  transition.update(dt);
  if (!renderer.xr.isPresenting) look.update();
  if (!seats.length) { renderer.render(scene, camera); return; }

  if (revealT !== null) revealT += dt;
  const revealK = revealT === null ? 0 : THREE.MathUtils.clamp(revealT / REVEAL_FADE, 0, 1);
  if (venue) venue.opacity = revealK;

  const master = clock.time();
  seats.forEach((s, k) => {
    const active = k === current;
    const state = s.clip.sync(clipTime(master, s.data.offsetSeconds), clock.playing, active);
    const show = active && state === "playing" && !s.clip.video?.seeking; // one projection at a time, so moving people never appear twice
    if (show !== s.shown) { s.shown = show; s.projection.update({ enabled: show }); }
    s.projection.update(dt);
  });
  seats.forEach((s, k) => { s.marker.visible = k !== current && revealK > 0; });
  if (revealK > 0) updateGaze(dt); // no jumping while only the video is showing

  const cur = seats[current];
  const ct = clipTime(master, cur.data.offsetSeconds);
  statusEl.textContent = `${cur.data.name} (seat ${current + 1} of ${seats.length})\n`
    + (clock.playing ? "" : "Paused. Tap Start.\n")
    + `master ${master.toFixed(1)} s · clip ${ct.toFixed(1)} s${ct < 0 ? " (not started yet)" : ""}`
    + (cur.clip.error ? `\n${cur.clip.error}` : "")
    + (cur.data.offsetKnown ? "" : " · audio offset unknown")
    + (opt.debug ? `\ngaze ${gaze.target === null ? "-" : seats[gaze.target].data.name} ${gaze.t.toFixed(2)} s` : "");

  if (stereo && !renderer.xr.isPresenting) stereo.render(scene, camera);
  else renderer.render(scene, camera);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main() {
  setupUi();
  let loaded;
  try {
    loaded = await loadSeats();
  } catch (e) {
    setStatus("cameras.json problem: " + e.message);
    return;
  }
  setStatus(loaded.dummy ? `No ${DATA_DIR.slice(2)}cameras.json yet: showing the dummy scene.` : "Loading the venue...");
  stageSurfaces = await loadStage(loaded.dummy);
  venue = await loadVenue();
  if (loaded.production && (!stageSurfaces || !venue)) {
    setStatus("Production assets missing or invalid: stage.glb and venue.spz are required in public/concert/.");
    return;
  }
  if (venue && opt.reveal > 0) venue.opacity = 0;

  // Markers are sized for seats a few meters apart; shrink them for close seats or normalized units.
  markerScale = opt.markerScale ?? Math.min(1, (seatSpacing(loaded.seats) * 0.3) / 0.7);
  seats = loaded.seats.map(buildSeat);
  const seatList = document.getElementById("seats"); // desktop shortcuts; in the Cardboard you look at markers instead
  seats.forEach((s, i) => {
    const b = document.createElement("button");
    b.textContent = s.data.name;
    b.onclick = () => selectSeat(i);
    seatList.appendChild(b);
  });

  clock.seek(opt.t);
  selectSeat(Math.min(Math.max(opt.seat, 0), seats.length - 1));
  if (opt.autoplay) { clock.play(); document.getElementById("btn-start")?.remove(); }

  // handy in the browser console, and for tests
  Object.assign(window, { THREE, scene, camera, rig, look, clock, seats: () => seats, selectSeat, gaze, current: () => current });
}

main();
