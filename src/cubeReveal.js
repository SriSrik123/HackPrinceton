// Venue reveal: the splat appears cube by cube, nearest the video frame first, and each cube's
// outline flashes as it pops in. The splat side is a Spark world modifier (runs on the GPU); the
// outlines are one LineSegments over the occupied cells. Both use the same delay formula.
import * as THREE from "three";
import { dyno } from "@sparkjsdev/spark";

const MAX_CUBES = 4000; // outline cap; the cube size grows until the occupied cells fit
const MIN_SPLATS = 8;   // cells with fewer splats (floaters) get no outline and do not stretch the spread
const JITTER = 0.35;    // random extra delay per cube (s), so neighbors do not pop in lockstep
const FLASH = 0.6;      // how long an outline stays visible (s)
const COLOR = 0x4fd1ff; // same blue as the seat markers

// Hash of an integer cell, kept to small magnitudes so float32 (GPU) and float64 (JS) agree.
const GLSL = `
float cubeRevealDelay(vec3 cell, float cube, vec3 origin, float rate) {
  vec3 p = fract(cell * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return distance((cell + 0.5) * cube, origin) * rate + fract((p.x + p.y) * p.z) * ${JITTER.toFixed(4)};
}`;
const fract = (x) => x - Math.floor(x);
function cellDelay([x, y, z], cube, o, rate) {
  let a = fract(x * 0.1031), b = fract(y * 0.1031), c = fract(z * 0.1031);
  const d = a * (c + 31.32) + b * (b + 31.32) + c * (a + 31.32);
  a += d; b += d; c += d;
  return Math.hypot((x + 0.5) * cube - o.x, (y + 0.5) * cube - o.y, (z + 0.5) * cube - o.z) * rate + fract((a + b) * c) * JITTER;
}

// the 12 edges of a unit cube, as corner pairs
const EDGES = [];
for (let a = 0; a < 8; a++) for (const bit of [1, 2, 4]) if (!(a & bit)) EDGES.push(a, a | bit);
const corner = (i) => [i & 1, (i >> 1) & 1, (i >> 2) & 1];

