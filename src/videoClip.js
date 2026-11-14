import { planClip } from "./masterClock.js";

export class VideoClip {
  constructor(url, createVideo = () => document.createElement("video")) {
    const v = createVideo();
    v.src = url;
    v.crossOrigin = "anonymous";
    v.playsInline = true;
    v.preload = "auto";
    v.muted = true;
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
    this.needsSeek ||= forceSeek;
    v.muted = !active || !playing;
    const plan = planClip({ clipTime: t, duration: v.duration, videoTime: v.currentTime });
    if (!active || plan.state !== "playing" || v.readyState === 0 || this.error) {
      v.muted = true;
      if (!v.paused) v.pause();
      return this.error ? "error" : v.readyState === 0 ? "loading" : plan.state;
    }
    if (this.needsSeek || plan.seekTo !== null) { v.currentTime = t; this.needsSeek = false; }
    if (playing && v.paused) v.play().catch(() => {});
    else if (!playing && !v.paused) v.pause();
    return "playing";
  }
}

