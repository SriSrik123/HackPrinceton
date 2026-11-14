# Updates (party mode, Mac 1)

Last updated: Nov 13, 2026

## Completed

- **KAN-6: Choose party source video.** Source video picked and saved as `public/world/source.mp4` (9 MB, under Marble's 100 MB limit).
- **Viewer scaffold** (supports KAN-9, KAN-11): three.js + Spark viewer, rig at camera spot, VRButton on Android, StereoEffect + gyro fallback for iPhone, URL overrides (`?splat`, `?flip`, `?cam`, `?yaw`, `?debug`). `vite build` passes.
- **Marble script** (supports KAN-8): `scripts/marble.mjs` uploads video, polls, downloads into `public/world/`. Ran end to end against a local fake API.
- **Projection stub** (supports KAN-10): `src/projection.js` `addProjection(scene, video, surfaces, opts)` for Mac 2 to fill in.
- **Test splat on phone:** a placeholder `.spz` (not from the pool video) loads and renders in Chrome on the Android phone over USB (`adb reverse`), so Spark rendering works there.

## In progress

- Nothing. KAN-8 has not started: the Marble run on the pool video has not been done. `public/world/splat-500k.spz` is a random test file, not the real room.

## Not verified yet

- Spark rendering in a real browser, anything on a phone, Cardboard on Android/iPhone, frame rate at 500k vs 100k.

## Not started (Mac 1)

- KAN-9 load room on phone, KAN-11 Cardboard view.
