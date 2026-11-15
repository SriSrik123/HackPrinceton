import { planClip } from "./masterClock.js";

export class VideoClip {
  constructor(url, createVideo = () => document.createElement("video"), { loop = false } = {}) {
    const v = createVideo();
    v.src = url;
    v.crossOrigin = "anonymous";
    v.playsInline = true;
    v.preload = "auto";
    v.muted = true;
    v.loop = loop;
    this.error = null;
    this.needsSeek = false;
    v.addEventListener("error", () => { this.error = `Unable to load clip: ${url}`; });
    this.video = v;
    this.source = v;
  }
  get duration() { return this.video.duration; }
  // Returns "before" | "playing" | "after". Only the active seat's clip ever plays (and has sound).
  sync(t, playing, active, forceSeek = false) {
    const v = this.video;
    if (v.loop && t >= 0 && Number.isFinite(v.duration) && v.duration > 0) t %= v.duration;
    this.needsSeek ||= forceSeek;
    v.muted = !active || !playing;
    const plan = planClip({ clipTime: t, duration: v.duration, videoTime: v.currentTime,
      tolerance: playing ? 1 : 0.25 });
    if (!active || plan.state !== "playing" || v.readyState === 0 || this.error) {
      v.muted = true;
      if (!v.paused) v.pause();
      return this.error ? "error" : v.readyState === 0 ? "loading" : plan.state;
    }
    // Let the decoder finish a seek instead of restarting it every frame.
    if (!v.seeking && (this.needsSeek || plan.seekTo !== null)) {
      v.currentTime = t; this.needsSeek = false;
    }
    const drift = t - v.currentTime;
    v.playbackRate = playing && !v.seeking && Math.abs(drift) > 0.08
      ? Math.max(0.95, Math.min(1.05, 1 + drift * 0.1)) : 1;
    if (playing && v.paused) v.play().catch(() => {});
    else if (!playing && !v.paused) v.pause();
    return "playing";
  }
}

