// Seats for concert mode (KAN-14): one per filming spot, read from cameras.json (KAN-13), or a
// dummy set for building and testing before the real venue exists.
//
// A normalized seat:
//   { name, pos: [x, y, z], yaw, pitch, roll, fov, fovAxis, videoUrl, offsetSeconds }
// yaw, pitch and roll are degrees in the convention src/projection.js uses (three.js YXZ Euler,
// yaw + turns left, camera looks down -Z).
//
// cameras.json is still being defined by Person 1 (KAN-13), so the loader accepts the likely shapes:
//   { "seats" | "clips": [ { name, position|pos: [x,y,z], quaternion|quat: [4], fov|fovDegrees,
//                            videoUrl|video, offsetSeconds|offset } ],
//     "quaternionOrder": "xyzw" (default) | "wxyz",
//     "axes": "opengl" (default: camera looks down -Z, y up, what nerfstudio writes) | "opencv" (looks down +Z, y down, what COLMAP writes),
//     "fovAxis": "vertical" (default) | "horizontal" }
// Positions and quaternions must already be in the venue's frame (dataparser_transforms.json applied).

import * as THREE from "three";

const RX180 = new THREE.Quaternion(1, 0, 0, 0); // 180 degrees around X: OpenCV camera frame -> three.js camera frame
const deg = THREE.MathUtils.radToDeg;
const finite = (list) => list.every((n) => Number.isFinite(n));

export function parseSeats(json) {
  const list = Array.isArray(json) ? json : json?.seats ?? json?.clips;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("cameras.json has no seats (expected a \"seats\" or \"clips\" array).");
  }
  const wxyz = json?.quaternionOrder === "wxyz";
  const opencv = json?.axes === "opencv";
  const defaultFovAxis = json?.fovAxis === "horizontal" ? "horizontal" : "vertical";

  return list.map((c, i) => {
    const pos = (c.position ?? c.pos)?.map?.(Number);
    const raw = (c.quaternion ?? c.quat)?.map?.(Number);
    if (!pos || pos.length !== 3 || !finite(pos)) throw new Error(`Seat ${i} needs a position [x, y, z].`);
    if (!raw || raw.length !== 4 || !finite(raw)) throw new Error(`Seat ${i} needs a quaternion with 4 numbers.`);

    const q = wxyz ? new THREE.Quaternion(raw[1], raw[2], raw[3], raw[0]) : new THREE.Quaternion(raw[0], raw[1], raw[2], raw[3]);
    if (q.lengthSq() === 0) throw new Error(`Seat ${i} has a zero quaternion.`);
    q.normalize();
    if (opencv) q.multiply(RX180);
    const e = new THREE.Euler().setFromQuaternion(q, "YXZ");

    return {
      name: c.name ?? `Seat ${i + 1}`,
      pos,
      yaw: deg(e.y), pitch: deg(e.x), roll: deg(e.z),
      fov: Number(c.fov ?? c.fovDegrees ?? 50),
      fovAxis: c.fovAxis ?? defaultFovAxis,
      videoUrl: c.videoUrl ?? c.video ?? null,
      offsetSeconds: Number(c.offsetSeconds ?? c.offset ?? 0),
    };
  });
}

// Horizontal FOV to the vertical FOV that projection.js wants, for a frame with this aspect ratio.
export function verticalFov(horizontalDeg, aspect) {
  return deg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(horizontalDeg) / 2) / aspect));
}

// Three seats facing a flat stage panel 8 m away, with different audio offsets so the master clock
// is visible. videoUrl is set only when you give one (?video=...); otherwise the page draws a fake clip.
export function dummySeats(videoUrl = null) {
  const target = new THREE.Vector3(0, 2, -8);
  const spots = [["Left", [-3, 1.6, -1], 0], ["Center", [0, 1.6, 0], 1.5], ["Right", [3, 1.6, -1], 3]];
  return spots.map(([name, pos, offsetSeconds]) => {
    const cam = new THREE.PerspectiveCamera(); // a camera looks down -Z, like the real clips
    cam.position.set(...pos);
    cam.lookAt(target);
    const e = new THREE.Euler().setFromQuaternion(cam.quaternion, "YXZ");
    return { name, pos, yaw: deg(e.y), pitch: deg(e.x), roll: deg(e.z), fov: 40, fovAxis: "vertical", videoUrl, offsetSeconds };
  });
}
