#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as THREE from 'three';
import { recordedViews } from '../test/camera-poses.js';

const { values } = parseArgs({ options: {
  data: { type: 'string', default: 'public/concert-test' },
  output: { type: 'string' },
  frames: { type: 'string' },
  clips: { type: 'string' },
  help: { type: 'boolean', default: false },
} });

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function main() {
  if (values.help) {
    console.log('npm run export-cameras -- [--data DIR] [--output FILE] [--frames path1,path2 | --clips mapping.json]');
    console.log('Default: export three table test viewpoints with no video URLs or audio offsets.');
    return;
  }
  if (values.frames && values.clips) throw new Error('Use --frames or --clips, not both.');
  const data = path.resolve(values.data);
  const [meta, parser] = await Promise.all([
    readJson(path.join(data, 'transforms.json')),
    readJson(path.join(data, 'dataparser_transforms.json')),
  ]);
  const views = recordedViews(meta, parser);
  const byName = new Map(views.map(view => [view.name, view]));
  const testOnly = !values.clips;
  const mapping = values.clips ? await readJson(values.clips) :
    (values.frames?.split(',') ?? ['images/frame_00004.jpg', 'images/frame_00018.jpg', 'images/frame_00025.jpg'])
      .map((frame, index) => ({ name: `Test viewpoint ${index + 1}`, frame: frame.trim() }));
  if (!Array.isArray(mapping) || !mapping.length) throw new Error('Mapping must be a nonempty array.');
  const names = new Set();
  const seats = mapping.map(entry => {
    if (typeof entry.name !== 'string' || !entry.name.trim() || names.has(entry.name)) {
      throw new Error('Every viewpoint needs a unique, nonempty name.');
    }
    names.add(entry.name);
    const view = byName.get(entry.frame);
    if (!view) throw new Error(`Unregistered frame: ${entry.frame}. Use its exact transforms.json file_path.`);
    if (!testOnly && (typeof entry.videoUrl !== 'string' || !entry.videoUrl.trim())) {
      throw new Error(`Missing videoUrl for ${entry.name}`);
    }
    if (entry.offsetSeconds != null && !Number.isFinite(entry.offsetSeconds)) {
      throw new Error(`Invalid audio offset for ${entry.name}`);
    }
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    view.pose.decompose(pos, quat, new THREE.Vector3());
    if (Math.abs(view.pose.determinant() - 1) > 0.001) throw new Error(`Non-rigid camera pose: ${entry.frame}`);
    quat.normalize();
    return {
      name: entry.name, sourceFrame: view.name,
      pos: pos.toArray(), quat: quat.toArray(), fov: view.fov,
      width: view.width, height: view.height,
      videoUrl: entry.videoUrl ?? null,
      offsetSeconds: entry.offsetSeconds ?? null,
    };
  });
  const result = {
    schemaVersion: 1, testOnly,
    coordinateSystem: {
      space: 'nerfstudio-training-export', handedness: 'right',
      units: 'normalized-scene-units-not-meters',
      cameraAxes: '+X right, +Y up, -Z forward',
      quaternion: 'camera-to-world, [x,y,z,w]',
      fov: 'vertical degrees, centered-pinhole approximation',
      previewFlipApplied: false,
    },
    timing: { convention: 'clipTime = masterTime - offsetSeconds', unknownOffset: null },
    limitations: [
      'No lens distortion, principal-point offset, unequal-focal-length or learned pose correction.',
      'One pose per video requires a stationary segment; sourceFrame identifies the registered frame.',
      'Keep this file with the matching SPZ and training metadata; do not apply the training transform twice.',
    ],
    seats,
  };
  const output = path.resolve(values.output ?? path.join(data, 'cameras.json'));
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(`Exported ${seats.length} ${testOnly ? 'TEST viewpoints (not concert seats)' : 'mapped clip poses'} to ${output}`);
  if (seats.some(seat => seat.offsetSeconds === null)) console.log('Audio offsets are unknown (null); Dave must supply them before synchronized playback.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
