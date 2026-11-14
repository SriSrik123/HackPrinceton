# Updates

Last updated: Nov 14, 2026 (branch `Sri`)

## Completed

### Party mode

- **KAN-6: Choose party source video.** `public/world/source.mp4` (the pool video, 9 MB).
- **Viewer** (KAN-9, KAN-11 groundwork): three.js + Spark, rig at the camera spot, Enter VR on Android, Cardboard (gyro) fallback, URL overrides. The gyro works on Sri's Android phone.
- **Marble script** (KAN-8 groundwork): `scripts/marble.mjs` uploads, polls and downloads into `public/world/`. Tested only against a local fake API.
- **KAN-10: Video projection** (Soham, merged, In Review): `src/projection.js` projects the video onto the room with faded edges, stand-in box room when there is no collider, test pattern when there is no video. Ran on the Android phone with a test splat and the pool video.
- **KAN-18 work** (Soham): the video starts inside the Cardboard tap (before the motion prompt), and the projection checks occlusion and handles several projections shown and hidden.
- **KAN-15: Upload page** (In Review): `upload.html` + `scripts/upload-server.mjs` start a Marble run from a page; the API key stays on the laptop; optional `UPLOAD_PIN`. Tested against a fake Marble API only.

### Concert mode

- **KAN-14: Concert viewer** (`concert.html`, `src/concert.js`): seats from `cameras.json`, look at a marker for 1.5 s or tap to jump, one projection at a time, one master clock (`clipTime = masterTime - offsetSeconds`). Runs on a dummy scene with fake clips when there is no data.
- **KAN-13 groundwork** (Neven, merged): `scripts/export-cameras.mjs` turns a splatfacto run (`transforms.json` + `dataparser_transforms.json`) into `cameras.json`; table test export in `public/concert-test/cameras.json`; dev test page `test/concert.html`.
- **Neven's cameras.json works in the concert viewer**: open `concert.html?data=concert-test`. Reads his format as is (portrait frame size, null offsets shown as "audio offset unknown"), shrinks markers for normalized units, projects onto a panel in front of each seat while there is no `stage.glb`, and `?venueFlip=1` now flips venue, stage and seats together.
- **Frame extraction** (KAN-13): `npm run extract-frames -- seatA.mp4 seatB.mp4 --walk walkaround.mp4` pulls 2 fps frames with clip-based names into `frames/`, writes `frames.json` (clip and timestamp per frame, plus the `frame_XXXXX` name `ns-process-data` should give it) and `clip-mapping.draft.json` for Neven's exporter.

### Tests

- `node --test test/concert.test.mjs test/frames.test.mjs`: 17 pass (clock, seat parsing including Neven's real file, flip, frame extraction end to end on generated videos).
- Headless Chrome run of `concert.html`: 33 checks pass (jumping, clock, offsets, gaze, real video sync, Neven's seats, flip, `?data` path rejection).

## Not verified yet

- The real Marble API (no paid run yet) and a real Marble room on the phone.
- Concert mode on a phone or in the Cardboard; the real venue splat in the concert viewer (`venue-test.spz` is on Drive, not on this laptop), so seat-to-venue alignment is unchecked here.
- The predicted `frame_XXXXX` names against a real `ns-process-data` run.
- Cardboard lens distortion (none yet), iPhone, frame rate at 500k vs 100k.

## Open

- KAN-8 Marble run, KAN-9 alignment, KAN-11 Cardboard polish (Sri).
- KAN-13 real venue, `stage.glb`, real `cameras.json` (Neven); KAN-12 audio offsets (Dave); KAN-7 clips (Dave).
- KAN-16 backup demo, KAN-17 pitch, KAN-21 set `UPLOAD_PIN` for the final.
