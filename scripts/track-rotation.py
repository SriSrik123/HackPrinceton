#!/usr/bin/env python3
"""Estimate how the camera ROTATED in a video, frame by frame (rotation only, no COLMAP).

Use for a party video where the camera stays in one spot and pans or tilts.

    .venv/bin/python scripts/track-rotation.py public/world/source.mp4          (add --fov 45 to force a FOV)
    .venv/bin/python scripts/track-rotation.py --selftest

Method: track corners between neighbouring frames (Lucas-Kanade), fit a homography with RANSAC
(moving people are outliers), turn it into a rotation with H = K R^T K^-1, and chain the
rotations so frame 0 is the identity. Writes public/world/rotation.json by default.

Output convention matches src/projection.js (three.js camera: looks down -Z, +Y up):
  base   frame 0's yaw / pitch / roll in the room, fitted to Marble's panorama (pano.png) when
         it is there. The viewer uses it to aim the projector for the first frame.
  g      3x3, row-major: room direction (from the camera spot) -> this frame's picture, x and y
         in -1..1. The "anchored" mapping: the full homography back to frame 0, so people who
         stay put stay glued to one spot in the room even if that stretches the frame. The
         viewer uses this by default (?anchor=0 uses the clean rotation below instead).
  quat   [x, y, z, w]  rotation of frame i relative to frame 0, in frame 0's camera axes
  yaw / pitch / roll   the camera in the room's axes, degrees, "YXZ". yaw + left, pitch + up.
Final projector rotation = (frame 0's rotation in the room) * quat.

The field of view is self-calibrated from the pan unless --fov is given.
NOT verified: drift over a long pan, a real phone run.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np

C = np.diag([1.0, -1.0, -1.0])  # OpenCV camera axes (x right, y down, z fwd) <-> three.js (x right, y up, -z fwd)
MIN_INLIERS = 15


def intrinsics(w, h, vfov_deg):
    f = (h / 2) / math.tan(math.radians(vfov_deg) / 2)
    return np.array([[f, 0, w / 2], [0, f, h / 2], [0, 0, 1.0]])


def nearest_rotation(m):
    u, _, vt = np.linalg.svd(m)
    r = u @ vt
    if np.linalg.det(r) < 0:
        u[:, -1] *= -1
        r = u @ vt
    return r


def step_homography(prev, cur):
    """Pixel homography taking frame prev to frame cur (det 1). None if tracking is poor."""
    p0 = cv2.goodFeaturesToTrack(prev, maxCorners=500, qualityLevel=0.01, minDistance=8)
    if p0 is None or len(p0) < MIN_INLIERS:
        return None, 0
    p1, st, _ = cv2.calcOpticalFlowPyrLK(prev, cur, p0, None, winSize=(21, 21), maxLevel=3)
    ok = st.ravel() == 1
    a, b = p0[ok].reshape(-1, 2), p1[ok].reshape(-1, 2)
    if len(a) < MIN_INLIERS:
        return None, 0
    H, mask = cv2.findHomography(a, b, cv2.RANSAC, 3.0)
    if H is None:
        return None, 0
    inliers = int(mask.sum())
    det = np.linalg.det(H)
    if inliers < MIN_INLIERS or det <= 0:
        return None, inliers
    return H / np.cbrt(det), inliers


SIFT = cv2.SIFT_create(3000)
ANCHOR_MIN_INLIERS = 25


def anchor_homography(first_kp, gray):
    """Homography from frame 0 straight to this frame by feature matching, or None if it is not the same view."""
    k0, d0 = first_kp
    k, d = SIFT.detectAndCompute(gray, None)
    if d0 is None or d is None or len(k) < 2:
        return None
    good = [a for a, b in cv2.BFMatcher().knnMatch(d0, d, k=2) if a.distance < 0.75 * b.distance]
    if len(good) < ANCHOR_MIN_INLIERS:
        return None
    H, mask = cv2.findHomography(np.float32([k0[m.queryIdx].pt for m in good]),
                                 np.float32([k[m.trainIdx].pt for m in good]), cv2.RANSAC, 3.0)
    if H is None or int(mask.sum()) < ANCHOR_MIN_INLIERS or np.linalg.det(H) <= 0:
        return None
    return H / np.cbrt(np.linalg.det(H))


def rotation_from_h(H, K, Kinv):
    # p_cur ~ K R_rel^T K^-1 p_prev  =>  R_rel^T = K^-1 H K
    return nearest_rotation(Kinv @ H @ K).T


def step_rotation_zoom(H, w, h, f1, zoom=True, clamp=True):
    """Split a step homography into a rotation and a new focal length: H = K(f2) R^T K(f1)^-1."""
    T = np.array([[1, 0, w / 2], [0, 1, h / 2], [0, 0, 1.0]])
    A = np.linalg.inv(T) @ H @ T @ np.diag([f1, f1, 1.0])
    n3 = np.linalg.norm(A[2])
    f2 = math.sqrt((A[0] @ A[0] + A[1] @ A[1]) / 2) / n3 if zoom else f1
    if clamp:
        f2 = min(max(f2, f1 * 0.97), f1 * 1.03)  # a single step never zooms more than a few percent
    return nearest_rotation(np.diag([1 / f2, 1 / f2, 1.0]) @ A / n3).T, f2


def from_euler_yxz(yaw, pitch, roll):
    y, x, z = (math.radians(v) for v in (yaw, pitch, roll))
    ry = np.array([[math.cos(y), 0, math.sin(y)], [0, 1, 0], [-math.sin(y), 0, math.cos(y)]])
    rx = np.array([[1, 0, 0], [0, math.cos(x), -math.sin(x)], [0, math.sin(x), math.cos(x)]])
    rz = np.array([[math.cos(z), -math.sin(z), 0], [math.sin(z), math.cos(z), 0], [0, 0, 1]])
    return ry @ rx @ rz


def relative_rotation(prev, cur, K, Kinv):
    """Camera rotation from frame prev to frame cur, in prev's axes (OpenCV). None if tracking is poor."""
    H, inliers = step_homography(prev, cur)
    return (None if H is None else rotation_from_h(H, K, Kinv)), inliers


