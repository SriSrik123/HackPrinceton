# Rewind

A 3D replay app with two modes. **Party mode** turns an old party video into a Marble 3D room and shows it on a phone in a Google Cardboard. The viewer stands where the original camera was and can only turn their head.

```
scripts/marble.mjs     upload video to Marble, wait, download splats + collider
src/main.js            three.js + Spark viewer, WebXR button, Cardboard fallback
src/projection.js      addProjection(): projects the video onto the room (see Projection below)
test/projection.html   projection test bench: fake room, sliders, several sources (dev server only)
src/concert.js         concert mode viewer (seats, gaze jump, master clock); seats.js, masterClock.js
scripts/extract-frames.mjs  concert clips -> frames for COLMAP, with timestamps
scripts/export-cameras.mjs  splatfacto run -> cameras.json (Neven)
scripts/sync_clips.py       audio sync of concert clips -> offsets.json (Dave)
scripts/merge-offsets.mjs   copies those offsets into cameras.json
src/lookControls.js    gyro look (iPhone/Cardboard fallback) and drag-to-look on desktop
src/config.js          start position, splat size, flip toggles (all overridable from the URL)
public/world/          where the script saves the world (the page reads from here)
```

## Setup

Needs Node 18 or newer (`node -v`).

```bash
cd party-mode
npm install
```

## 1. Make the world (costs Marble credits)

Get an API key from the World Labs platform, then:

```bash
export WLT_API_KEY=your_key_here
npm run marble -- ~/Videos/party.mp4 --name "Party 2016"
```

It uploads the video, starts generation (`marble-1.1` by default, `--model marble-1.1-plus` or `--model marble-1.0-draft` to change), polls every 10 s (about 5 minutes), then saves into `public/world/`:

- `splat-500k.spz` and `splat-100k.spz`
- `collider.glb` (the surfaces the projection uses)
- `world.json` (world id, scale metadata, caption, video filename)
- `source.mp4` (a copy of your video, for the projection)

If it dies while waiting, it prints the resume command: `npm run marble -- --op <operation_id>`. To re-download a finished world: `npm run marble -- --world <world_id> ~/Videos/party.mp4`.

Video rules from the Marble docs: mp4, webm, mov or avi, max 100 MB. To shrink a long or 4K clip:

```bash
ffmpeg -i party.mov -vf scale=-2:720 -c:v libx264 -crf 26 -c:a aac -b:a 128k party_720.mp4
```

### Or from the upload page (KAN-15)

Same Marble run, started from a page instead of the terminal:

```bash
export WLT_API_KEY=your_key_here
npm run upload-server        # keeps the key on this computer, listens on 127.0.0.1:8787
npm run dev                  # in a second terminal, then open https://localhost:5173/upload.html
```

Pick a video, tick the box that says it spends credits and replaces `public/world/`, and press Build. The page shows the real state (uploading to this computer, sending to Marble, building, downloading, ready, or the error). Only one run can go at a time. Set `UPLOAD_PIN=1234` before starting the server if the network is shared, because anyone who can open the dev server page can otherwise start a paid run. The server runs `scripts/marble.mjs`, so the output is identical. Concert mode shows a "prepared example" card only; nothing uploaded is processed for concert mode.

## Concert mode (KAN-14)

A separate page, `https://localhost:5173/concert.html`, reusing the party code (`main.js` is untouched). You stand at one seat (a filming spot), look around, and jump to another seat by looking at its marker for 1.5 s or tapping the Cardboard button while looking at it. Each seat projects its own clip onto the stage from its spot (`src/projection.js`); only the current seat's clip shows. All clips run from one master clock, `clipTime = masterTime - offsetSeconds` (`src/masterClock.js`), so the music keeps going when you jump.

With no data it shows a dummy scene: three seats, a flat stage panel, and fake clips that draw their own clip time (so you can see the offsets). Real data goes in `public/concert/`:

- `cameras.json`: seats, see the comment at the top of `src/seats.js` for the accepted shape (quaternion order, `axes`, `fovAxis`, offsets).
- `stage.glb`: the invisible stage panel (and floor) the clips are projected onto.
- `venue.spz`: the venue splat that fills in around the projection.

