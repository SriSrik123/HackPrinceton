#!/usr/bin/env node
// Frame extraction for the concert venue (KAN-13): pulls frames from every clip at a fixed rate
// with clip-based names, and records each frame's clip and timestamp.
//
//   npm run extract-frames -- clips/seatA.mp4 clips/seatB.mp4 --walk clips/walkaround.mp4
//   options: --out frames (default)  --fps 2 (default)  --force (replace this clip's old frames)
//
// Writes into --out:
//   <clip>_00001.jpg ...        frames; feed the whole folder to `ns-process-data images --data <out>`
//   frames.json                 every frame: file, clip, time (seconds into the clip), nsFrame
//   clip-mapping.draft.json     one entry per seat clip (not --walk), for
//                               `npm run export-cameras -- --clips clip-mapping.json` (Neven's exporter)
//
// nsFrame: ns-process-data copies images in sorted filename order and renames them
// images/frame_00001.jpg, frame_00002.jpg, ..., so the clip names are lost. nsFrame is that predicted
// name, for every image in --out at the time this runs (photos you added included). It is only right
// if the folder does not change afterwards: re-run with no clips (`npm run extract-frames -- --out
// frames`) to refresh it after adding photos, and spot-check one frame against the processed images.
//
// The draft mapping picks each clip's middle frame. If that frame did not register in COLMAP (it is
// missing from transforms.json), the exporter says "Unregistered frame": pick another of that
// clip's frames from frames.json. Audio offsets stay null until Dave (KAN-12) fills them in.
// Needs ffmpeg and ffprobe on PATH.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png"]);

// "Seat A (front).MOV" -> "Seat_A_front". Kept to letters, digits, _ and -, so names stay safe on
// every OS and in URLs.
export function slug(file) {
  const s = path.basename(file, path.extname(file)).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!s) throw new Error(`Cannot make a frame name from ${file}`);
  return s;
}

// The fps filter emits output frame k (0-based) at k / fps seconds into the clip.
export const frameTime = (index1, fps) => Math.round(((index1 - 1) / fps) * 1000) / 1000;

// Predicted ns-process-data names for every image in the folder, in its sorted order.
export function nsNames(imageFiles) {
  const sorted = [...imageFiles].sort(); // code-point order, same as Python's sorted() on these names
  return new Map(sorted.map((f, i) => [f, `images/frame_${String(i + 1).padStart(5, "0")}${path.extname(f)}`]));
}

export function buildManifest({ fps, clips, imageFiles }) {
  const names = nsNames(imageFiles);
  const frames = [];
  for (const clip of clips) {
    for (let i = 1; i <= clip.frames; i++) {
      const file = `${clip.slug}_${String(i).padStart(5, "0")}.jpg`;
      frames.push({ file, clip: clip.slug, time: frameTime(i, fps), nsFrame: names.get(file) ?? null });
    }
  }
  const mapping = clips.filter((c) => c.seat && c.frames > 0).map((c) => {
    const mid = Math.ceil(c.frames / 2);
    const file = `${c.slug}_${String(mid).padStart(5, "0")}.jpg`;
    return { name: c.slug, frame: names.get(file), videoUrl: `/concert/${c.slug}${c.ext}`, offsetSeconds: null, frameTime: frameTime(mid, fps) };
  });
  return { manifest: { fps, note: "time = seconds into the clip; nsFrame = predicted ns-process-data name", clips, frames }, mapping };
}

async function probe(file) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=width,height:format=duration", "-of", "json", file]);
  const j = JSON.parse(stdout);
  return { duration: Number(j.format?.duration) || null, width: j.streams?.[0]?.width ?? null, height: j.streams?.[0]?.height ?? null };
}

async function listImages(dir) {
  return (await fs.readdir(dir)).filter((f) => !f.startsWith(".") && IMAGE_EXT.has(path.extname(f).toLowerCase()));
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    out: { type: "string", default: "frames" },
    fps: { type: "string", default: "2" },
    walk: { type: "string", multiple: true, default: [] },
    force: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("npm run extract-frames -- <seat clips...> [--walk walkaround.mp4] [--out frames] [--fps 2] [--force]");
    return;
  }
  const fps = Number(values.fps);
  if (!(fps > 0 && fps <= 30)) throw new Error("--fps must be between 0 and 30.");
  const out = path.resolve(values.out);
  await fs.mkdir(out, { recursive: true });

  const inputs = [...positionals.map((f) => ({ file: f, seat: true })), ...values.walk.map((f) => ({ file: f, seat: false }))];
  const slugs = new Set();
  for (const { file } of inputs) {
    const s = slug(file);
    if (slugs.has(s)) throw new Error(`Two inputs give the same frame name "${s}". Rename one.`);
    slugs.add(s);
    await fs.access(file).catch(() => { throw new Error(`No such file: ${file}`); });
  }

  // Keep what a previous run recorded for clips not given this time, so frames.json stays complete.
  const manifestPath = path.join(out, "frames.json");
  const previous = await fs.readFile(manifestPath, "utf8").then(JSON.parse).catch(() => null);
  if (previous && previous.fps !== fps && inputs.length) {
    throw new Error(`${values.out} already holds frames at ${previous.fps} fps. Use the same --fps or a new --out.`);
  }
  const clips = (previous?.clips ?? []).filter((c) => !slugs.has(c.slug));

  for (const { file, seat } of inputs) {
    const s = slug(file);
    const existing = (await listImages(out)).filter((f) => f.startsWith(`${s}_`));
    if (existing.length && !values.force) throw new Error(`${values.out} already has ${existing.length} frames for "${s}". Add --force to replace them.`);
    await Promise.all(existing.map((f) => fs.rm(path.join(out, f))));

    const info = await probe(file);
    // -q:v 2: high JPEG quality, COLMAP matches better on clean frames. ffmpeg applies the phone's
    // rotation flag, so portrait clips come out portrait.
    await run("ffmpeg", ["-v", "error", "-i", file, "-vf", `fps=${fps}`, "-q:v", "2", path.join(out, `${s}_%05d.jpg`)]);
    const frames = (await listImages(out)).filter((f) => f.startsWith(`${s}_`)).length;
    clips.push({ slug: s, source: path.basename(file), ext: path.extname(file).toLowerCase(), seat, frames, ...info });
    console.log(`${s}: ${frames} frames${info.duration ? ` from ${info.duration.toFixed(1)} s` : ""}${seat ? "" : " (walk-around, no seat)"}`);
  }

  const { manifest, mapping } = buildManifest({ fps: previous?.fps ?? fps, clips, imageFiles: await listImages(out) });
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  await fs.writeFile(path.join(out, "clip-mapping.draft.json"), JSON.stringify(mapping, null, 2) + "\n");
  const other = (await listImages(out)).length - manifest.frames.length;
  console.log(`Wrote ${manifest.frames.length} frames${other ? ` (+${other} other images)` : ""}, frames.json and clip-mapping.draft.json to ${out}`);
  if (mapping.length) console.log("Next: ns-process-data images --data " + values.out + " --output-dir <dataset>, then check nsFrame against <dataset>/images.");
}

if (process.argv[1]?.endsWith("extract-frames.mjs")) { // run as a script, not imported by a test
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
