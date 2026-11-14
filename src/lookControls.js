import * as THREE from "three";

// Head rotation for the non-WebXR path:
//  - phone: device orientation (gyro). three.js removed DeviceOrientationControls, so this is a
//    small re-implementation of the same math.
//  - desktop: click and drag to look around.
// Rotation only. Position never changes, so the viewer stays at the original camera spot.

const zee = new THREE.Vector3(0, 0, 1);
const euler = new THREE.Euler();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -90 deg around X
const forward = new THREE.Vector3();

export class LookControls {
  constructor(camera, rig, domElement) {
    this.camera = camera;
    this.rig = rig;
    this.baseYaw = rig.rotation.y;
    this.headingOffset = 0;
    this.orientation = null;
    this.gyro = false;
    this.needsRecenter = false;

    // drag-to-look state
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this._onOrient = (e) => { if (e.alpha != null) this.orientation = e; };

    let dragging = false, lastX = 0, lastY = 0;
    domElement.addEventListener("pointerdown", (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
    window.addEventListener("pointerup", () => (dragging = false));
    window.addEventListener("pointermove", (e) => {
      if (!dragging || this.gyro) return;
      this.yaw -= (e.clientX - lastX) * 0.004;
      this.pitch -= (e.clientY - lastY) * 0.004;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch));
      lastX = e.clientX; lastY = e.clientY;
    });
  }

  // Must be called from a tap/click handler: iOS only grants motion access on a user gesture.
  async enableGyro() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) throw new Error("This browser has no device orientation support.");
    if (typeof DOE.requestPermission === "function") {
      const res = await DOE.requestPermission();
      if (res !== "granted") throw new Error("Motion access was denied. On iPhone, reload and tap Allow.");
    }
    window.addEventListener("deviceorientation", this._onOrient);
    this.gyro = true;
    this.needsRecenter = true;
  }

  // Make "where the phone points now" equal to the configured start direction.
  recenter() { this.needsRecenter = true; }

  update() {
    if (this.gyro && this.orientation) {
      const { alpha, beta, gamma } = this.orientation;
      const orient = THREE.MathUtils.degToRad(screen.orientation?.angle ?? window.orientation ?? 0);
      euler.set(THREE.MathUtils.degToRad(beta), THREE.MathUtils.degToRad(alpha), -THREE.MathUtils.degToRad(gamma), "YXZ");
      const q = this.camera.quaternion;
      q.setFromEuler(euler);
      q.multiply(q1);
      q.multiply(q0.setFromAxisAngle(zee, -orient));

      if (this.needsRecenter) {
        forward.set(0, 0, -1).applyQuaternion(q);
        this.headingOffset = -Math.atan2(-forward.x, -forward.z);
        this.needsRecenter = false;
      }
      this.rig.rotation.y = this.baseYaw + this.headingOffset;
    } else if (!this.gyro) {
      this.camera.rotation.set(this.pitch, this.yaw, this.roll, "YXZ");
      this.rig.rotation.y = this.baseYaw;
    }
  }
}
