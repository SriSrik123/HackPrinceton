// Depth mesh: the video drawn as real geometry from the camera's spot, every pixel pushed out to
// the distance Video Depth Anything measured for it (scripts/depth-video.py, depth-metric.mp4).
// A flat overlay looks the same to both eyes; this gives each eye a slightly different view, so the
// people stand at their own distances in the Cardboard and the picture keeps its depth if you lean.
//
//   const depth = await addDepthMesh(scene, projection, video, { base: "./world/", meta: world.depth });
//   depth.update();     // every frame
//
// world.json:  "depth": { "video": "depth-metric.mp4", "json": "depth-metric.json" }
// Turned on with ?depth=1. ?depthScale=1.2 stretches distances (the model's metres are not Marble's).
//
// Framing comes from the projection (turn, tilt, size, fade, brightness, opacity, Overlay layer), so
// the Framing panel moves this too. The flat overlay is switched off while this is on.
//
// Limits: depth is a rough per-pixel estimate; edges between a person and the wall behind them are
// soft, so triangles that stretch across such a jump are cut out (the room shows through there).

import * as THREE from "three";

const COLS = 192, ROWS = 108;   // grid cells. 16:9, about 21k triangles, light enough for a phone
const MAX_JUMP = 0.16;          // cut triangles whose depth changes by more than this fraction between neighbours
const SYNC_SECONDS = 0.08;      // re-seek the depth video when it drifts this far from the colour video

const VERTEX = /* glsl */ `
uniform sampler2D depthMap;
uniform mat4 camWorld;      // projector pose, world space
uniform float tanV, aspect; // projector tan(vertical fov / 2) and width / height
uniform float near, far, depthScale;
varying vec2 vUv;
varying float vJump;

float zAt(vec2 uv) {
  float g = texture2D(depthMap, uv).r;           // white = near
  return (near + (1.0 - g) * (far - near)) * depthScale;
}

void main() {
  vUv = uv;
  float z = zAt(uv);
  vec2 step = vec2(1.0 / ${COLS}.0, 1.0 / ${ROWS}.0);
  float j = max(max(abs(zAt(uv + vec2(step.x, 0.0)) - z), abs(zAt(uv - vec2(step.x, 0.0)) - z)),
                max(abs(zAt(uv + vec2(0.0, step.y)) - z), abs(zAt(uv - vec2(0.0, step.y)) - z)));
  vJump = j / max(z, 0.1);
  vec2 ndc = uv * 2.0 - 1.0;
  vec3 inCam = vec3(ndc.x * tanV * aspect * z, ndc.y * tanV * z, -z); // three.js camera looks down -Z
  vec4 world = camWorld * vec4(inCam, 1.0);
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const FRAGMENT = /* glsl */ `
uniform sampler2D colorMap;
uniform float fade, opacity, brightness;
varying vec2 vUv;
varying float vJump;

void main() {
  if (vJump > ${MAX_JUMP.toFixed(2)}) discard;       // a stretched triangle across a depth edge
  vec2 toBorder = min(vUv, 1.0 - vUv);
  float edge = min(toBorder.x, toBorder.y);
  float alpha = opacity * (fade > 0.0 ? smoothstep(0.0, fade, edge) : 1.0);
  alpha *= 1.0 - smoothstep(${(MAX_JUMP * 0.5).toFixed(3)}, ${MAX_JUMP.toFixed(2)}, vJump);
  if (alpha <= 0.0) discard;
  gl_FragColor = vec4(texture2D(colorMap, vUv).rgb * brightness, alpha);
}`;

export async function addDepthMesh(scene, projection, video, { base, meta, scale = 1 }) {
  const info = await (await fetch(base + meta.json)).json();

  const depthVideo = document.createElement("video");
  depthVideo.src = base + meta.video;
  depthVideo.muted = true;
  depthVideo.loop = true;
  depthVideo.playsInline = true;
  depthVideo.preload = "auto";
  await new Promise((resolve) => {
    depthVideo.addEventListener("loadeddata", resolve, { once: true });
    depthVideo.addEventListener("error", resolve, { once: true });
  });

  const depthTexture = new THREE.VideoTexture(depthVideo);
  depthTexture.colorSpace = THREE.NoColorSpace;
  depthTexture.minFilter = depthTexture.magFilter = THREE.LinearFilter;
  depthTexture.generateMipmaps = false;

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: true,
    uniforms: {
      depthMap: { value: depthTexture },
      colorMap: { value: projection.material.uniforms.map.value },
      camWorld: { value: new THREE.Matrix4() },
      tanV: { value: 0.5 }, aspect: { value: 16 / 9 },
      near: { value: info.near }, far: { value: info.far }, depthScale: { value: scale },
      fade: { value: 0.2 }, opacity: { value: 1 }, brightness: { value: 1 },
    },
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, COLS, ROWS), material);
  mesh.name = "depth-mesh";
  mesh.frustumCulled = false; // its vertices are moved in the shader, so the bounding box means nothing
  mesh.renderOrder = 2;       // after the splats and the flat overlay
  scene.add(mesh);

  projection.update({ enabled: false }); // the flat overlay is replaced by this mesh

  const u = material.uniforms;
  function update() {
    const p = projection.params, cam = projection.cam;
    u.camWorld.value.copy(cam.matrixWorld);
    u.tanV.value = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    u.aspect.value = cam.aspect;
    u.fade.value = p.fade;
    u.opacity.value = p.opacity * p.overlay;
    u.brightness.value = p.brightness;
    u.colorMap.value = projection.material.uniforms.map.value;
    // keep the depth video on the colour video's clock
    if (video && Math.abs(depthVideo.currentTime - video.currentTime) > SYNC_SECONDS) depthVideo.currentTime = video.currentTime;
    if (video && !video.paused && depthVideo.paused) depthVideo.play().catch(() => {});
    if (video && video.paused && !depthVideo.paused) depthVideo.pause();
  }

  return { update, mesh, material, depthVideo, info };
}
