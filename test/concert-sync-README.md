# Concert synchronization and seat switching

Put the real, matching assets in `public/concert/`:

```
venue.spz
stage.glb
cameras.json
seatA.mp4
seatB.mp4
seatC.mp4
```

`cameras.json` must contain `seats[]`. Each seat's exact name is its sync key
(`seatA`, `seatB`, `seatC`) and its `videoUrl` is `/concert/seatA.mp4`, etc.
Keep the actual `pos`, `quat`, and `fov` from the matching venue coordinate system.
Do not substitute the test camera poses for real filming positions. Example entry
(the position below is illustrative, not a calibrated production pose):

```json
{"name":"seatA","videoUrl":"/concert/seatA.mp4","pos":[0,1.5,2],"quat":[0,0,0,1],"fov":70,"offsetSeconds":0}
```

Run Dave's script directly against the production clips:

```sh
python3 scripts/sync_clips.py --ref seatA \
  --out public/concert/offsets.json --work /tmp/concert-sync \
  seatA=public/concert/seatA.mp4 \
  seatB=public/concert/seatB.mp4 \
  seatC=public/concert/seatC.mp4
node scripts/merge-offsets.mjs public/concert/offsets.json public/concert/cameras.json
```

Python requires numpy and scipy; ffmpeg must be on PATH. Use a **fresh work directory
if any input clip changes**, because Dave's script caches WAV files by clip name.
The matcher needs at least six matching ten-second windows spaced five seconds
apart (roughly 35–40 seconds of shared footage); short samples can yield no match.

The merge command prints shared master ranges and warns about weak/missing confidence
or inconsistent segment offsets. Production writes are blocked on those warnings,
missing assets, missing offsets, or an invalid reference. Resolve the match or choose
better continuous clips and rerun; listen to the overlap before the demo. The command
copies only the top-level offsets, leaves diagnostics in offsets.json untouched, and
validates all seats before atomically replacing cameras.json. Test-only datasets with
`testOnly: true` retain null offsets for fake seats. The production viewer requires
known offsets and a zero-offset seatA; test-only cameras retain their existing fallback.

Open `/concert.html`. Start playback, look at a marker, then tap to switch. Desktop
buttons and screen/WebXR taps use the same transition. Dwell selection is opt-in via
`?dwell=1.5`. A tap away from markers recenters Cardboard; taps during transitions are
ignored. The camera widens its FOV, teleports, and restores FOV without resetting the
master clock. The target uses the clock at teleport time (including elapsed animation
time), so `targetTime = clock.time() - target.offsetSeconds`. Only the selected clip
plays audio; a brief seek/buffering gap is possible. Browser autoplay policy can require
a user gesture. WebXR owns headset projection matrices, so the FOV effect is intended
for desktop and StereoEffect Cardboard, not a guaranteed WebXR headset effect.

Validation:

```sh
node --test test/concert.test.mjs test/frames.test.mjs
npm run build
```

For the real demo, inspect `sharedMasterRanges`, start within a three-clip overlap,
and test every seat pair at several master times. Check negative clip times and ends
of shorter clips (paused/muted/hidden), missing videos (visible error), repeated taps,
and actual Android Cardboard screen taps. Automated tests cover timing, transitions,
media selection, and merge validation; hardware and real-venue alignment require the
actual assets/device. Production assets and offsets are gitignored by the repository;
include them when distributing the demo.