`venue-test.spz` is also accepted in place of `venue.spz`. Without `stage.glb`, each seat projects onto a flat panel `?panelDist` (default 1 scene unit) in front of it.

URL options: `?data=concert-test` (read another folder of `public/`, for example Neven's table test), `?seat=2`, `?t=30` (start master time), `?video=/world/source.mp4` (one real video for every seat without its own), `?dwell=1.5`, `?autoplay=1`, `?venueFlip=1` (turns venue, stage and seats together), `?panelDist=1`, `?markerScale=`, `?debug=1`. Tests: `node --test test/concert.test.mjs test/frames.test.mjs`.

### From clips to cameras.json

1. Frames for COLMAP, 2 per second, clip-based names and timestamps:
   ```bash
   npm run extract-frames -- clips/seatA.mp4 clips/seatB.mp4 --walk clips/walkaround.mp4
   ```
   Writes `frames/` with the images, `frames.json` (clip and time of every frame, and the `images/frame_XXXXX` name `ns-process-data` should give it) and `clip-mapping.draft.json` (one seat per clip, middle frame, `offsetSeconds: null`). Add photos to `frames/` first, then re-run `npm run extract-frames -- --out frames` so the predicted names include them. Spot-check one name against the processed images.
2. `ns-process-data images --data frames ...`, train and export (Neven, see `test/concert-README.md`).
3. Copy the draft mapping to `clip-mapping.json`, swap any frame the exporter calls unregistered for another frame of that clip from `frames.json`, add Dave's offsets, then `npm run export-cameras -- --data public/concert --clips clip-mapping.json`.

## 2. Run the viewer

```bash
npm run dev
```

Desktop: open the `https://localhost:5173` link, accept the certificate warning, drag to look around.

URL options (no rebuild needed): `?splat=100k`, `?flip=0`, `?colliderFlip=1`, `?metricScale=0`, `?cam=0,1.5,0`, `?yaw=90`, `?eyeSep=0.06`, `?debug=1`. Defaults live in `src/config.js`.

First run: open with `?debug=1`. You'll see the collider as a green wireframe and an axes helper. Check that:

1. The room is right side up. If not, try `?flip=0`.
2. The wireframe lines up with the splat. If it's upside down relative to it, try `?colliderFlip=1`.
3. You're standing where the camera was. If not, set `?cam=x,y,z` and `?yaw=`.

## 3. Test on the phone

WebXR and the gyro only work over HTTPS, which is why the dev server uses a self-signed cert.

**Same Wi-Fi:** run `npm run dev`, find the Mac's IP with `ipconfig getifaddr en0`, open `https://<that-ip>:5173` on the phone and tap through the certificate warning (Advanced, then Proceed / Visit website).

**If the phone can't reach the Mac** (campus and event Wi-Fi often blocks device-to-device traffic): use a tunnel.

```bash
brew install cloudflared
cloudflared tunnel --url https://localhost:5173 --no-tls-verify
```

Open the `https://….trycloudflare.com` link it prints on the phone. That one has a real certificate, so no warning. A phone hotspot with the Mac joined to it is the other option.

**Android (Chrome):** tap **Enter VR**, put the phone in the Cardboard. If the button says VR not supported, use **Cardboard (gyro)** instead.

**iPhone (Safari):** WebXR VR isn't available, so tap **Cardboard (gyro)** and tap **Allow** on the motion prompt. The phone goes side-by-side; tap the screen to recenter. To get out, tap **Exit** in the corner.

If it stutters, add `?splat=100k`.

## Projection

`src/projection.js` plays the original video back onto the room from the original camera's spot, like a slide projector. Each point of `collider.glb` looks up where it falls in the projector's view: inside the frame it shows that video pixel, outside it the splat shows through, and the frame's edges fade out. `main.js` calls `addProjection(scene, video, surfaces, opts)` once and `update(dt)` every frame. The file never starts the video itself.

It also covers the cases where something is missing:

- No `collider.glb`: it projects onto a stand-in box room (floor, ceiling, three walls) built around the projector. Good enough to see the video, but it will not match the real room.
- No `"video"` in `world.json`: it shows a test pattern (grid, red crosshair, TOP / BOTTOM / LEFT / RIGHT) so you can still line things up.
- The collider meshes stay invisible. With `?debug=1` you also get their wireframe, the projector's frustum, and `projection` in the browser console.

URL options (no rebuild needed). Every param in `DEFAULTS` at the top of `src/projection.js` has one: `proj` plus the param name.

| Option | Default | What it does |
| --- | --- | --- |
| `?projPos=x,y,z` | the rig (camera spot) | Projector position, meters, world space |
| `?projYaw=` | the rig's yaw (`?yaw=`) | Degrees. Plus turns left |
| `?projPitch=` | 0 | Degrees. Plus looks up |
| `?projRoll=` | 0 | Degrees. Plus tilts counter-clockwise |
| `?projFov=` | 50 | Vertical field of view, degrees. Landscape phone video is about 40 to 50, portrait about 65 |
| `?projFade=` | 0.12 | Soft edge width, as a fraction of the frame. 0 is a hard edge |
| `?projOpacity=` | 1 | 0 to 1 |
| `?projBrightness=`, `?projSaturation=`, `?projTint=ffcc88` | 1, 1, ffffff | Color match the video to the splat |
| `?projShading=`, `?projAmbient=` | 0.6, 0.35 | How much surfaces facing away from the projector darken, and the darkest they get |
| `?projEnabled=0` | 1 | Hide the projection |
| `?projRoomSize=w,h,d`, `?projRoomEye=`, `?projRoomBehind=` | 4,2.6,5 / 1.4 / 0.1 | Stand-in room size, projector height above its floor, floor behind the projector (meters) |

How to line it up:

1. Open with `?debug=1` and do the three checks in section 2 first (room upright, wireframe on the splat, standing at the camera's spot). The projector starts at the same spot and yaw as the viewer.
2. Set `?projFov=` first. Too small and the video's walls look narrower than the room's, too big and they look wider. The value is a guess until tuned: the real camera's field of view is not known.
3. Then `?projYaw=`, `?projPitch=` and `?projRoll=` until the video's corners and edges sit on the room's.
4. Only touch `?projPos=` if nearby objects are still off after that.
5. Match colors with `?projBrightness=`, `?projSaturation=` and `?projTint=`, and widen `?projFade=` until the frame's border disappears.

To tune live, use the console in debug mode, for example `projection.update({ fov: 44, yaw: 3 })`, then copy the values that work into the URL. `projection.params` shows the current values.

For sliders, run `npm run dev` and open `https://localhost:5173/test/projection.html`. It is a fake room where you can add several videos or photos, look through each projector, and copy the poses as JSON. It is not part of `npm run build`.

For concert mode: call `addProjection(scene, clipVideo, stageGlb, { pos, yaw, pitch, roll, fov })` once per seat and show one at a time with `update({ enabled: false })`. Several projections can share the same meshes. Values passed in code win over the URL.

Occlusion is not handled. Seen from the projector's own spot this is invisible, because every surface along a ray shows the same video pixel. From anywhere else, a surface hidden behind furniture still gets a copy of the video, and the furniture does not hide the projection behind it. So keep the viewer at the projector: if you move the projector with `?projPos=`, set `?cam=` to the same place. The console warns when they are more than 5 cm apart.

## Known gaps

- Not run against the real Marble API or on a real phone yet. See the notes in the thread.
- The Cardboard fallback has no lens distortion correction, so edges look a bit warped through the lenses.
- The projection is tested on desktop Chrome with stand-in data only (a fake splat, a test video, a hand-made collider). Not tested yet: a real Marble room, WebXR, or a phone.
- The collider GLB's axis convention isn't documented. Use `?debug=1` to check it.
- The "origin = original camera spot" assumption isn't documented by World Labs either. Check it with `?debug=1`.
- `npm install` fails inside a folder that doesn't allow symlinks (some synced or network drives). Copy the folder somewhere local first.

## Credits

Built at HackPrinceton 2026.

- Sri: room and Cardboard view (party mode)
- Dave (David Densmore): concert clip audio sync (`scripts/sync_clips.py`, KAN-12)
- Neven: concert venue and `cameras.json` export