def calibrate_fov(steps, w, h, fps_eff):
    """Find the vertical FOV that makes the homographies most rotation-like.

    For a camera that only rotates, K^-1 H K is a rotation matrix, but only with the right focal
    length. Chain the step homographies over about half a second and pick the FOV that leaves the
    least non-rotation residue. Returns (vfov, sharpness, pans used); vfov is None with too little pan.
    """
    win = max(2, int(round(fps_eff * 0.5)))
    centre = np.array([w / 2, h / 2, 1.0])
    chains = []
    for i in range(0, len(steps) - win, max(1, win // 2)):
        H = np.eye(3)
        for s in steps[i:i + win]:
            if s is None:
                H = None
                break
            H = s @ H
        if H is None:
            continue
        p = H @ centre
        shift = np.hypot(p[0] / p[2] - centre[0], p[1] / p[2] - centre[1])
        if 0.06 * w < shift < 0.45 * w:  # enough pan to constrain the focal length, not so much it is unreliable
            chains.append(H / np.cbrt(np.linalg.det(H)))
    if len(chains) < 5:
        return None, 0, 0

    def cost(vfov):
        K = intrinsics(w, h, vfov)
        Kinv = np.linalg.inv(K)
        errs = [np.linalg.norm((m := Kinv @ H @ K) @ m.T - np.eye(3)) for H in chains]
        return float(np.median(errs))

    grid = np.arange(20.0, 100.01, 0.5)
    costs = np.array([cost(v) for v in grid])
    best = int(np.argmin(costs))
    return float(grid[best]), float(np.median(costs) / max(costs[best], 1e-9)), len(chains)


def to_euler_yxz(r):
    """three.js Euler 'YXZ' (yaw about Y, pitch about X, roll about Z) from a 3x3 rotation matrix."""
    pitch = math.asin(-max(-1.0, min(1.0, r[1, 2])))
    if abs(r[1, 2]) < 0.9999:
        yaw = math.atan2(r[0, 2], r[2, 2])
        roll = math.atan2(r[1, 0], r[1, 1])
    else:
        yaw = math.atan2(-r[2, 0], r[0, 0])
        roll = 0.0
    return [math.degrees(v) for v in (yaw, pitch, roll)]


def to_quat(r):
    w = math.sqrt(max(0.0, 1 + r[0, 0] + r[1, 1] + r[2, 2])) / 2
    if w > 1e-6:
        return [(r[2, 1] - r[1, 2]) / (4 * w), (r[0, 2] - r[2, 0]) / (4 * w), (r[1, 0] - r[0, 1]) / (4 * w), w]
    i = int(np.argmax(np.diag(r)))
    j, k = (i + 1) % 3, (i + 2) % 3
    s = math.sqrt(max(1e-12, r[i, i] - r[j, j] - r[k, k] + 1)) * 2
    q = [0.0] * 4
    q[i], q[3] = s / 4, (r[k, j] - r[j, k]) / s
    q[j], q[k] = (r[j, i] + r[i, j]) / s, (r[k, i] + r[i, k]) / s
    return q


def pano_view(pano, yaw, pitch, vfov, w, h):
    """A normal (pinhole) picture cut out of an equirectangular panorama. Returns (image, focal px, rotation)."""
    ph, pw = pano.shape[:2]
    f = (h / 2) / math.tan(math.radians(vfov) / 2)
    xs, ys = np.meshgrid(np.arange(w) + 0.5 - w / 2, np.arange(h) + 0.5 - h / 2)
    d = np.stack([xs, -ys, -np.full_like(xs, f)], -1)
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    r = from_euler_yxz(yaw, pitch, 0)
    d = d @ r.T
    lon, lat = np.arctan2(d[..., 0], -d[..., 2]), np.arcsin(np.clip(d[..., 1], -1, 1))
    u = ((lon / (2 * math.pi) + 0.5) * pw).astype(np.float32)
    v = ((0.5 - lat / math.pi) * ph).astype(np.float32)
    return cv2.remap(pano, u, v, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP), f, r


def register_to_pano(frames_bgr, pano):
    """Where the video's first frames sit in Marble's panorama (its origin view, centre = yaw 0).

    Marble redraws the room, so only some features match; try a few cut-outs and take the median.
    Returns {"yaw", "pitch", "roll", "vfov", "fits"} in degrees, or None when nothing matches.
    """
    W, H = 1280, 960
    sift, found = cv2.SIFT_create(6000), []
    views = [(vy, vp, vf) for vf in (60, 50) for vp in (0, -10, -20) for vy in (0,)] + [(-5, -5, 45), (5, -15, 45)]
    cut = [(pano_view(pano, *v, W, H), None) for v in views]
    cut = [(c[0], sift.detectAndCompute(cv2.cvtColor(c[0][0], cv2.COLOR_BGR2GRAY), None)) for c in cut]
    for bgr in frames_bgr:
        fh, fw = bgr.shape[:2]
        k1, d1 = sift.detectAndCompute(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY), None)
        if d1 is None:
            continue
        for (_, fv, rv), (k2, d2) in cut:
            good = [a for a, b in cv2.BFMatcher().knnMatch(d1, d2, k=2) if a.distance < 0.75 * b.distance]
            if len(good) < 12:
                continue
            Hm, mask = cv2.findHomography(np.float32([k1[m.queryIdx].pt for m in good]),
                                          np.float32([k2[m.trainIdx].pt for m in good]), cv2.RANSAC, 4.0)
            if Hm is None or int(mask.sum()) < 12:
                continue
            tf = np.array([[1, 0, fw / 2], [0, 1, fh / 2], [0, 0, 1.0]])
            tv = np.array([[1, 0, W / 2], [0, 1, H / 2], [0, 0, 1.0]])
            # view px ~ K_v R_v^T R_f K_f^-1 frame px, so with A = K_v^-1 Hc: A = s R diag(1/f, 1/f, 1)
            A = np.diag([1 / fv, 1 / fv, 1.0]) @ np.linalg.inv(tv) @ Hm @ tf
            n2 = np.linalg.norm(A[:, 2])
            ff = n2 / math.sqrt((A[:, 0] @ A[:, 0] + A[:, 1] @ A[:, 1]) / 2)
            r = nearest_rotation(A @ np.diag([ff, ff, 1.0]) / n2)
            yaw, pitch, roll = to_euler_yxz(rv @ (C @ r @ C))
            found.append((yaw, pitch, roll, math.degrees(2 * math.atan((fh / 2) / ff))))
    if len(found) < 3:
        return None
    yaw, pitch, roll, vfov = (float(v) for v in np.median(np.array(found), axis=0))
    return {"yaw": round(yaw, 2), "pitch": round(pitch, 2), "roll": round(roll, 2), "vfov": round(vfov, 2), "fits": len(found)}


def track(path, vfov, width, step, zoom=True, level=True, pano=None, base=None):
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        sys.exit(f"Cannot open {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    # Pass 1: pixel homographies between neighbouring frames (no focal length needed yet).
    times, steps, inliers, prev, idx = [], [], [], None, 0
    head = []  # a few opening frames at full size, for the panorama fit
    anchors, first_kp, anchor_every = [], None, max(1, int(round(fps / step * 0.25)))
    while True:
        ok, bgr = cap.read()
        if not ok:
            break
        idx += 1
        if (idx - 1) % step:
            continue
        # POS_MSEC after read() is the NEXT frame's time on some backends; frame index / fps is this frame's.
        times.append((idx - 1) / fps)
        if len(times) in (1, 4, 8):
            head.append(bgr)
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        if gray.shape[1] > width:
            s = width / gray.shape[1]
            gray = cv2.resize(gray, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        if prev is None:
            first_kp = SIFT.detectAndCompute(gray, None)
        else:
            H, inl = step_homography(prev, gray)
            steps.append(H)
            inliers.append(inl)
            if len(times) % anchor_every == 0:
                Ha = anchor_homography(first_kp, gray)
                if Ha is not None:
                    anchors.append((len(times) - 1, Ha))
        prev = gray
    cap.release()
    if prev is None:
        sys.exit(f"No frames in {path}")
    h, w = prev.shape

    # Frame 0's pose in the room: from Marble's panorama when there is one, else as given, else level.
    base = dict(base or {"yaw": 0.0, "pitch": 0.0, "roll": 0.0})
    base_source = "given" if base.get("pitch") or base.get("yaw") or base.get("roll") else "assumed level"
    fit = register_to_pano(head, pano) if pano is not None else None
    if fit:
        base = {k: fit[k] for k in ("yaw", "pitch", "roll")}
        base_source = f"fitted to the Marble panorama ({fit['fits']} fits)"
    elif pano is not None:
        print("Warning: could not fit the first frame to the panorama. Frame 0 is assumed level; tune ?projPitch by eye.")
    if level:
        base["roll"] = 0.0
    B = from_euler_yxz(base["yaw"], base["pitch"], base["roll"])

    fov_source = "given"
    if vfov is None and fit:
        vfov, fov_source = fit["vfov"], "fitted to the Marble panorama"
    if vfov is None:
        got = calibrate_fov(steps, w, h, fps / step)
        if got[0] is None:
            vfov, fov_source = 50.0, "guess (too little pan to calibrate)"
        else:
            vfov, fov_source = got[0], f"self-calibrated from {got[2]} pans, sharpness {got[1]:.1f}x"

    # Pass 2: chain the rotations. Frame 0 is the identity. The focal length may change per step
    # (zoom, or stepping toward the scene, which looks the same to a homography).
    f = intrinsics(w, h, vfov)[0, 0]
    r_cv, lost, frames = np.eye(3), 0, []
    for i, t in enumerate(times):
        inl = None
        if i > 0:
            inl = inliers[i - 1]
            if steps[i - 1] is None:
                lost += 1  # hold the last rotation
            else:
                rel, f = step_rotation_zoom(steps[i - 1], w, h, f, zoom)
                r_cv = nearest_rotation(r_cv @ rel)
        r_three = C @ r_cv @ C          # relative to frame 0, in frame 0's camera axes
        world = B @ r_three             # in the room's axes (Y up)
        yaw, pitch, roll = to_euler_yxz(world)
        if level:
            # A hand-held phone stays close to level; tracked roll is mostly drift. Drop it, in the
            # ROOM's axes: frame 0 usually looks down a bit, so a level pan has roll in frame 0's axes.
            roll = 0.0
            r_three = B.T @ from_euler_yxz(yaw, pitch, 0.0)
            r_cv = C @ r_three @ C
        frames.append({"t": round(t, 4), "quat": [round(v, 6) for v in to_quat(r_three)],
                       "yaw": round(yaw, 3), "pitch": round(pitch, 3), "roll": round(roll, 3),
                       "vfov": round(math.degrees(2 * math.atan((h / 2) / f)), 3), "inliers": inl})
    # Zoom drifts when chained over hundreds of steps. Wherever a frame can be matched straight
    # back to frame 0, trust that zoom instead and spread the correction between those anchors.
    if zoom and anchors:
        f0 = intrinsics(w, h, vfov)[0, 0]
        at, corr = [0.0], [0.0]
        for i, Ha in anchors:
            _, fa = step_rotation_zoom(Ha, w, h, f0, clamp=False)
            tracked = (h / 2) / math.tan(math.radians(frames[i]["vfov"]) / 2)
            at.append(times[i])
            corr.append(math.log(fa / tracked))
        for fr in frames:
            fcur = (h / 2) / math.tan(math.radians(fr["vfov"]) / 2) * math.exp(float(np.interp(fr["t"], at, corr)))
            fr["vfov"] = round(math.degrees(2 * math.atan((h / 2) / fcur)), 3)
        fov_source += f"; zoom anchored to frame 0 at {len(anchors)} frames"
    # "Anchored" mapping: instead of a clean camera rotation, pin every frame to frame 0 with the
    # full homography (it may stretch the picture), so whatever stayed put since frame 0, the people
    # at the table, stays glued to the same spot in the room. Chained steps drift, so wherever a
    # frame matches frame 0 directly, that match wins and the correction is spread in between.
    chain = [np.eye(3)]
    for st in steps:
        chain.append(chain[-1] if st is None else (lambda m: m / m[2, 2])(st @ chain[-1]))
    at, errs = [0.0], [np.eye(3)]
    for i, Ha in anchors:
        e = Ha @ np.linalg.inv(chain[i])
        at.append(times[i])
        errs.append(e / e[2, 2])
    errs = np.array(errs)
    ndc = np.array([[2 / w, 0, -1], [0, -2 / h, 1], [0, 0, 1.0]])  # pixels -> -1..1, y up
    to_frame0 = intrinsics(w, h, vfov) @ C @ B.T                    # room direction -> frame 0 pixel
    prev_g = None
    for i, fr in enumerate(frames):
        e = np.array([[np.interp(times[i], at, errs[:, r, c]) for c in range(3)] for r in range(3)])
        g = ndc @ e @ chain[i] @ to_frame0                          # room direction -> this frame, -1..1
        g /= np.linalg.norm(g)
        if (prev_g is None and (g @ B @ np.array([0, 0, -1.0]))[2] < 0) or (prev_g is not None and np.sum(g * prev_g) < 0):
            g = -g                                                  # keep "in front" positive
        prev_g = g
        fr["g"] = [round(float(v), 7) for v in g.ravel()]
    extra = {"base": base, "base_source": base_source, "anchors": len(anchors)}
    return {**extra, "fps": fps, "vfov": vfov, "fov_source": fov_source, "frames": frames, "lost_frames": lost}


def summarize(out):
    f = out["frames"]
    arr = np.array([[x["yaw"], x["pitch"], x["roll"]] for x in f])
    inl = np.array([x["inliers"] for x in f if x["inliers"] is not None])
    print(f"{len(f)} frames, {out['lost_frames']} lost (held). vfov {out['vfov']} deg ({out['fov_source']})")
    b = out["base"]
    print(f"  frame 0 in the room: yaw {b['yaw']}, pitch {b['pitch']}, roll {b['roll']} deg ({out['base_source']})")
    fov = np.array([x["vfov"] for x in f])
    print(f"  vfov  range {fov.min():7.1f} .. {fov.max():7.1f} deg, end {fov[-1]:7.1f}")
    for name, col in zip(("yaw", "pitch", "roll"), arr.T):
        print(f"  {name:5s} range {col.min():7.1f} .. {col.max():7.1f} deg, end {col[-1]:7.1f}")
    if len(inl):
        print(f"  inliers per step: median {int(np.median(inl))}, min {int(inl.min())}")


def selftest():
    """Warp one real-looking frame with known camera rotations and check we recover them."""
    rng = np.random.default_rng(0)
    base = cv2.GaussianBlur((rng.random((480, 640)) * 255).astype(np.uint8), (0, 0), 2)
    base = cv2.normalize(base, None, 0, 255, cv2.NORM_MINMAX)
    base[:, :] = np.maximum(base, 1)  # no zero pixels, so the warp border below is the only black
    K = intrinsics(640, 480, 50)
    Kinv = np.linalg.inv(K)

    def ry(a): c, s = math.cos(a), math.sin(a); return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    def rx(a): c, s = math.cos(a), math.sin(a); return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])

    ok = True
    for name, yaw, pitch in (("yaw +4 (turn left)", 4, 0), ("yaw -4 (turn right)", -4, 0), ("pitch +3 (look up)", 0, 3), ("pitch -3 (look down)", 0, -3), ("yaw +1.5", 1.5, 0)):
        r_three = ry(math.radians(yaw)) @ rx(math.radians(pitch))
        r_cv = C @ r_three @ C
        H = K @ r_cv.T @ Kinv  # how the true camera rotation moves pixels
        cur = cv2.warpPerspective(base, H, (640, 480), borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        rel, inl = relative_rotation(base, cur, K, Kinv)
        if rel is None:
            print(f"FAIL {name}: tracking lost"); ok = False; continue
        gy, gp, gr = to_euler_yxz(C @ rel @ C)
        good = abs(gy - yaw) < 0.3 and abs(gp - pitch) < 0.3 and abs(gr) < 0.3
        ok &= good
        print(f"{'ok  ' if good else 'FAIL'} {name}: got yaw {gy:.2f} pitch {gp:.2f} roll {gr:.2f} ({inl} inliers)")
    sys.exit(0 if ok else 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video", nargs="?")
    ap.add_argument("--fov", type=float, default=None, help="vertical field of view in degrees (default: self-calibrate from the pan)")
    ap.add_argument("--width", type=int, default=640, help="analysis width in px (default 640)")
    ap.add_argument("--step", type=int, default=1, help="use every Nth frame (default 1)")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "public/world/rotation.json"))
    ap.add_argument("--pano", default="auto", help="Marble panorama to fit frame 0 to (default: pano.png next to --out; 'none' to skip)")
    ap.add_argument("--base", default=None, help="frame 0's yaw,pitch,roll in the room, degrees, when there is no panorama")
    ap.add_argument("--no-zoom", action="store_true", help="assume a fixed focal length")
    ap.add_argument("--keep-roll", action="store_true", help="keep tracked roll (default: assume the phone stays level)")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        selftest()
    if not a.video:
        ap.error("give a video path or --selftest")
    pano_path = Path(a.out).parent / "pano.png" if a.pano == "auto" else (None if a.pano == "none" else Path(a.pano))
    pano = cv2.imread(str(pano_path)) if pano_path and pano_path.exists() else None
    if pano is None and a.pano != "none":
        print(f"No panorama at {pano_path}; frame 0 is assumed level unless --base is given.")
    base = dict(zip(("yaw", "pitch", "roll"), map(float, a.base.split(",")))) if a.base else None
    out = track(a.video, a.fov, a.width, a.step, zoom=not a.no_zoom, level=not a.keep_roll, pano=pano, base=base)
    summarize(out)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(out))
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
