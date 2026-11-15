// ---------------------------------------------------------------------------
// VIDEO PROJECTION (KAN-10, Mac 2 owns this file)
// ---------------------------------------------------------------------------
// Projects a video onto room surfaces from the original camera's spot, like a slide projector.
// Every surface point is mapped into the projector's view: inside the frame it shows that video
// pixel, outside it nothing is drawn and the splat shows through. Edges fade out.
//
//   const projection = addProjection(scene, video, surfaces, opts);
//   projection.update(dt);               // every frame (main.js does this)
//   projection.update({ fov: 42 });      // change params at runtime
//
//   scene     THREE.Scene.
//   video     HTMLVideoElement, a THREE.Texture (photo), or null for a built-in test pattern.
//             This file never calls play(); the page starts the video on a user tap.
//   surfaces  THREE.Group or array of meshes to project onto (collider.glb, stage.glb, ...).
//             With no meshes, a simple box room is built around the projector instead.
//   opts      context (rig, config, debug) plus any key of DEFAULTS below, all in one object.
//
// Conventions (three.js: right-handed, Y up, meters). At yaw = pitch = roll = 0 the projector
// looks down -Z. yaw + turns left, pitch + looks up, roll + tilts counter-clockwise.
// fov is VERTICAL degrees: a landscape phone video is about 40 to 50, portrait about 65.
//
// Param priority, lowest to highest: DEFAULTS, the rig's pose, URL overrides, keys given in opts.
// URL overrides are "proj" + the param name, for example
//   ?projFov=40&projYaw=20&projPitch=-5&projRoll=0&projPos=0,1.4,0&projFade=0.3&projOpacity=0.8
//
// Works in WebXR and StereoEffect: nothing here depends on the viewer's camera, everything is
// computed from world positions.
// ---------------------------------------------------------------------------

import * as THREE from "three";

export const DEFAULTS = {
  // Projector pose, world space.
  pos: [0, 1.4, 2.4], // meters. Used only when neither opts.pos nor opts.rig is given
  yaw: 0,             // degrees
  pitch: 0,           // degrees
  roll: 0,            // degrees
  fov: 50,            // vertical field of view, degrees
  near: 0.1,          // meters. near and far only size the debug frustum helper;
  far: 30,            //   the projection itself has no distance limit

  // Look.
  extend: 0,          // fill past the frame: the video's edge colours are washed outward, blurred, over the
                      //   walls and table, fading out over this distance (in frame sizes; 0 = off, 1 = one frame)
  fade: 0.12,         // width of the soft edge, as a fraction of the frame (0 = hard edge)
  opacity: 1,         // 0 to 1
  overlay: 1,         // 0 to 1, multiplies opacity for the drawn layer only. Paint mode (splatPaint.js) lowers it
                      //   so the painted splats carry the colour and this layer only adds sharpness
  brightness: 1,      // multiplier
  saturation: 1,      // 0 = gray, 1 = as filmed
  tint: "#ffffff",    // multiplied into the video color
  shading: 0.6,       // 0 = flat video, 1 = fully darkened where a surface faces away from the projector
  ambient: 0.35,      // darkest the shading may get (0 to 1)
  enabled: true,      // false hides this projection (concert mode shows one seat at a time)
  order: 1,           // three.js renderOrder. Later draws on top. Keep above 0 so it draws after the splat

  // Fallback box room (floor, ceiling, three walls), built only when surfaces has no meshes.
  roomSize: [4, 2.6, 5], // width, height, depth in meters
  roomEye: 1.4,          // projector height above the fallback floor, meters
  roomBehind: 0.1,       // meters of floor behind the projector (the room is open at that end)
};

