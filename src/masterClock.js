// One shared clock for every concert clip (KAN-14). All clips play from this clock, so when the
// viewer jumps to another seat the music keeps going instead of restarting.
//
//   clipTime = masterTime - offsetSeconds
//
// offsetSeconds comes from the audio sync (KAN-12): how many seconds into the master timeline this
// clip's own time zero falls. A positive offset means the clip started later than the master.

export class MasterClock {
  // `now` returns milliseconds. It is a parameter so tests can fake time.
  constructor(now = () => performance.now()) {
    this._now = now;
    this._base = 0;          // master seconds at the last play/pause/seek
    this._startedAt = null;  // now() when it last started running, or null while paused
  }

  get playing() { return this._startedAt !== null; }

  time() {
    return this._base + (this._startedAt === null ? 0 : (this._now() - this._startedAt) / 1000);
  }

  play() { if (!this.playing) this._startedAt = this._now(); }

  pause() {
    if (!this.playing) return;
    this._base = this.time();
    this._startedAt = null;
  }

  seek(seconds) {
    this._base = seconds;
    if (this.playing) this._startedAt = this._now();
  }
}

export const clipTime = (masterTime, offsetSeconds) => masterTime - offsetSeconds;

// What should a clip's video do right now? Pure, so it can be tested without a browser.
//   before:  the clip has not started yet at this master time (clipTime < 0)
//   after:   the clip has ended
//   playing: show it; seekTo is the time to jump to if the video drifted more than `tolerance`
export function planClip({ clipTime: t, duration, videoTime, tolerance = 0.25 }) {
  if (t < 0) return { state: "before", seekTo: null };
  if (Number.isFinite(duration) && t >= duration) return { state: "after", seekTo: null };
  return { state: "playing", seekTo: Math.abs(videoTime - t) > tolerance ? t : null };
}
