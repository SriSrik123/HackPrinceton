// Per-frame camera rotation for a video that pans, made by scripts/track-rotation.py
// (public/world/rotation.json). The projector follows it so the video lands on the part of the
// room the camera was pointing at, instead of staying glued to one wall.
//
//   const track = await loadRotationTrack("/world/rotation.json");   // null when there is none
//   const zoom = track.sample(video.currentTime, quat);              // fills quat, returns the FOV scale
//   projection.aim(quat, zoom);
//
// quat is the camera's rotation relative to the video's first frame, in that frame's own axes
// (three.js camera convention), so the projector's rotation is (frame 0 alignment) * quat.
// track.base is that frame 0 alignment when the tracker could fit it to Marble's panorama.

import * as THREE from "three";

const halfTan = (deg) => Math.tan(THREE.MathUtils.degToRad(deg) / 2);

export async function loadRotationTrack(url) {
  let data;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    data = await res.json(); // Vite answers a missing file with index.html, which fails here
  } catch {
    return null;
  }
  const frames = data?.frames;
  if (!Array.isArray(frames) || frames.length < 2) return null;

  const count = frames.length;
  const times = new Float32Array(count);
  const quats = new Float32Array(count * 4);
  const zooms = new Float32Array(count); // tan(fov/2) relative to frame 0: above 1 = wider than frame 0
  const baseTan = halfTan(frames[0].vfov ?? data.vfov);
  frames.forEach((frame, i) => {
    times[i] = frame.t;
    quats.set(frame.quat, i * 4);
    zooms[i] = halfTan(frame.vfov ?? data.vfov) / baseTan;
  });

  const a = new THREE.Quaternion(), b = new THREE.Quaternion();

  // Fills `out` with the rotation at video time t (seconds) and returns the FOV scale. No allocations.
  function sample(t, out) {
    if (t <= times[0]) { out.fromArray(quats, 0); return zooms[0]; }
    if (t >= times[count - 1]) { out.fromArray(quats, (count - 1) * 4); return zooms[count - 1]; }
    let lo = 0, hi = count - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid; else hi = mid;
    }
    const k = (t - times[lo]) / (times[hi] - times[lo]);
    a.fromArray(quats, lo * 4);
    b.fromArray(quats, hi * 4);
    out.slerpQuaternions(a, b, k);
    return zooms[lo] + (zooms[hi] - zooms[lo]) * k;
  }

  // The "anchored" mapping (frame.g): a 3x3 from a room direction to the frame's picture, which
  // may stretch the video so the people who stay put stay on one spot in the room.
  const hasMatrix = frames.every((frame) => Array.isArray(frame.g) && frame.g.length === 9);
  const mats = hasMatrix ? new Float32Array(count * 9) : null;
  if (hasMatrix) frames.forEach((frame, i) => mats.set(frame.g, i * 9));
  const g = new Float32Array(9);

  // Fills `out` (a Matrix4) with world position -> the video frame's clip space at time t, for a
  // projector standing at `pos` in a room turned by `yaw` radians (the rig's yaw). No allocations.
  function sampleMatrix(t, pos, yaw, out) {
    let lo = 0, hi = count - 1, k = 0;
    if (t <= times[0]) hi = 0;
    else if (t >= times[hi]) lo = hi;
    else {
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= t) lo = mid; else hi = mid;
      }
      k = (t - times[lo]) / (times[hi] - times[lo]);
    }
    for (let i = 0; i < 9; i++) g[i] = mats[lo * 9 + i] + (mats[hi * 9 + i] - mats[lo * 9 + i]) * k;
    // Room direction = Ry(-yaw) * world direction, so fold the turn into the first and third columns.
    const c = Math.cos(yaw), s = Math.sin(yaw), e = out.elements;
    for (let row = 0; row < 3; row++) {
      const a = g[row * 3], b = g[row * 3 + 1], d = g[row * 3 + 2];
      const x = a * c + d * s, z = -a * s + d * c;
      const target = row === 2 ? 3 : row; // rows of the 4x4: x, y, (unused z), w
      e[target] = x; e[4 + target] = b; e[8 + target] = z;
      e[12 + target] = -(x * pos.x + b * pos.y + z * pos.z);
    }
    e[2] = e[6] = e[10] = e[14] = 0;
    return out;
  }

  return {
    sample,
    sampleMatrix: hasMatrix ? sampleMatrix : null,
    vfov: frames[0].vfov ?? data.vfov,
    base: data.base ?? null, // frame 0's { yaw, pitch, roll } in the room, degrees
    duration: times[count - 1],
    source: [data.fov_source, data.base_source].filter(Boolean).join("; "),
  };
}