const EXTEND_STRENGTH = 0.9;          // how opaque the washed-out fill is right at the frame's border
const EXTEND_BLUR = 5;                // mip bias for the fill: higher = blurrier (the video texture has mipmaps, see setSource)
const URL_PREFIX = "proj";            // ?projFov=... maps to params.fov
const FOV_MIN = 1, FOV_MAX = 179;     // degrees; outside this the projection matrix breaks down
const FALLBACK_ASPECT = 16 / 9;       // used until the source reports its size
const POLYGON_OFFSET = -1;            // pulls the overlay toward the viewer so it never z-fights a visible surface
const PATTERN_WIDTH = 1280, PATTERN_HEIGHT = 720, PATTERN_CELL = 80; // test pattern, pixels
const PATTERN_LABEL_INSET = 0.18;     // labels sit this far in (fraction of the frame), clear of the default edge fade
const DEBUG_WIRE = { color: 0x00ff88, opacity: 0.35 };                // same look as main.js's collider wireframe
const OFF_AXIS_WARN_METERS = 0.05;    // warn when the projector sits this far from the viewer (see refresh)
const OVERLAY_FLAG = "isProjectionOverlay";                           // userData marker on our overlay meshes
const STASH_KEY = "projectionOriginalMaterial";                       // userData slot for a hidden mesh's own material

// Given to collider meshes that arrive hidden. The mesh must count as visible, otherwise three.js
// skips its children (our overlay). material.visible = false makes three.js skip the mesh's own
// draw call; colorWrite and depthWrite are off as well, so it could not draw anything anyway.
const HIDDEN_MATERIAL = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, visible: false });

// Clip position and lighting vectors are computed per vertex (always highp) and interpolated,
// so the fragment shader never does math on large world coordinates and is safe at mediump.
const VERTEX_SHADER = /* glsl */ `
uniform mat4 projView;   // world space to the projector's clip space
uniform vec3 projPos;    // projector position, world space
varying vec4 vClip;      // this point in the projector's clip space
varying vec3 vToProj;    // from this point to the projector (a few meters, fine at mediump)
varying vec3 vNormal;    // world-space normal (assumes uniform scale, true for the Marble room)

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vClip = projView * worldPos;
  vToProj = projPos - worldPos.xyz;
  vNormal = mat3(modelMatrix) * normal;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}`;

// Colors stay in display (sRGB) space from start to end: three.js hands a custom shader the
// video's frames still sRGB encoded, and the canvas wants sRGB, so there is no conversion and
// no pow() per pixel. This assumes renderer.outputColorSpace is sRGB (the three.js default).
const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D map;
uniform vec3 tint;
uniform float fade, opacity, brightness, saturation, shading, ambient, extend;
varying vec4 vClip;
varying vec3 vToProj;
varying vec3 vNormal;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722); // Rec. 709 gray weights

