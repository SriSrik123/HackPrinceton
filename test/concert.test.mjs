// Run: node --test test/concert.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { MasterClock, clipTime, planClip } from "../src/masterClock.js";
import { parseSeats, dummySeats, verticalFov } from "../src/seats.js";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
// where a seat's camera looks, rebuilt from the yaw/pitch/roll the projection will use
const forward = (s) => new THREE.Vector3(0, 0, -1).applyEuler(
  new THREE.Euler(THREE.MathUtils.degToRad(s.pitch), THREE.MathUtils.degToRad(s.yaw), THREE.MathUtils.degToRad(s.roll), "YXZ"));

test("master clock runs, pauses, seeks", () => {
  let ms = 1000;
  const c = new MasterClock(() => ms);
  near(c.time(), 0);
  ms += 5000; near(c.time(), 0); // paused: time does not move
  c.play(); ms += 2500; near(c.time(), 2.5);
  c.pause(); ms += 9000; near(c.time(), 2.5);
  c.seek(10); near(c.time(), 10);
  c.play(); ms += 1000; near(c.time(), 11);
  c.seek(3); ms += 500; near(c.time(), 3.5);
});

test("clipTime = masterTime - offset", () => {
  near(clipTime(12, 1.5), 10.5);
  near(clipTime(1, 3), -2);
});

test("planClip: before, playing (with and without a seek), after", () => {
  assert.deepEqual(planClip({ clipTime: -0.1, duration: 30, videoTime: 0 }), { state: "before", seekTo: null });
  assert.deepEqual(planClip({ clipTime: 10, duration: 30, videoTime: 10.1 }), { state: "playing", seekTo: null });
  assert.deepEqual(planClip({ clipTime: 10, duration: 30, videoTime: 12 }), { state: "playing", seekTo: 10 });
  assert.deepEqual(planClip({ clipTime: 30, duration: 30, videoTime: 29.9 }), { state: "after", seekTo: null });
  assert.deepEqual(planClip({ clipTime: 5, duration: NaN, videoTime: 0 }), { state: "playing", seekTo: 5 }); // metadata not loaded yet
  assert.deepEqual(planClip({ clipTime: 5, duration: Infinity, videoTime: 5 }), { state: "playing", seekTo: null });
});

test("parseSeats: identity looks down -Z, yaw 90 turns left", () => {
  const [a] = parseSeats({ seats: [{ name: "A", position: [1, 2, 3], quaternion: [0, 0, 0, 1], fov: 50, videoUrl: "a.mp4", offsetSeconds: 2 }] });
  assert.equal(a.name, "A"); assert.deepEqual(a.pos, [1, 2, 3]); near(a.yaw, 0); near(a.offsetSeconds, 2); assert.equal(a.videoUrl, "a.mp4");
  const h = Math.SQRT1_2;
  const [b] = parseSeats([{ position: [0, 0, 0], quaternion: [0, h, 0, h] }]); // +90 degrees around Y
  near(b.yaw, 90);
  const f = forward(b); near(f.x, -1); near(f.z, 0); // turned left from -Z is -X
});

test("parseSeats: wxyz order gives the same seat as xyzw", () => {
  const h = Math.SQRT1_2;
  const [xyzw] = parseSeats({ clips: [{ position: [0, 0, 0], quaternion: [0, h, 0, h] }] });
  const [wxyz] = parseSeats({ clips: [{ position: [0, 0, 0], quaternion: [h, 0, h, 0] }], quaternionOrder: "wxyz" });
  near(xyzw.yaw, wxyz.yaw);
});

test("parseSeats: opencv axes flip the camera to look down +Z", () => {
  const [s] = parseSeats({ seats: [{ position: [0, 0, 0], quaternion: [0, 0, 0, 1] }], axes: "opencv" });
  const f = forward(s); near(f.x, 0, 1e-9); near(f.y, 0, 1e-9); near(f.z, 1, 1e-9);
});

test("parseSeats: bad input is rejected with a clear message", () => {
  assert.throws(() => parseSeats({}), /no seats/);
  assert.throws(() => parseSeats({ seats: [{ quaternion: [0, 0, 0, 1] }] }), /position/);
  assert.throws(() => parseSeats({ seats: [{ position: [0, 0, 0], quaternion: [0, 0, 1] }] }), /quaternion/);
  assert.throws(() => parseSeats({ seats: [{ position: [0, 0, "x"], quaternion: [0, 0, 0, 1] }] }), /position/);
  assert.throws(() => parseSeats({ seats: [{ position: [0, 0, 0], quaternion: [0, 0, 0, 0] }] }), /zero/);
});

