import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const media = ['cameras.json', 'world.json', 'splat-500k.spz', 'source-sdr.mp4', 'can-browser.mp4', 'krhtikos-browser.mp4'];
export default {
  publicDir: false,
  build: { outDir: 'dist/athens', rollupOptions: { input: 'athens.html' } },
  plugins: [{
    name: 'athens-release-media',
    buildStart() {
      for (const file of media) if (!existsSync(resolve('public/athens-marble', file))) this.error(`Missing Athens asset: ${file}. Run node scripts/prepare-athens.mjs.`);
    },
    closeBundle() {
      mkdirSync('dist/athens/athens-marble', { recursive: true });
      for (const file of media) copyFileSync(resolve('public/athens-marble', file), resolve('dist/athens/athens-marble', file));
      copyFileSync('dist/athens/athens.html', 'dist/athens/index.html');
    },
  }],
};