export class CubeReveal {
  // venue: an initialized SplatMesh already in the scene. cube: cell size in scene units (null = auto).
  constructor(scene, venue, cube = null) {
    this.scene = scene;
    this.venue = venue;
    venue.updateMatrixWorld(true);
    const m = venue.matrixWorld;
    const n = venue.packedSplats?.numSplats ?? 0;
    const pts = new Float32Array(n * 3);
    const v = new THREE.Vector3();
    let count = 0;
    venue.forEachSplat((i, c) => { v.copy(c).applyMatrix4(m).toArray(pts, count * 3); count++; });

    // Auto size from the 2nd-98th percentile extent, so far floaters and sky splats do not inflate it.
    const pct = (axis, q) => {
      const step = Math.max(1, Math.floor(count / 20000));
      const s = [];
      for (let i = 0; i < count; i += step) s.push(pts[i * 3 + axis]);
      s.sort((a, b) => a - b);
      return s[Math.floor(q * (s.length - 1))] ?? 0;
    };
    let size = cube ?? (Math.hypot(...[0, 1, 2].map((a) => pct(a, 0.98) - pct(a, 0.02))) / 40 || 1);
    for (;;) {
      const counts = new Map();
      for (let i = 0; i < count * 3; i += 3) {
        const k = `${Math.floor(pts[i] / size)},${Math.floor(pts[i + 1] / size)},${Math.floor(pts[i + 2] / size)}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      this.cells = [...counts].filter(([, c]) => c >= MIN_SPLATS).map(([k]) => k.split(",").map(Number));
      if (this.cells.length <= MAX_CUBES) break;
      size *= 1.5;
    }
    this.size = size;

    this.t = dyno.dynoFloat(-1); // below every delay: nothing shows until start()
    this.origin = dyno.dynoVec3(new THREE.Vector3());
    this.rate = dyno.dynoFloat(0);
    const cubeU = dyno.dynoFloat(size);
    const hide = new dyno.Dyno({
      inTypes: { gsplat: dyno.Gsplat, t: "float", origin: "vec3", cube: "float", rate: "float" },
      outTypes: { gsplat: dyno.Gsplat },
      globals: () => [GLSL],
      statements: ({ inputs: i, outputs: o }) => dyno.unindentLines(`
        ${o.gsplat} = ${i.gsplat};
        if (${i.t} < cubeRevealDelay(floor(${i.gsplat}.center / ${i.cube}), ${i.cube}, ${i.origin}, ${i.rate})) ${o.gsplat}.rgba.a = 0.0;
      `),
    });
    venue.worldModifier = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat },
      ({ gsplat }) => hide.apply({ gsplat, t: this.t, origin: this.origin, cube: cubeU, rate: this.rate }));
    venue.updateGenerator();
  }

  // origin: where the video frame is (world). seconds: time for the reveal to reach 90% of the cubes;
  // the far stragglers (floaters, sky) pop in together when the reveal ends.
  start(origin, seconds) {
    const size = this.size;
    const dists = this.cells.map(([x, y, z]) => Math.hypot((x + 0.5) * size - origin.x, (y + 0.5) * size - origin.y, (z + 0.5) * size - origin.z)).sort((a, b) => a - b);
    const rate = seconds / Math.max(dists[Math.floor(0.9 * (dists.length - 1))] ?? 0, 1e-6);
    this.origin.value.copy(origin);
    this.rate.value = rate;
    this.end = seconds + JITTER + FLASH;

    const pos = new Float32Array(this.cells.length * EDGES.length * 3);
    const delay = new Float32Array(this.cells.length * EDGES.length);
    let p = 0;
    this.cells.forEach((cell, ci) => {
      const d = cellDelay(cell, size, origin, rate);
      delay.fill(d, ci * EDGES.length, (ci + 1) * EDGES.length);
      for (const e of EDGES) corner(e).forEach((c, axis) => { pos[p++] = (cell[axis] + c) * size; });
    });
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute("delay", new THREE.BufferAttribute(delay, 1));
    this.lines = new THREE.LineSegments(geom, new THREE.ShaderMaterial({
      uniforms: { t: { value: 0 }, color: { value: new THREE.Color(COLOR) } },
      vertexShader: `attribute float delay; uniform float t; varying float vA;
        void main() { vA = 1.0 - (t - delay) / ${FLASH.toFixed(4)}; if (t < delay) vA = 0.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 color; varying float vA;
        void main() { if (vA <= 0.0) discard; gl_FragColor = vec4(color, vA); }`,
      transparent: true, depthWrite: false,
    }));
    this.lines.frustumCulled = false;
    this.scene.add(this.lines);
  }

  // t: seconds since start(). Once done, the modifier comes off so the phone stops paying for it.
  update(t) {
    if (this.done || !this.lines) return;
    this.t.value = t;
    this.lines.material.uniforms.t.value = t;
    this.venue.updateVersion();
    if (t > this.end) {
      this.done = true;
      this.venue.worldModifier = undefined;
      this.venue.updateGenerator();
      this.lines.removeFromParent();
      this.lines.geometry.dispose();
      this.lines.material.dispose();
    }
  }
}

// self-check: node src/cubeReveal.js (checks the JS delay formula)
if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("cubeReveal.js")) {
  const o = { x: 0, y: 0, z: 0 };
  for (const c of [[0, 0, 0], [-5, 3, 99], [120, -7, 2]]) {
    const j = cellDelay(c, 1, { x: (c[0] + 0.5), y: (c[1] + 0.5), z: (c[2] + 0.5) }, 1);
    console.assert(j >= 0 && j < JITTER, "jitter out of range", c, j);
  }
  console.assert(Math.abs(cellDelay([3, 0, 0], 1, o, 2) - cellDelay([3, 0, 0], 1, o, 0) - 2 * Math.hypot(3.5, 0.5, 0.5)) < 1e-9, "distance term");
  console.log("cubeReveal ok, edges:", EDGES.length / 2);
}
