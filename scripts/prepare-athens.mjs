// Export the editable manual layout for Sri's concert viewer. Heavy media stays local.
import { readFile, writeFile, access } from 'node:fs/promises';
import * as THREE from 'three';
const root = new URL('../', import.meta.url);
const layout = JSON.parse(await readFile(new URL('test/athens-seat-layout.json', root), 'utf8'));
const dir = new URL('public/athens-marble/', root);
const world = JSON.parse(await readFile(new URL('world.json', dir), 'utf8'));
if (world.world_id !== layout.worldId) throw new Error('Layout belongs to a different Marble world');
for (const file of ['splat-500k.spz', ...layout.seats.map(s => s.file)]) await access(new URL(file, dir));
const seats = layout.seats.map(s => {
  if (s.surfaceAnchor && Math.abs(s.pos[1] - s.surfaceAnchor.pos[1] - s.surfaceAnchor.eyeHeight) > 0.00001) {
    throw new Error(`${s.name}: camera height disagrees with its surface anchor`);
  }
  const camera = new THREE.PerspectiveCamera();
  camera.position.fromArray(s.pos);
  camera.lookAt(new THREE.Vector3(...(s.target ?? layout.target)));
  return {
    name: `${s.name} (${s.area ? 'Pitch' : s.gate})`, gate: s.gate, row: s.row, seat: s.seat,
    area: s.area ?? 'Bowl seating', bowlReference: s.bowlReference ?? null,
    locationEstimate: s.locationEstimate ?? null, placementNote: s.placementNote ?? layout.placement,
    surfaceAnchor: s.surfaceAnchor ?? null,
    panelPitchOffset: s.panelPitchOffset ?? 0,
    pos: s.pos, quat: camera.quaternion.toArray(), fov: s.fov, width: 1920, height: 1080,
    videoUrl: `/athens-marble/${s.file}`, offsetSeconds: s.offsetSeconds,
  };
});
await writeFile(new URL('cameras.json', dir), JSON.stringify({
  schemaVersion: 1, testOnly: true, worldId: layout.worldId,
  limitations: [layout.placement, 'Audio offsets unknown; equal clip times are not verified synchronization.'],
  venue: { file: 'splat-500k.spz', marble: true },
  playback: { loop: true },
  coordinateSystem: { space: 'marble-metric-preview', quaternion: 'camera-to-world, [x,y,z,w]' },
  seats,
}, null, 2) + '\n');
console.log('Wrote public/athens-marble/cameras.json (approximate seats, unknown audio offsets).');
console.log('Open /concert.html?data=athens-marble&reveal=0&panelDist=3');
