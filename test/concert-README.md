# Concert reconstruction test

Run `npm ci` and `npm run dev` from the repository root, then open
`https://localhost:5173/test/concert.html` (use the port printed by Vite).

Download the test assets from the [shared Google Drive folder](https://drive.google.com/drive/folders/1v_ADV5Vd7gC-bofLqHq1Ze1uOv-9k_7y).
Request access from the folder owner if needed. Put the files directly in
`public/concert-test/` (avoid an extra nested `concert-test` folder):

- `venue-test.spz`: nerfstudio Gaussian-splat PLY converted to SPZ.
- `transforms.json`: from the processed dataset.
- `dataparser_transforms.json`: from the same training run as the exported splat.
- `images/`: the processed dataset's source images, with filenames matching transforms.json.

Assets are ignored by git; share them separately. No API key is required.

Choose a recorded viewpoint to inspect the splat with portrait/landscape framing
and vertical FOV. Source-photo opacity allows a visual alignment comparison.
The pose conversion accounts for the dataset's applied axis transform and the
training run's transform and scale. Lens distortion, principal-point offsets,
unequal focal lengths and learned pose corrections are not reproduced exactly.
Scene units are normalized reconstruction units, not measured meters.

Enable the photo projection to exercise the shared `src/projection.js` code on
a camera-facing test panel. Orbit around the panel to distinguish a real scene
surface from the source-photo comparison overlay. Return to the projection
viewpoint for alignment. The panel is not fitted venue geometry or a final
stage.glb. This page is a developer test, not concert seat navigation or audio sync.

The browser test has been exercised manually with a rough table reconstruction.
The normal production build does not include this dev-server test page.

## Export camera handoff

From the repository root, run `npm run export-cameras`. This writes
`public/concert-test/cameras.json` with three table viewpoints (frames 4, 18 and
25). It reuses the same pose conversion as the viewer and marks the output
`testOnly: true`. It does not turn walk-around frames into actual concert seats.
Share this ignored JSON alongside the matching SPZ on Drive.

The JSON envelope contains `schemaVersion`, `coordinateSystem`, `timing`,
`limitations` and `seats`. Each seat has `name`, `sourceFrame`, `pos`, `quat`
(camera-to-world, x/y/z/w), `fov` (vertical degrees), `width`, `height`,
`videoUrl`, and `offsetSeconds`. Test video URLs and unknown audio offsets are
null, not invented values. Consumers read `document.seats`; this is a proposed
handoff contract to confirm with Dave/Sri, not an existing viewer loader.

Select other registered frames with:

```bash
npm run export-cameras -- --frames images/frame_00004.jpg,images/frame_00025.jpg
```

For real concert clips, create a local mapping JSON array, one entry per stationary
clip: `[{"name":"Seat A","frame":"images/seatA_00001.jpg","videoUrl":"/concert/seatA.mp4"}]`.
Use exact registered frame names. Dave can add `offsetSeconds` when known.
Place matching transforms.json and dataparser_transforms.json together and run:

```bash
npm run export-cameras -- --data public/concert --clips clip-mapping.json
```

This mode sets `testOnly: false`; it does not verify video steadiness, accuracy,
or playback. Always visually check alignment with the matching venue in Spark.
