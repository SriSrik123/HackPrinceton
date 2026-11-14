// Run: node --test test/frames.test.mjs  (the end-to-end test needs ffmpeg; it is skipped without it)
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { slug, frameTime, nsNames, buildManifest } from "../scripts/extract-frames.mjs";

const script = new URL("../scripts/extract-frames.mjs", import.meta.url).pathname;
const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"]); return true; } catch { return false; } })();

test("slug keeps names safe", () => {
  assert.equal(slug("clips/Seat A (front).MOV"), "Seat_A_front");
  assert.equal(slug("walk-around.mp4"), "walk-around");
  assert.throws(() => slug("(((.mp4"));
});

test("frameTime: frame 1 at 0 s, then 1/fps apart", () => {
  assert.equal(frameTime(1, 2), 0);
  assert.equal(frameTime(2, 2), 0.5);
  assert.equal(frameTime(7, 3), 2);
});

test("nsNames follow sorted order like ns-process-data", () => {
  const m = nsNames(["seatB_00001.jpg", "photo.JPG", "seatA_00002.jpg", "seatA_00001.jpg"]);
  assert.equal(m.get("photo.JPG"), "images/frame_00001.JPG"); // nerfstudio keeps the suffix
  assert.equal(m.get("seatA_00001.jpg"), "images/frame_00002.jpg");
  assert.equal(m.get("seatB_00001.jpg"), "images/frame_00004.jpg");
});

test("buildManifest: draft mapping only for seat clips, middle frame", () => {
  const clips = [{ slug: "seatA", ext: ".mp4", seat: true, frames: 5 }, { slug: "walk", ext: ".mp4", seat: false, frames: 2 }];
  const files = ["seatA_00001.jpg", "seatA_00002.jpg", "seatA_00003.jpg", "seatA_00004.jpg", "seatA_00005.jpg", "walk_00001.jpg", "walk_00002.jpg"];
  const { manifest, mapping } = buildManifest({ fps: 2, clips, imageFiles: files });
  assert.equal(manifest.frames.length, 7);
  assert.deepEqual(manifest.frames[3], { file: "seatA_00004.jpg", clip: "seatA", time: 1.5, nsFrame: "images/frame_00004.jpg" });
  assert.deepEqual(mapping, [{ name: "seatA", frame: "images/frame_00003.jpg", videoUrl: "/concert/seatA.mp4", offsetSeconds: null, frameTime: 1 }]);
});

test("end to end with generated clips", { skip: !hasFfmpeg && "ffmpeg not installed" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frames-test-"));
  const mk = (name, secs, size) => {
    const f = path.join(dir, name);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `testsrc=duration=${secs}:size=${size}:rate=30`, "-pix_fmt", "yuv420p", f]);
    return f;
  };
  const a = mk("seat A.mp4", 3, "320x568"), b = mk("seatB.mov", 2, "320x180"), w = mk("walk.mp4", 1, "320x180");
  const out = path.join(dir, "frames");
  const runScript = (...args) => execFileSync("node", [script, ...args, "--out", out], { encoding: "utf8" });
  runScript(a, b, "--walk", w);
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "frames.json")));
  const mapping = JSON.parse(fs.readFileSync(path.join(out, "clip-mapping.draft.json")));
  const count = (s) => manifest.frames.filter((f) => f.clip === s).length;
  assert.deepEqual([count("seat_A"), count("seatB"), count("walk")], [6, 4, 2]); // 2 fps
  assert.equal(manifest.frames.length, fs.readdirSync(out).filter((f) => f.endsWith(".jpg")).length);
  assert.deepEqual(mapping.map((m) => m.name), ["seat_A", "seatB"]);
  assert.equal(mapping[1].videoUrl, "/concert/seatB.mov");
  // nsFrame names are a permutation of frame_00001..N in sorted-file order
  const sortedFiles = manifest.frames.map((f) => f.file).sort();
  assert.equal(manifest.frames.find((f) => f.file === sortedFiles[0]).nsFrame, "images/frame_00001.jpg");
  // a second run refuses to overwrite, --force replaces just that clip and keeps the others
  assert.throws(() => runScript(b), /already has 4 frames/);
  runScript(b, "--force");
  const again = JSON.parse(fs.readFileSync(path.join(out, "frames.json")));
  assert.equal(again.frames.length, 12);
  // portrait clips stay portrait
  const dims = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", path.join(out, "seat_A_00001.jpg")], { encoding: "utf8" }).trim();
  assert.equal(dims, "320,568");
  fs.rmSync(dir, { recursive: true, force: true });
});