test("verticalFov: 16:9 horizontal 90 -> about 58.7 vertical", () => {
  near(verticalFov(90, 16 / 9), 58.715, 0.01);
});

test("dummySeats face the stage", () => {
  const seats = dummySeats();
  assert.equal(seats.length, 3);
  for (const s of seats) {
    const toStage = new THREE.Vector3(0, 2, -8).sub(new THREE.Vector3(...s.pos)).normalize();
    assert.ok(forward(s).dot(toStage) > 0.9999, `${s.name} does not face the stage`);
  }
});

// Neven's exporter output (scripts/export-cameras.mjs), checked in as public/concert-test/cameras.json
import fs from "node:fs";
import { seatSpacing } from "../src/seats.js";
const neven = JSON.parse(fs.readFileSync(new URL("../public/concert-test/cameras.json", import.meta.url)));

test("parseSeats reads Neven's cameras.json: pose, portrait aspect, unknown offsets", () => {
  const seats = parseSeats(neven);
  assert.equal(seats.length, 3);
  neven.seats.forEach((raw, i) => {
    const s = seats[i];
    assert.deepEqual(s.pos, raw.pos);
    near(s.fov, raw.fov);
    near(s.aspect, 1280 / 2276);
    assert.equal(s.videoUrl, null);
    assert.equal(s.offsetSeconds, 0);
    assert.equal(s.offsetKnown, false);
    // the yaw/pitch/roll the projection uses must aim where the camera-to-world quaternion does
    const q = new THREE.Quaternion(...raw.quat).normalize();
    const want = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    assert.ok(forward(s).distanceTo(want) < 1e-6);
  });
});

test("parseSeats flip turns positions and view directions 180 degrees around X", () => {
  const plain = parseSeats(neven), flipped = parseSeats(neven, { flip: true });
  const rx = new THREE.Quaternion(1, 0, 0, 0);
  plain.forEach((s, i) => {
    const f = flipped[i];
    assert.deepEqual(f.pos, [s.pos[0], -s.pos[1], -s.pos[2]]);
    assert.ok(forward(f).distanceTo(forward(s).applyQuaternion(rx)) < 1e-6);
  });
});

test("seatSpacing: closest pair, Infinity for one seat", () => {
  near(seatSpacing(dummySeats()), Math.hypot(6, 2, 6));
  assert.equal(seatSpacing(dummySeats().slice(0, 1)), Infinity);
  assert.ok(seatSpacing(parseSeats(neven)) < 1); // normalized units: markers must shrink
});

import { applyOffsets } from '../scripts/merge-offsets.mjs';
import { SeatTransition } from '../src/seatTransition.js';
import { VideoClip } from '../src/videoClip.js';
const production = () => ({ seats: ['seatA', 'seatB', 'seatC'].map(name => ({
  name, pos: [0, 1.5, 2], quat: [0, 0, 0, 1], fov: 70, videoUrl: `/concert/${name}.mp4`, offsetSeconds: null,
})) });
const syncResult = () => ({ reference: 'seatA', convention: 'clipTime = masterTime - offsetSeconds',
  clips: Object.fromEntries(['seatA', 'seatB', 'seatC'].map((name, i) => [name, {
    offsetSeconds: i * 0.347, segments: [{ offsetSeconds: i * 0.347, confidence: 'high (+/-0.02 s)' }],
  }])), sharedMasterRanges: { '3_of_3_clips': [{ masterStart: 1, masterEnd: 40 }] },
});

test('offset application matches exact names, preserves poses and diagnostics', () => {
  const cameras = production(), offsets = syncResult(), original = structuredClone(offsets);
  const result = applyOffsets(cameras, offsets);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.cameras.seats[0].offsetSeconds, 0);
  assert.equal(result.cameras.seats[1].offsetSeconds, 0.347);
  assert.deepEqual(result.cameras.seats[1].pos, cameras.seats[1].pos);
  assert.deepEqual(offsets, original);
  assert.equal(cameras.seats[1].offsetSeconds, null);
  parseSeats(result.cameras, { requireOffsets: true });
  delete offsets.clips.seatB;
  assert.throws(() => applyOffsets(cameras, offsets), /seatB/);
  offsets.clips.SeatB = original.clips.seatB;
  assert.throws(() => applyOffsets(cameras, offsets), /seatB/);
});

