// A live, slowly drifting view of the generated room behind the upload page. It is drawn small and
// blurred with CSS, so it only has to give colour and depth: the 100k splat is plenty.
//
//   startBackdrop(canvas, "world")    // folder under public/ with world.json + splat-100k.spz
//
// Loaded after the form is usable, and any failure (no WebGL, no splat yet) just leaves the plain
// dark page behind the card.

import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

const RESOLUTION_SCALE = 0.5;       // the canvas is blurred anyway, so draw at half resolution
const BASE_YAW = THREE.MathUtils.degToRad(22);   // toward the table and the fireplace wall
const SWAY = THREE.MathUtils.degToRad(7);        // how far the view drifts either side
const SWAY_SECONDS = 36;            // one full drift cycle
const PITCH = THREE.MathUtils.degToRad(-4);

export async function startBackdrop(canvas, worldName) {
  const base = `./${worldName}/`;
  const meta = await (await fetch(base + "world.json")).json();

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * RESOLUTION_SCALE);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(65, 1, 0.01, 1000);
  scene.add(new SparkRenderer({ renderer }));

  // Same frame as the viewer (src/main.js): axis flip, then metric scale and ground offset.
  const world = new THREE.Group();
  world.quaternion.set(1, 0, 0, 0);
  const metric = new THREE.Group();
  const m = meta.semantics_metadata;
  if (m?.metric_scale_factor) {
    metric.scale.setScalar(m.metric_scale_factor);
    metric.position.y = -(m.ground_plane_offset ?? 0);
  }
  world.add(metric);
  scene.add(world);

  const splat = new SplatMesh({ url: base + "splat-100k.spz" });
  metric.add(splat);
  await splat.initialized;

  scene.updateMatrixWorld(true);
  camera.position.copy(metric.localToWorld(new THREE.Vector3())); // the original camera's spot

  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", resize);
  resize();

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const yaw = BASE_YAW + (still ? 0 : SWAY * Math.sin((clock.getElapsedTime() / SWAY_SECONDS) * Math.PI * 2));
    camera.rotation.set(PITCH, yaw, 0, "YXZ");
    renderer.render(scene, camera);
  });
  canvas.classList.add("ready"); // fades in once there is something to show
}
