// Tracked people: each person VitTrack followed through the video (scripts/track-people.py,
// public/world/tracks.json) becomes a cut-out card standing in the splat room, instead of the
// whole video frame laid over the walls.
//
//   const people = await addTrackedPeople(scene, projection, video, { base: "./world/", depth: world.depth });
//   people.update();   // every frame
//
// Placement: the box's four corners are cast as rays from the projector (the original camera, so
// it follows the rotation track and the Framing panel too) out to the person's distance from the
// depth video. Inside the box, pixels much farther away than the person (the wall behind them)
// are cut out with the depth video, so only the person shows. Without depth, a soft oval mask.
//
// Turned on when tracks.json exists; ?people=0 goes back to the flat overlay.
// ?depthScale=1.2 stretches the distances (the depth model's metres are not exactly Marble's).
//
// Limits: a card is flat, so a person has no depth of their own; the box can drift when VitTrack
// loses someone (score below lostScore fades them out).

import * as THREE from "three";

const FALLBACK_Z = 2.0;      // metres, when there is no depth for a frame
const SYNC_SECONDS = 0.08;   // re-seek the depth video when it drifts this far from the colour video
const BEHIND = 0.25;         // pixels this fraction farther than the person start to fade out
const BEHIND_SOFT = 0.2;     // ...and are gone by BEHIND + BEHIND_SOFT
const FADE_SCORE = 0.15;     // fade in over this much score above lostScore

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAGMENT = /* glsl */ `
uniform sampler2D colorMap, depthMap;
uniform vec4 rect;          // box in video uv: x0, y0 (bottom-left), width, height
uniform float hasDepth, near, far, personZ, opacity, brightness, edge;
varying vec2 vUv;

void main() {
  vec2 uv = rect.xy + vUv * rect.zw;
  vec2 toBorder = min(vUv, 1.0 - vUv);
  float a = smoothstep(0.0, edge, min(toBorder.x, toBorder.y));
  if (hasDepth > 0.5) {
    float z = near + (1.0 - texture2D(depthMap, uv).r) * (far - near);   // white = near
    float behind = (z - personZ) / max(personZ, 0.1);
    a *= 1.0 - smoothstep(${BEHIND.toFixed(2)}, ${(BEHIND + BEHIND_SOFT).toFixed(2)}, behind);
  } else {
    vec2 c = (vUv - 0.5) * 2.0;
    a *= 1.0 - smoothstep(0.7, 1.0, length(c));
  }
  a *= opacity;
  if (a <= 0.01) discard;
  gl_FragColor = vec4(texture2D(colorMap, uv).rgb * brightness, a);
}`;

async function loadDepthVideo(base, meta) {
  if (!meta?.video || !meta?.json) return null;
  try {
    const info = await (await fetch(base + meta.json)).json();
    const v = document.createElement("video");
    v.src = base + meta.video;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.preload = "auto";
    await new Promise((resolve, reject) => {
      v.addEventListener("loadeddata", resolve, { once: true });
      v.addEventListener("error", reject, { once: true });
    });
    const tex = new THREE.VideoTexture(v);
    tex.colorSpace = THREE.NoColorSpace;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    return { video: v, texture: tex, info };
  } catch (e) {
    console.warn("[people] depth video failed, using an oval mask instead", e);
    return null;
  }
}

export async function loadTracks(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json(); // Vite answers a missing file with index.html, which fails here
    return Array.isArray(data?.tracks) && data.tracks.length ? data : null;
  } catch {
    return null;
  }
}

export async function addTrackedPeople(scene, projection, video, { base, tracks, depth, scale = 1 }) {
  const depthSrc = await loadDepthVideo(base, depth);
  const lost = tracks.lostScore ?? 0.3;
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  blank.needsUpdate = true;

  const group = new THREE.Group();
  group.name = "tracked-people";
  scene.add(group);

  const cards = tracks.tracks.map((track) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      uniforms: {
        colorMap: { value: projection.material.uniforms.map.value },
        depthMap: { value: depthSrc?.texture ?? blank },
        hasDepth: { value: depthSrc ? 1 : 0 },
        near: { value: depthSrc?.info.near ?? 0 },
        far: { value: depthSrc?.info.far ?? 1 },
        rect: { value: new THREE.Vector4() },
        personZ: { value: FALLBACK_Z },
        opacity: { value: 1 },
        brightness: { value: 1 },
        edge: { value: 0.08 },
      },
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "person-" + track.name;
    mesh.frustumCulled = false; // vertices move every frame
    mesh.renderOrder = 3;       // after the splats
    group.add(mesh);
    return { track, mesh, material, positions: geometry.attributes.position };
  });

  projection.update({ enabled: false }); // the people replace the flat overlay

  // Scratch objects, reused every frame.
  const inv = new THREE.Matrix4();
  const a = new THREE.Vector4(), b = new THREE.Vector4();
  const origin = new THREE.Vector3(), dir = new THREE.Vector3(), fwd = new THREE.Vector3(), pTmp = new THREE.Vector3();

  // A point at depth z (metres along the projector's view axis) through video uv (0..1, y up).
  function pointAt(u, v, z, out) {
    const nx = u * 2 - 1, ny = v * 2 - 1;
    a.set(nx, ny, -1, 1).applyMatrix4(inv);
    b.set(nx, ny, 1, 1).applyMatrix4(inv);
    dir.set(b.x / b.w - a.x / a.w, b.y / b.w - a.y / a.w, b.z / b.w - a.z / a.w).normalize();
    const along = Math.max(dir.dot(fwd), 0.05);
    return out.copy(origin).addScaledVector(dir, z / along);
  }

  function sampleIndex(frames) {
    const t = video ? video.currentTime : 0;
    return Math.min(frames.length - 1, Math.max(0, Math.round(t * tracks.fps)));
  }

  function update() {
    const cam = projection.cam;
    inv.copy(projection.material.uniforms.projView.value).invert();
    origin.setFromMatrixPosition(cam.matrixWorld);
    cam.getWorldDirection(fwd);
    const p = projection.params;

    for (const card of cards) {
      const frames = card.track.frames;
      const [x, y, w, h, score, zRaw] = frames[sampleIndex(frames)];
      const u = card.material.uniforms;
      const visible = w > 0 && h > 0 && score >= lost;
      card.mesh.visible = visible;
      if (!visible) continue;
      const z = (zRaw ?? FALLBACK_Z) * scale;
      // tracks.json is y-down from the top; video uv is y-up from the bottom.
      const u0 = x, u1 = x + w, v0 = 1 - (y + h), v1 = 1 - y;
      const corners = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
      corners.forEach(([cu, cv], i) => {
        pointAt(cu, cv, z, pTmp);
        card.positions.setXYZ(i, pTmp.x, pTmp.y, pTmp.z);
      });
      card.positions.needsUpdate = true;
      u.rect.value.set(u0, v0, w, h);
      u.personZ.value = zRaw ?? FALLBACK_Z;   // depth video units, before ?depthScale
      u.opacity.value = Math.min(1, (score - lost) / FADE_SCORE + 0.2) * p.opacity;
      u.brightness.value = p.brightness;
      u.colorMap.value = projection.material.uniforms.map.value;
    }

    if (depthSrc && video) {
      const dv = depthSrc.video;
      if (Math.abs(dv.currentTime - video.currentTime) > SYNC_SECONDS) dv.currentTime = video.currentTime;
      if (!video.paused && dv.paused) dv.play().catch(() => {});
      if (video.paused && !dv.paused) dv.pause();
    }
  }

  return { update, group, cards, depthVideo: depthSrc?.video ?? null };
}
