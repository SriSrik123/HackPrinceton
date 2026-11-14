# Project context: 3D replay app (HackPrinceton, Nov 13 to 15, 2026)

Read this first. It's the full background for this repo so we can keep working from here.
Written Nov 13, 2026, 6:55 PM ET. Facts about other people's tools were checked on that date and may have changed.

## The idea

A 3D replay app with two modes, built at HackPrinceton (Entertainment track, 36 hours, Princeton).

- **Party mode (this repo):** take an OLD party video (think 10 years old), keep the video as is, and make it more immersive. World Labs Marble builds a 3D room from the video and fills the parts the camera never saw with best guesses (that's fine). The original video is projected back onto the room from the original camera's spot, with faded edges, so it looks seamless. The viewer watches on a phone in a Google Cardboard: head rotation only, standing where the original camera was, so they can "look around a little".
- **Concert mode (separate code, NVIDIA laptops):** several fans' phone clips of the same moment. COLMAP + nerfstudio splatfacto (gsplat) build the venue as a splat, each clip is pinned where it was filmed, synced by audio, and you click a spot to play that view.

The novel part: moving people in 3D from one old phone video is research only (MoSca, Shape of Motion, 4DAnyone). No consumer product found. Static rooms from photos are crowded (Marble, Polycam, Luma, Scaniverse).

## Decisions so far (and why)

- three.js + Spark for viewing splats (Spark is what Marble's own site uses). viser was dropped because it doesn't do custom shaders, and the projection needs one.
- Marble is the room builder for party mode because old videos don't give COLMAP enough clean views. Concert mode keeps COLMAP + gsplat since the team films its own clips.
- SAM 2 people cutouts and Depth Anything were dropped. Projecting the original video replaces them.
- Cardboard: Android Chrome uses WebXR (VRButton). iPhone Safari has no WebXR VR, so it falls back to StereoEffect + the gyro.
- Keep splats small for phones: 500k SPZ by default, 100k if it stutters.
- Brush (Mac splat trainer) backup was skipped because the team has two NVIDIA laptops.
- Any video works for building and testing tonight. Swapping in the final video later is one more Marble run (about 5 min, about $1.28 on marble-1.1) plus re-aligning the projection.

## Team split (4 people)

- **Mac 1, Sri: room + Cardboard.** Pick the video (KAN-6), build the Marble room (KAN-8), load it on the phone (KAN-9), Cardboard view (KAN-11). This repo.
- **Mac 2: projection + upload page.** Project the video onto the room (KAN-10), upload page (KAN-15). Builds the projection on a fake room (floor + three walls) with sliders for position, rotation, FOV and an edge fade, then drops it into `src/projection.js` here. The codrops texture-projection article has a ready-made three.js library for this.
- **NVIDIA 1 (Person 1): concert venue.** Setup (KAN-4), build the venue (KAN-13). Hands off `venue.ply` + `cameras.json` (clip name, position, quaternion, FOV per clip, plus Person 2's audio offset). Films clips with Person 2 (KAN-7). Watch out: splatfacto rescales and recenters, so camera poses need `dataparser_transforms.json` applied.
- **NVIDIA 2 (Person 2): concert clips.** Film clips together with Person 1 (KAN-7), audio sync by cross-correlation (KAN-12), click-to-play viewer in three.js + Spark (KAN-14) with one master clock (each clip's currentTime = master time minus its offset). The team's own filmed footage is the test data and the demo backup.
- Merge Saturday morning (plan an hour or two to line the projection up). Sunday morning: backup demo video and pitch. Tickets live in Jira project HackPrinceton (key KAN), KAN-4 to KAN-17.

## What's in this repo

```
scripts/marble.mjs     upload video -> Marble -> poll -> download into public/world/
src/main.js            three.js + Spark viewer: rig at camera spot, VRButton, Cardboard fallback
src/projection.js      addProjection(scene, video, surfaces, opts) stub for Mac 2
src/lookControls.js    gyro look (DeviceOrientation) + desktop drag-to-look
src/config.js          defaults, all overridable by URL (?splat=100k&flip=0&cam=x,y,z&yaw=90&debug=1)
README.md              how to run, HTTPS for phones, phone testing
```

Scene graph: `scene > world (180 deg X flip) > metric (metric_scale_factor, -ground_plane_offset on Y) > splat + surfaces (collider.glb, hidden)`. The camera sits inside `rig`, which is placed at the camera spot. In WebXR, three.js applies the headset pose relative to the camera's parent, so the rig works in VR too.

## Status (Nov 13, 6:55 PM ET)

Tested: `vite build` passes (Vite 7, three 0.187, Spark 2.4.0). `marble.mjs` ran end to end against a local fake API.
NOT tested: the real Marble API, Spark actually rendering in a browser, and anything on a phone.

First things to check once a real world is downloaded (open with `?debug=1`):
1. Room right side up? If not, `?flip=0`.
2. Green collider wireframe lines up with the splat? If it's upside down relative to the splat, `?colliderFlip=1`.
3. Standing where the camera was? The code assumes the raw Marble origin is the original camera. World Labs doesn't document this, so fix with `?cam=` and `?yaw=` if wrong.
4. Phone frame rate with 500k vs 100k.
5. Does Android Chrome offer Enter VR with the Cardboard, or say not supported? If not supported, the Cardboard (gyro) button is the fallback on both phones.

## Marble API facts (docs.worldlabs.ai, read Nov 13)

- Base `https://api.worldlabs.ai`, header `WLT-Api-Key`. Key goes in env var `WLT_API_KEY`, never in code.
- `POST /marble/v1/media-assets:prepare_upload` {file_name (max 64 chars), kind: "video", extension}. Response `media_asset.media_asset_id` (the overview page says `media_asset.id`; the script accepts both) and `upload_info` {upload_url, upload_method PUT, required_headers}.
- `POST /marble/v1/worlds:generate` {display_name, model (default marble-1.1; also marble-1.0-draft, marble-1.0, marble-1.1-plus), world_prompt: {type: "video", video_prompt: {source: "media_asset", media_asset_id}}}. Video: mp4/webm/mov/avi, max 100MB. 402 = out of credits.
- `GET /marble/v1/operations/{id}` until `done`; check `error` before `response`. About 5 minutes.
- `GET /marble/v1/worlds/{id}` for the full world (the operation's snapshot can have empty fields). Assets: `splats.spz_urls` (100k, 500k, full_res), `splats.semantics_metadata` (metric_scale_factor, ground_plane_offset), `mesh.collider_mesh_url` (GLB), `imagery.pano_url`, `caption`.
- SPZ coordinates are `marble_raw_opencv`; Marble's viewer rotates 180 deg around X. Order: scale, subtract ground offset from Y, then the axis flip. The collider GLB's frame isn't documented.
- Pricing: $1 per 1,250 credits, $5 minimum; a video world is about 1,600 credits (about $1.28) on 1.0/1.1, draft about $0.20.

## Phone testing notes

WebXR and the gyro need HTTPS. `npm run dev` serves HTTPS with a self-signed cert (tap through the warning). If event Wi-Fi blocks phone-to-laptop traffic, use `cloudflared tunnel --url https://localhost:5173 --no-tls-verify` (Vite already allows `.trycloudflare.com`) or a phone hotspot. On iPhone, tap Cardboard (gyro) and Allow motion; tap the screen to recenter.

## Working style for this project

Sri prefers concise, direct answers, no em dashes, and 100% honest advice: say plainly what's tested and what isn't.