void main() {
  vec2 uv = vClip.xy / max(vClip.w, 1e-4) * 0.5 + 0.5; // position in the video frame, 0 to 1
  vec2 toBorder = min(uv, 1.0 - uv);
  float edge = min(toBorder.x, toBorder.y);       // distance to the nearest frame border (negative outside)
  float aFrame = edge > 0.0 ? (fade > 0.0 ? smoothstep(0.0, fade, edge) : 1.0) : 0.0;

  // The fill past the frame: a blurred copy of the nearest video pixels, fading with distance.
  vec2 inside = clamp(uv, 0.0, 1.0);
  float outside = length(uv - inside);
  float aExt = extend > 0.0 ? (1.0 - smoothstep(0.0, extend, outside)) * ${EXTEND_STRENGTH.toFixed(2)} : 0.0;
  float aAll = aFrame + aExt * (1.0 - aFrame);    // the frame drawn over the fill
  vec3 frameColor = texture2D(map, inside).rgb;
  vec3 fillColor = texture2D(map, inside, ${EXTEND_BLUR.toFixed(1)}).rgb;
  if (vClip.w <= 0.0 || aAll <= 0.0) discard;     // behind the projector, or nothing to draw: the room shows through
  float alpha = opacity * aAll;

  vec3 color = (frameColor * aFrame + fillColor * aExt * (1.0 - aFrame)) / aAll;
  color = color * tint * brightness;
  color = mix(vec3(dot(color, LUMA)), color, saturation);

  // Lambert term against the projector, both sides lit. Darkens surfaces that face away.
  float facing = abs(dot(normalize(vNormal), normalize(vToProj)));
  color *= mix(1.0, ambient + (1.0 - ambient) * facing, shading);

  gl_FragColor = vec4(color, alpha);
}`;

export function addProjection(scene, video, surfaces, opts = {}) {
  const debug = opts.debug ?? opts.config?.debug ?? false;
  const params = resolveParams(opts);

  const uniforms = {
    map: { value: null },
    projView: { value: new THREE.Matrix4() },
    projPos: { value: new THREE.Vector3() },
    tint: { value: new THREE.Color() },
    fade: { value: 0 }, opacity: { value: 1 }, brightness: { value: 1 },
    saturation: { value: 1 }, shading: { value: 0 }, ambient: { value: 0 }, extend: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    forceSinglePass: true, // one draw call per surface instead of a back pass plus a front pass
    polygonOffset: true,
    polygonOffsetFactor: POLYGON_OFFSET,
    polygonOffsetUnits: POLYGON_OFFSET,
  });

  // The projector. It never renders anything; it only supplies the view and projection matrices.
  const cam = new THREE.PerspectiveCamera();

  // Surfaces: the caller's meshes, or a stand-in box room when there are none.
  let meshes = collectMeshes(surfaces);
  let fallbackRoom = null;
  if (meshes.length === 0) {
    console.warn("[projection] no surface meshes (collider.glb missing?). Projecting onto a stand-in box room; it will not match the real room.");
    fallbackRoom = buildFallbackRoom(params, debug);
    scene.add(fallbackRoom);
    meshes = collectMeshes(fallbackRoom);
  }

  // One overlay per surface, sharing the projection material. It is a child of the surface so it
  // follows it through world > metric (flip, scale, ground offset).
  const ownedGeometries = [];
  const overlays = meshes.map((mesh) => {
    let geometry = mesh.geometry;
    if (!geometry.getAttribute("normal")) {
      // The shading needs normals. Work on a copy so the caller's geometry is left alone.
      geometry = geometry.clone();
      geometry.computeVertexNormals();
      ownedGeometries.push(geometry);
    }
    if (!mesh.visible) {
      if (!(STASH_KEY in mesh.userData)) {
        mesh.userData[STASH_KEY] = mesh.material;
        mesh.material = HIDDEN_MATERIAL;
      }
      mesh.visible = true;
    }
    const overlay = new THREE.Mesh(geometry, material);
    overlay.name = "projection-overlay";
    overlay.userData[OVERLAY_FLAG] = true;
    mesh.add(overlay);
    return overlay;
  });

  let helper = null;
  if (debug) {
    helper = new THREE.CameraHelper(cam);
    scene.add(helper);
  }

  let ownedTexture = null;            // a texture we created (video or test pattern), disposed by us
  let sourceWidth = 0, sourceHeight = 0;
  let firstFrameUploaded = false;     // video only: has the first frame been pushed to the GPU yet
  const viewerPos = new THREE.Vector3(); // scratch, so refresh() does not allocate
  let offAxisWarned = false;

  // A panning video (src/rotationTrack.js). aim() turns the projector from its aligned pose
  // (params line up the FIRST frame) by the camera's rotation since then, with a FOV scale.
  const trackQuat = new THREE.Quaternion(); // identity = no tracking
  let trackZoom = 1;                        // tan(fov / 2) relative to params.fov
  let customView = false;                   // true while aimMatrix() supplies projView
  function pose() {
    const half = Math.tan(THREE.MathUtils.degToRad(THREE.MathUtils.clamp(params.fov, FOV_MIN, FOV_MAX)) / 2) * trackZoom;
    cam.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(half)), FOV_MIN, FOV_MAX);
    cam.rotation.set(
      THREE.MathUtils.degToRad(params.pitch), THREE.MathUtils.degToRad(params.yaw), THREE.MathUtils.degToRad(params.roll),
      "YXZ", // yaw, then pitch, then roll: how a hand-held phone is aimed
    );
    cam.quaternion.multiply(trackQuat);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    if (!customView) uniforms.projView.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  }

  // aimMatrix() takes a world-to-clip matrix as is: it may stretch the picture, which a camera
  // pose cannot. null goes back to the pose. Both are per-frame calls with no allocations.
  function aimMatrix(matrix) {
    customView = !!matrix;
    if (matrix) uniforms.projView.value.copy(matrix); else pose();
  }
  function aim(quat, zoom = 1) {
    trackQuat.copy(quat);
    trackZoom = zoom;
    customView = false;
    pose();
    helper?.update();
  }

  // Recomputes everything derived from params. Runs on a param change or when the source's size
  // becomes known, not every frame. No allocations.
  function refresh() {
    const p = params;
    const near = p.near > 0 ? p.near : DEFAULTS.near;
    cam.aspect = sourceWidth > 0 && sourceHeight > 0 ? sourceWidth / sourceHeight : FALLBACK_ASPECT;
    cam.near = near;
    cam.far = p.far > near ? p.far : near + DEFAULTS.far;
    cam.position.fromArray(p.pos);
    pose();
    uniforms.projPos.value.copy(cam.position);
    uniforms.tint.value.set(p.tint);
    uniforms.fade.value = p.fade;
    uniforms.extend.value = p.extend;
    uniforms.opacity.value = p.opacity * p.overlay;
    uniforms.brightness.value = p.brightness;
    uniforms.saturation.value = p.saturation;
    uniforms.shading.value = p.shading;
    uniforms.ambient.value = p.ambient;
    for (let i = 0; i < overlays.length; i++) overlays[i].renderOrder = p.order;
    helper?.update();

    // Occlusion is not handled: a surface hidden from the projector behind furniture still gets
    // the video, and the hidden collider does not block the viewer's line of sight. Neither shows
    // while the viewer stands at the projector (how both modes are meant to be watched), so only
    // warn when they drift apart, for example ?projPos tuned without moving ?cam too.
    if (opts.rig && !offAxisWarned) {
      opts.rig.getWorldPosition(viewerPos);
      if (viewerPos.distanceTo(cam.position) > OFF_AXIS_WARN_METERS) {
        console.warn("[projection] the projector is not at the viewer's spot. Occlusion is not handled, so the video can show on surfaces behind objects. Move ?cam to the same place as ?projPos.");
        offAxisWarned = true;
      }
    }
  }

  // Per-frame work: hide the projection until the source has a picture, and pick up its size.
  // The video texture itself is refreshed by three.js. No allocations.
  function tick() {
    const texture = uniforms.map.value;
    const image = texture.image;
    const width = image ? image.videoWidth || image.width || 0 : 0;
    const height = image ? image.videoHeight || image.height || 0 : 0;
    const frameReady = !texture.isVideoTexture || image.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    // three.js refreshes a video texture only when the video presents a new frame, which a paused
    // video never does, so the texture would stay black until the user taps Start. Push the first
    // frame once ourselves: the first frame then shows before the tap, without calling play().
    if (texture.isVideoTexture && frameReady && !firstFrameUploaded) {
      texture.needsUpdate = true;
      firstFrameUploaded = true;
    }
    const hasPicture = width > 0 && height > 0 && frameReady;
    material.visible = params.enabled && hasPicture;
    if (width !== sourceWidth || height !== sourceHeight) {
      sourceWidth = width;
      sourceHeight = height;
      refresh();
    }
  }

  // update(dt)     number: per-frame refresh only (what main.js calls).
  // update(patch)  object: merge into params and recompute. update() recomputes after editing params in place.
  function update(arg) {
    if (typeof arg !== "number") {
      if (arg) {
        Object.assign(params, arg);
        if (arg.pos) params.pos = [...arg.pos];
      }
      refresh();
    }
    tick();
  }

  // Swap what is projected: a video element, a THREE.Texture (photo), or null for the test pattern.
  function setSource(source) {
    ownedTexture?.dispose();
    ownedTexture = null;
    let texture;
    if (source?.isTexture) {
      texture = source;
    } else if (source) {
      texture = ownedTexture = new THREE.VideoTexture(source);
      texture.generateMipmaps = true; // the blurred fill past the frame samples a low mip level
      texture.minFilter = THREE.LinearMipmapLinearFilter;
    } else {
      console.warn("[projection] no video given (world.json has no \"video\"?). Showing a test pattern so alignment can still be checked.");
      texture = ownedTexture = makeTestPattern();
    }
    // See the note above FRAGMENT_SHADER: sample every source as stored, without sRGB decoding.
    if (texture.colorSpace !== THREE.NoColorSpace) {
      texture.colorSpace = THREE.NoColorSpace;
      if (texture.image && !texture.isVideoTexture) texture.needsUpdate = true;
    }
    uniforms.map.value = texture;
    api.texture = texture;
    firstFrameUploaded = false;
    update();
  }

  // Removes everything addProjection added and puts hidden meshes back the way they were.
  function dispose() {
    overlays.forEach((overlay) => {
      const mesh = overlay.parent;
      overlay.removeFromParent();
      // Another projection may still be using this mesh (several seats on one stage.glb).
      const stillUsed = mesh?.children.some((child) => child.userData[OVERLAY_FLAG]);
      if (mesh && !stillUsed && STASH_KEY in mesh.userData) {
        mesh.material = mesh.userData[STASH_KEY];
        mesh.visible = false;
        delete mesh.userData[STASH_KEY];
      }
    });
    overlays.length = 0;
    ownedGeometries.forEach((geometry) => geometry.dispose());
    if (fallbackRoom) {
      fallbackRoom.removeFromParent();
      fallbackRoom.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    }
    if (helper) {
      helper.removeFromParent();
      helper.dispose();
    }
    ownedTexture?.dispose();
    material.dispose();
    if (globalThis.projection === api) delete globalThis.projection;
  }

  const api = { update, aim, aimMatrix, dispose, setSource, cam, params, material, helper, texture: null };
  setSource(video);

  if (debug) globalThis.projection = api; // console handle: projection.update({ fov: 45 }), projection.dispose()
  return api;
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------
function resolveParams(opts) {
  const params = { ...DEFAULTS };
  const fromUrl = readUrlOverrides(opts.config);

  // Start at the rig: main.js puts it at the original camera's spot, facing cfg.yaw.
  if (opts.rig) {
    opts.rig.updateWorldMatrix(true, false);
    params.pos = opts.rig.getWorldPosition(new THREE.Vector3()).toArray();
    const facing = new THREE.Euler().setFromQuaternion(opts.rig.getWorldQuaternion(new THREE.Quaternion()), "YXZ");
    params.yaw = THREE.MathUtils.radToDeg(facing.y);
    const tuned = ["pos", "yaw", "pitch", "roll", "fov"].some((key) => key in fromUrl || opts[key] !== undefined);
    if (!tuned) {
      // Not verifiable from here: World Labs does not document that the Marble origin is the
      // original camera, nor the collider's axes, and the video's real field of view is unknown.
      console.warn(`[projection] projector placed at the rig with a guessed ${params.fov} degree vertical FOV. Neither is verified against the real camera. Check with ?debug=1 and tune ?projPos, ?projYaw, ?projPitch, ?projRoll, ?projFov.`);
    }
  }

  Object.assign(params, fromUrl);
  for (const key of Object.keys(DEFAULTS)) if (opts[key] !== undefined) params[key] = opts[key];
  params.pos = [...params.pos];           // own copies, so sliders can edit them in place
  params.roomSize = [...params.roomSize];
  return params;
}

// Reads ?projFov=40 style overrides. A value already parsed into config (config.js) wins over
// the raw URL. Bad values are skipped with a warning instead of breaking the projection.
function readUrlOverrides(config) {
  const search = new URLSearchParams(globalThis.location?.search ?? "");
  const overrides = {};
  for (const key of Object.keys(DEFAULTS)) {
    const urlKey = URL_PREFIX + key[0].toUpperCase() + key.slice(1);
    const raw = config?.[urlKey] ?? search.get(urlKey);
    if (raw == null) continue;
    const value = parseParam(DEFAULTS[key], raw);
    if (value === undefined) console.warn(`[projection] ignoring ?${urlKey}=${raw}: not a valid value`);
    else overrides[key] = value;
  }
  return overrides;
}

// Parses a URL string into the same type as the default. Returns undefined when it does not fit.
function parseParam(def, raw) {
  if (typeof raw !== "string") return raw; // already parsed by config.js
  const text = raw.trim();
  if (text === "") return undefined;
  if (typeof def === "boolean") return text === "1" || text === "true"; // same rule as config.js
  if (typeof def === "number") {
    const n = Number(text);
    return Number.isFinite(n) ? n : undefined;
  }
  if (Array.isArray(def)) {
    const list = text.split(",").map(Number);
    return list.length === def.length && list.every(Number.isFinite) ? list : undefined;
  }
  return /^[0-9a-f]{6}$/i.test(text) ? "#" + text : text; // colors: "#" cannot go in a query, so ffcc88 works too
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------
// Accepts a Group, a single mesh, or an array of either. Skips overlays from earlier projections.
function collectMeshes(surfaces) {
  const roots = Array.isArray(surfaces) ? surfaces : surfaces ? [surfaces] : [];
  const meshes = [];
  for (const root of roots) {
    root?.traverse?.((o) => { if (o.isMesh && !o.userData[OVERLAY_FLAG]) meshes.push(o); });
  }
  return meshes;
}

// Floor, ceiling and three walls around the projector, open behind it. Stands in for the real
// room when there is no collider. The ceiling is there so the top of the frame lands on something.
// Shown as a wireframe in debug mode, invisible otherwise.
function buildFallbackRoom(params, debug) {
  const [width, height, depth] = params.roomSize;
  const room = new THREE.Group();
  room.name = "projection-fallback-room";
  // Room frame: floor at y = 0, projector at (0, roomEye, 0) looking down -Z.
  room.position.set(params.pos[0], params.pos[1] - params.roomEye, params.pos[2]);
  room.rotation.y = THREE.MathUtils.degToRad(params.yaw);

  const backZ = params.roomBehind - depth;     // z of the wall the projector faces
  const midZ = params.roomBehind - depth / 2;  // z of the room's middle
  const addWall = (w, h, x, y, z, rotX, rotY) => {
    // about one wireframe cell per meter
    const geometry = new THREE.PlaneGeometry(w, h, Math.ceil(w), Math.ceil(h));
    const wire = new THREE.MeshBasicMaterial({ ...DEBUG_WIRE, wireframe: true, transparent: true });
    const wall = new THREE.Mesh(geometry, wire);
    wall.position.set(x, y, z);
    wall.rotation.set(rotX, rotY, 0);
    wall.visible = debug; // hidden walls go through the same path as hidden collider meshes
    room.add(wall);
  };
  addWall(width, depth, 0, 0, midZ, -Math.PI / 2, 0);              // floor
  addWall(width, depth, 0, height, midZ, Math.PI / 2, 0);          // ceiling
  addWall(width, height, 0, height / 2, backZ, 0, 0);              // wall ahead
  addWall(depth, height, -width / 2, height / 2, midZ, 0, Math.PI / 2);  // left wall
  addWall(depth, height, width / 2, height / 2, midZ, 0, -Math.PI / 2);  // right wall
  return room;
}

// ---------------------------------------------------------------------------
// Test pattern
// ---------------------------------------------------------------------------
// Grid, red crosshair through the center and TOP / BOTTOM / LEFT / RIGHT labels, so the
// projection can be lined up and checked for flips without a video.
function makeTestPattern() {
  const canvas = document.createElement("canvas");
  canvas.width = PATTERN_WIDTH;
  canvas.height = PATTERN_HEIGHT;
  const w = PATTERN_WIDTH, h = PATTERN_HEIGHT;
  const g = canvas.getContext("2d");
  g.fillStyle = "#223";
  g.fillRect(0, 0, w, h);

  g.strokeStyle = "#fff";
  g.lineWidth = 2;
  g.beginPath();
  for (let x = 0; x <= w; x += PATTERN_CELL) { g.moveTo(x, 0); g.lineTo(x, h); }
  for (let y = 0; y <= h; y += PATTERN_CELL) { g.moveTo(0, y); g.lineTo(w, y); }
  g.stroke();

  g.strokeStyle = "#f33";
  g.lineWidth = 6;
  g.beginPath();
  g.moveTo(w / 2, 0); g.lineTo(w / 2, h);
  g.moveTo(0, h / 2); g.lineTo(w, h / 2);
  g.stroke();

  g.fillStyle = "#fff";
  g.font = `bold ${PATTERN_CELL * 0.6}px sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("TOP", w / 2, h * PATTERN_LABEL_INSET);
  g.fillText("BOTTOM", w / 2, h * (1 - PATTERN_LABEL_INSET));
  g.textAlign = "left";
  g.fillText("LEFT", w * PATTERN_LABEL_INSET, h / 2 - PATTERN_CELL / 2);
  g.textAlign = "right";
  g.fillText("RIGHT", w * (1 - PATTERN_LABEL_INSET), h / 2 - PATTERN_CELL / 2);
  return new THREE.CanvasTexture(canvas);
}
