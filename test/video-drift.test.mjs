import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoClip } from '../src/videoClip.js';

test('looping clips wrap clock time and keep negative offsets before the clip', () => {
  const video = { currentTime: 0, duration: 20, readyState: 4, seeking: false, paused: true,
    addEventListener() {}, pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); } };
  const clip = new VideoClip('clip.mp4', () => video, { loop: true });
  assert.equal(video.loop, true);
  assert.equal(clip.sync(42.5, true, true, true), 'playing');
  assert.equal(video.currentTime, 2.5);
  assert.equal(clip.sync(-1, true, true), 'before');
  assert.equal(video.paused, true);
  video.duration = NaN;
  assert.equal(clip.sync(50, false, true), 'playing');
  assert.ok(Number.isFinite(video.currentTime));
});

test('clock correction lets decoding finish and handles small drift without another seek', () => {
  let time = 0, seeks = 0;
  const video = {
    duration: 30, readyState: 4, seeking: false, paused: false,
    addEventListener() {}, pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
    get currentTime() { return time; },
    set currentTime(value) { time = value; seeks++; this.seeking = true; },
  };
  const clip = new VideoClip('clip.mp4', () => video);
  clip.sync(5, true, true, true);
  for (let i = 0; i < 60; i++) clip.sync(5 + i / 60, true, true);
  assert.equal(seeks, 1, 'unfinished seek must not be restarted');
  video.seeking = false;
  time = 6;
  clip.sync(6.3, true, true);
  assert.equal(seeks, 1, 'small drift should adjust playback speed');
  assert.ok(video.playbackRate > 1 && video.playbackRate <= 1.05);
  clip.sync(6.3, false, true);
  assert.equal(video.playbackRate, 1);
  assert.equal(video.paused, true);
});
