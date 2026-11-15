#!/usr/bin/env python3
"""Warp each frame back into frame 0's view using rotation.json, so the room holds still.
    .venv/bin/python scripts/stabilize.py public/world [--end 25] [--ref 4]
Reads <dir>/source.mp4 + <dir>/rotation.json, writes <dir>/source-stab.mp4 (sound copied from source.mp4).
--ref N holds the view the camera had at N seconds instead of frame 0's (pick a wide, typical moment).
Where the camera had turned away from that view there is nothing to show, so those areas are black."""
import argparse, json, math, subprocess, sys
from pathlib import Path
import cv2, numpy as np

C = np.diag([1.0, -1.0, -1.0])

def quat_to_mat(x, y, z, w):
    return np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                     [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                     [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])

def K(w, h, vfov):
    f = (h/2)/math.tan(math.radians(vfov)/2)
    return np.array([[f, 0, w/2], [0, f, h/2], [0, 0, 1.0]])

ap = argparse.ArgumentParser(); ap.add_argument("dir"); ap.add_argument("--end", type=float, default=None); ap.add_argument("--ref", type=float, default=0.0)
a = ap.parse_args()
d = Path(a.dir); frames = json.load(open(d/"rotation.json"))["frames"]
cap = cv2.VideoCapture(str(d/"source.mp4"))
w, h = int(cap.get(3)), int(cap.get(4)); fps = cap.get(5)
tmp = d/"_stab_silent.mp4"
out = cv2.VideoWriter(str(tmp), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
ref = min(frames, key=lambda f: abs(f["t"] - a.ref))
Rref = C @ quat_to_mat(*ref["quat"]) @ C
K0i = np.linalg.inv(K(w, h, ref["vfov"]))
for i, f in enumerate(frames):
    if a.end and f["t"] > a.end: break
    ok, img = cap.read()
    if not ok: break
    R = C @ quat_to_mat(*f["quat"]) @ C
    H = K(w, h, f["vfov"]) @ R.T @ Rref @ K0i
    out.write(cv2.warpPerspective(img, H, (w, h), flags=cv2.WARP_INVERSE_MAP | cv2.INTER_LINEAR))
out.release()
dst = d/"source-stab.mp4"
subprocess.run(["ffmpeg","-y","-v","error","-i",str(tmp),"-i",str(d/"source.mp4"),"-map","0:v","-map","1:a?","-shortest",
                "-c:v","libx264","-pix_fmt","yuv420p","-crf","20","-c:a","copy",str(dst)],check=True)
tmp.unlink(); print("wrote", dst)
