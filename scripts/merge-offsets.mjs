// Usage: node scripts/merge-offsets.mjs offsets.json cameras.json
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSeats } from '../src/seats.js';

export function applyOffsets(cameras, offsets) {
  if (!Array.isArray(cameras.seats)) throw new Error('cameras.json requires seats[]');
  if (offsets.reference !== 'seatA' || offsets.clips?.seatA?.offsetSeconds !== 0)
    throw new Error('The reference must be seatA with offsetSeconds: 0');
  if (offsets.convention !== 'clipTime = masterTime - offsetSeconds') throw new Error('Unexpected sync convention');
  const names = new Set();
  const warnings = [];
  const seats = cameras.seats.map(seat => {
    if (!seat.name || names.has(seat.name)) throw new Error(`Missing or duplicate seat name: ${seat.name}`);
    names.add(seat.name);
    const match = Object.hasOwn(offsets.clips, seat.name) ? offsets.clips[seat.name] : null;
    if (!Number.isFinite(match?.offsetSeconds)) {
      if (cameras.testOnly && !seat.videoUrl) return { ...seat, offsetSeconds: null };
      throw new Error(`No finite offset for ${seat.name}`);
    }
    if (seat.name !== 'seatA') {
      if (!match.segments?.length) warnings.push(`${seat.name}: no synchronization diagnostics`);
      for (const segment of match.segments ?? []) {
        if (!segment.confidence?.startsWith('high')) warnings.push(`${seat.name}: ${segment.confidence ?? 'unknown confidence'}`);
        if (Math.abs(segment.offsetSeconds - match.offsetSeconds) > 0.25)
          warnings.push(`${seat.name}: segment offsets disagree; fixed-offset playback needs review`);
      }
    }
    return { ...seat, offsetSeconds: match.offsetSeconds };
  });
  if (!names.has('seatA')) throw new Error('Missing master seatA');
  if (!offsets.sharedMasterRanges?.[`${names.size}_of_${Object.keys(offsets.clips).length}_clips`]?.length)
    warnings.push('No reported shared master range for all seats');
  const result = { ...cameras, seats };
  parseSeats(result, { requireOffsets: !cameras.testOnly });
  return { cameras: result, warnings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [offPath, camPath] = process.argv.slice(2);
    if (!offPath || !camPath) throw new Error('Usage: merge-offsets.mjs offsets.json cameras.json');
    if (resolve(offPath) === resolve(camPath)) throw new Error('Offsets and cameras must be separate files');
    const offsets = JSON.parse(readFileSync(offPath, 'utf8'));
    const result = applyOffsets(JSON.parse(readFileSync(camPath, 'utf8')), offsets);
    console.log('Shared master ranges:', JSON.stringify(offsets.sharedMasterRanges ?? {}, null, 2));
    for (const warning of result.warnings) console.warn(`WARNING: ${warning}`);
    if (!result.cameras.testOnly) {
      const dir = dirname(resolve(camPath));
      for (const name of ['venue.spz', 'stage.glb', ...result.cameras.seats.map(s => `${s.name}.mp4`)]) {
        if (!existsSync(resolve(dir, name))) throw new Error(`Missing production asset: ${name}`);
      }
      if (result.warnings.length) throw new Error('Synchronization needs review before production offsets can be applied');
    }
    const tmp = `${camPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(result.cameras, null, 2) + '\n');
    renameSync(tmp, camPath);
    for (const seat of result.cameras.seats) console.log(`${seat.name}: ${seat.offsetSeconds}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
