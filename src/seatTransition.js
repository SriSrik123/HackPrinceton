// Zoom in place, teleport once at the midpoint, then restore the view. Never owns a clock.
export class SeatTransition {
  constructor({ time, teleport, setFov, hide, duration = 0.3 }) {
    Object.assign(this, { time, teleport, setFov, hide, duration });
    this.state = null;
  }
  get active() { return this.state !== null; }
  start(target, fov) {
    if (this.active) return false;
    this.state = { target, fov, wide: Math.min(120, fov + 25), elapsed: 0, moved: false, masterTime: this.time() };
    return true;
  }
  update(dt) {
    const s = this.state;
    if (!s) return;
    s.elapsed += dt;
    if (!s.moved && s.elapsed >= this.duration) {
      this.hide();
      // Read the running clock again: animation time must not become playback lag.
      this.teleport(s.target, this.time());
      s.moved = true;
    }
    const t = Math.min(1, (s.moved ? s.elapsed - this.duration : s.elapsed) / this.duration);
    const eased = t * t * (3 - 2 * t);
    this.setFov(s.moved ? s.wide + (s.fov - s.wide) * eased : s.fov + (s.wide - s.fov) * eased);
    if (s.elapsed >= 2 * this.duration) { this.setFov(s.fov); this.state = null; }
  }
}
