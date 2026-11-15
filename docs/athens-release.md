# Athens release viewer

Open `/athens.html` for the clean Athens entry point. It uses the existing Marble world and the manual seat layout, with looping clips, viewpoint switching, Pause/Resume and Cardboard controls. No World Labs request or generation credits are used.

Build in the Ubuntu repository terminal (where the Linux dependencies are installed):

```bash
cd /mnt/c/Users/nevzu/HackPrinceton
npm run build:athens
```

The output is `dist/athens/`, including `index.html`, bundled code, and only the six runtime assets in `athens-marble/`. Host that directory at a site's root over HTTPS for phone motion controls. Keep the entire directory together. No original HDR clip, collider, test screenshots, API keys, or unrelated datasets are copied into this release.

To preview the build with Vite, run `npm run preview -- --outDir dist/athens` and open the address printed by Vite. Use the HTTPS development server for Cardboard testing if the preview is served over plain HTTP.

The release page is a deployable presentation of the current assets, not a new reconstruction or a verified synchronized production capture. `cameras.json` deliberately retains `testOnly: true`: audio offsets remain unknown, seat locations are approximate, and the existing strict production data contract is not bypassed by relabeling the dataset. The audience page retains these limitations in short form.

Looping is enabled by the generated dataset's `playback.loop` setting; `?loop=0` disables it and `?loop=1` enables it explicitly. Each clip wraps at its own duration on the master clock. Looping does not infer audio offsets or make different recordings synchronized.

Adjust `test/athens-seat-layout.json` and run `node scripts/prepare-athens.mjs` to regenerate cameras. Heavy media remains gitignored and must be distributed separately or in the built release folder.
