// ---------------------------------------------------------------------------
// PROJECTION HOOK (Mac 2 owns this file)
// ---------------------------------------------------------------------------
// Replace the body of addProjection with the real projector. main.js calls it once,
// after the splat, the collider mesh and the video are loaded.
//
// What you get:
//   scene     THREE.Scene. The splat lives under scene > "world" > "metric".
//   video     HTMLVideoElement with the original party video. Already loaded, not playing yet
//             (it starts when the user taps Start / Enter VR, because phones need a tap).
//   surfaces  THREE.Group from collider.glb, in the same space as the splat.
//             Its meshes are hidden by default (visible = false). Give them your projection
//             material and set visible = true on whatever should show the video.
//   opts.camera        the viewer's camera (head). Its parent is opts.rig.
//   opts.rig           THREE.Group at the original camera spot. rig.getWorldPosition() is
//                      where the projector should sit.
//   opts.config        values from config.js (+ URL overrides)
//   opts.world         world.json contents (world_id, semantics_metadata, ...)
//
// Suggested approach: new THREE.VideoTexture(video), a projector camera at the rig position
// using the original video's field of view, and a shader that maps each surface point into
// that projector's clip space (projective texturing). Fade the edges so the splat shows
// around the video frame.
//
// Return an object with an optional update(dt) that main.js calls every frame,
// and an optional dispose().
// ---------------------------------------------------------------------------

export function addProjection(scene, video, surfaces, opts = {}) {
  console.info("[projection] stub called; no projection yet", {
    surfaceMeshes: countMeshes(surfaces),
    video: video ? `${video.videoWidth}x${video.videoHeight}` : "none",
  });
  return {
    update(_dt) {},
    dispose() {},
  };
}

function countMeshes(root) {
  let n = 0;
  root?.traverse((o) => { if (o.isMesh) n++; });
  return n;
}