test('invalid master, missing offsets, weak matches and shared ranges are reported', () => {
  const offsets = syncResult();
  offsets.clips.seatA.offsetSeconds = 1;
  assert.throws(() => applyOffsets(production(), offsets), /reference/);
  offsets.clips.seatA.offsetSeconds = 0;
  offsets.clips.seatB.offsetSeconds = null;
  assert.throws(() => applyOffsets(production(), offsets), /seatB/);
  offsets.clips.seatB.offsetSeconds = 0.347;
  offsets.clips.seatB.segments[0].confidence = 'low (+/-0.15 s, check by ear)';
  offsets.sharedMasterRanges = {};
  const { warnings } = applyOffsets(production(), offsets);
  assert.ok(warnings.some(w => w.includes('low')));
  assert.ok(warnings.some(w => w.includes('shared')));
  assert.throws(() => parseSeats(production(), { requireOffsets: true }), /master/);
  assert.equal(parseSeats(production())[0].offsetKnown, false);
});

test('transition teleports once, rejects repeated taps and preserves the running clock in both directions', () => {
  let ms = 0, fov = 70;
  const clock = new MasterClock(() => ms);
  clock.seek(20); clock.play();
  const moves = [], events = [];
  const transition = new SeatTransition({ time: () => clock.time(),
    hide: () => events.push('hide'),
    teleport: (seat, master) => { events.push('move'); moves.push([seat, master]); },
    setFov: value => { fov = value; },
  });
  for (const target of [1, 2, 0, 2, 1, 0]) {
    assert.ok(transition.start(target, 70));
    assert.equal(transition.start(99, 70), false);
    ms += 150; transition.update(0.15); assert.ok(fov > 70);
    const count = moves.length;
    ms += 150; transition.update(0.15);
    assert.equal(moves.length, count + 1);
    assert.deepEqual(moves.at(-1), [target, clock.time()]);
    assert.deepEqual(events.slice(-2), ['hide', 'move']);
    ms += 300; transition.update(0.3);
    assert.equal(transition.active, false); near(fov, 70);
    assert.equal(clock.playing, true);
  }
  near(clock.time(), 23.6);
});

test('video selection seeks exactly, silences inactive clips, handles duration and delayed metadata', () => {
  const video = { currentTime: 0, duration: 30, readyState: 1, paused: true, muted: true,
    addEventListener() {}, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } };
  const clip = new VideoClip('seatB.mp4', () => video);
  clip.sync(0.1, true, true, true); near(video.currentTime, 0.1);
  assert.equal(video.muted, false); assert.equal(video.paused, false);
  clip.sync(12 - 0.347, true, true); near(video.currentTime, 11.653);
  clip.sync(13, true, false); assert.equal(video.muted, true); assert.equal(video.paused, true);
  assert.equal(clip.sync(-1, true, true), 'before'); assert.equal(video.muted, true);
  assert.equal(clip.sync(31, true, true), 'after'); assert.equal(video.paused, true);
  video.readyState = 0;
  assert.equal(clip.sync(0.2, true, true, true), 'loading');
  video.readyState = 1; video.currentTime = 0;
  clip.sync(0.2, true, true); near(video.currentTime, 0.2);
  clip.error = 'Missing clip';
  assert.equal(clip.sync(1, true, true), 'error'); assert.equal(video.muted, true);
});

import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('merge CLI preserves cameras on missing assets or weak matches and never rewrites diagnostics', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'concert-merge-'));
  try {
    const camPath = join(dir, 'cameras.json'), offPath = join(dir, 'offsets.json');
    const cameraText = JSON.stringify(production());
    fs.writeFileSync(camPath, cameraText);
    const offsets = syncResult();
    fs.writeFileSync(offPath, JSON.stringify(offsets));
    const run = () => spawnSync(process.execPath, ['scripts/merge-offsets.mjs', offPath, camPath], { encoding: 'utf8' });
    let result = run();
    assert.equal(result.status, 1); assert.match(result.stderr, /Missing production asset/);
    assert.equal(fs.readFileSync(camPath, 'utf8'), cameraText);
    // Placeholder files exercise the merger's file-presence check, not media decoding.
    for (const name of ['venue.spz', 'stage.glb', 'seatA.mp4', 'seatB.mp4', 'seatC.mp4']) fs.writeFileSync(join(dir, name), '');
    offsets.clips.seatB.segments[0].confidence = 'low';
    fs.writeFileSync(offPath, JSON.stringify(offsets));
    result = run();
    assert.equal(result.status, 1); assert.match(result.stderr, /needs review/);
    assert.equal(fs.readFileSync(camPath, 'utf8'), cameraText);
    const diagnostics = JSON.stringify(syncResult());
    fs.writeFileSync(offPath, diagnostics);
    result = run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(camPath)).seats[1].offsetSeconds, 0.347);
    assert.equal(fs.readFileSync(offPath, 'utf8'), diagnostics);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
