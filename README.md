# Party mode starter

Turns an old party video into a Marble 3D room and shows it on a phone in a Google Cardboard. The viewer stands where the original camera was and can only turn their head.

```
scripts/marble.mjs     upload video to Marble, wait, download splats + collider
src/main.js            three.js + Spark viewer, WebXR button, Cardboard fallback
src/projection.js      addProjection() stub, Mac 2 drops the projector in here
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

## For Mac 2: the projection hook

`src/projection.js` exports `addProjection(scene, video, surfaces, opts)`. `main.js` calls it once after everything loads and calls the returned `update(dt)` every frame. The comment at the top of that file lists exactly what you get (the hidden collider meshes, the video element, the camera, the rig at the camera spot). Replace the stub body; nothing else needs to change.

## Known gaps

- Not run against the real Marble API or on a real phone yet. See the notes in the thread.
- The Cardboard fallback has no lens distortion correction, so edges look a bit warped through the lenses.
- The collider GLB's axis convention isn't documented. Use `?debug=1` to check it.
- The "origin = original camera spot" assumption isn't documented by World Labs either. Check it with `?debug=1`.
- `npm install` fails inside a folder that doesn't allow symlinks (some synced or network drives). Copy the folder somewhere local first.
