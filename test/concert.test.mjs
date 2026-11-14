// Run: node --test test/
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
