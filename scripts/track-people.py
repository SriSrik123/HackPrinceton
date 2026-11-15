#!/usr/bin/env python3
"""Track people (or any object) through the video with VitTrack, and measure how far away each one is.

    .venv/bin/python scripts/track-people.py public/world/source.mp4 --box 85,90,160,215 --box 475,0,165,190
    .venv/bin/python scripts/track-people.py public/world/source.mp4 --boxes-from-world      (boxes saved in world.json)

Model: VitTrack from OpenCV Zoo (huggingface.co/opencv/object_tracking_vittrack, Apache-2.0), run through
cv2.TrackerVit (OpenCV 4.9+). Downloaded once into .models/.

--box is x,y,w,h in source pixels on the FIRST frame (--start-frame to start later). One per person.

Writes next to the video:
  tracks.json   { fps, frames, width, height, tracks: [ { name, frames: [[x, y, w, h, score, z], ...] } ] }
                x, y, w, h are 0..1 of the frame (y down). score is VitTrack's confidence (0 = lost).
                z is the distance in metres from depth-metric.mp4 (median over the box's middle), or null
                when there is no depth video. src/trackedPeople.js reads this.
  tracks-preview.mp4   the video with the boxes drawn, to check the tracking by eye.
"""
import argparse
import json
import subprocess
import urllib.request
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MODEL = ROOT / ".models" / "object_tracking_vittrack_2023sep.onnx"
MODEL_URL = "https://huggingface.co/opencv/object_tracking_vittrack/resolve/main/object_tracking_vittrack_2023sep.onnx"
LOST_SCORE = 0.3        # below this VitTrack has probably lost the person; the viewer fades them out
Z_SMOOTH = 0.15         # exponential smoothing of the per-frame distance (1 = none)
COLORS = [(0, 220, 255), (255, 120, 0), (80, 255, 80), (255, 60, 200), (255, 255, 0), (0, 120, 255)]


def ensure_model():
    if MODEL.exists():
        return
    MODEL.parent.mkdir(exist_ok=True)
    print("downloading VitTrack model ->", MODEL)
    urllib.request.urlretrieve(MODEL_URL, MODEL)


def make_tracker():
    p = cv2.TrackerVit_Params()
    p.net = str(MODEL)
    return cv2.TrackerVit_create(p)


def parse_box(s):
    v = [int(round(float(x))) for x in s.split(",")]
    if len(v) != 4 or v[2] <= 0 or v[3] <= 0:
        raise argparse.ArgumentTypeError(f"--box wants x,y,w,h, got {s!r}")
    return v


def box_depth(depth_gray, box, near, far):
    """Median distance (metres) over the middle of the box: the person, not the wall behind the edges."""
    x, y, w, h = box
    H, W = depth_gray.shape
    x0, x1 = int(max(0, x + w * 0.3)), int(min(W, x + w * 0.7))
    y0, y1 = int(max(0, y + h * 0.2)), int(min(H, y + h * 0.7))
    if x1 <= x0 or y1 <= y0:
        return None
    g = depth_gray[y0:y1, x0:x1].astype(np.float32) / 255.0
    # depth-video.py --metric: white = near. Take the nearer half (the person is in front of whatever is behind).
    g = np.sort(g.ravel())[len(g.ravel()) // 2:]
    return float(near + (1.0 - np.median(g)) * (far - near))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video")
    ap.add_argument("--box", type=parse_box, action="append", default=[], help="x,y,w,h in pixels, repeat per person")
    ap.add_argument("--name", action="append", default=[], help="a name per --box, in order (optional)")
    ap.add_argument("--boxes-from-world", action="store_true", help='use "people" boxes from world.json next to the video')
    ap.add_argument("--start-frame", type=int, default=0)
    ap.add_argument("--depth", default=None, help="depth video (default depth-metric.mp4 next to the video)")
    ap.add_argument("--no-preview", action="store_true")
    a = ap.parse_args()

    src = Path(a.video)
    out_dir = src.parent
    boxes, names = list(a.box), list(a.name)
    if a.boxes_from_world:
        world = json.loads((out_dir / "world.json").read_text())
        for p in world.get("people", []):
            boxes.append(parse_box(",".join(map(str, p["box"]))))
            names.append(p.get("name", ""))
    if not boxes:
        ap.error("give at least one --box x,y,w,h (or --boxes-from-world)")
    names = [names[i] if i < len(names) and names[i] else f"person{i + 1}" for i in range(len(boxes))]

    ensure_model()
    cap = cv2.VideoCapture(str(src))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    depth_path = Path(a.depth) if a.depth else out_dir / "depth-metric.mp4"
    depth_cap, near, far = None, None, None
    if depth_path.exists():
        info = json.loads(depth_path.with_suffix(".json").read_text())
        near, far = info["near"], info["far"]
        depth_cap = cv2.VideoCapture(str(depth_path))
        print(f"depth from {depth_path.name} ({near:.2f} to {far:.2f} m)")
    else:
        print("no depth video, z will be null (the viewer then uses a fixed distance)")

    trackers = [None] * len(boxes)
    results = [[] for _ in boxes]
    last_z = [None] * len(boxes)
    preview_frames = []
    i = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        depth_gray = None
        if depth_cap is not None:
            dok, d = depth_cap.read()
            if dok:
                depth_gray = cv2.cvtColor(d, cv2.COLOR_BGR2GRAY)

        for k, box0 in enumerate(boxes):
            if i < a.start_frame:
                results[k].append([0, 0, 0, 0, 0.0, None])
                continue
            if trackers[k] is None:
                trackers[k] = make_tracker()
                trackers[k].init(frame, tuple(box0))
                box, score = list(box0), 1.0
            else:
                located, box = trackers[k].update(frame)
                score = float(trackers[k].getTrackingScore()) if located else 0.0
                box = list(box)
            z = None
            if depth_gray is not None and score >= LOST_SCORE:
                z = box_depth(depth_gray, box, near, far)
                if z is not None and last_z[k] is not None:
                    z = last_z[k] + Z_SMOOTH * (z - last_z[k])
                last_z[k] = z if z is not None else last_z[k]
            elif last_z[k] is not None:
                z = last_z[k]
            x, y, w, h = box
            results[k].append([round(x / W, 4), round(y / H, 4), round(w / W, 4), round(h / H, 4), round(score, 3),
                               None if z is None else round(z, 3)])

        if not a.no_preview:
            view = frame.copy()
            for k, r in enumerate(results):
                x, y, w, h, s, z = r[-1]
                if w <= 0:
                    continue
                c = COLORS[k % len(COLORS)] if s >= LOST_SCORE else (90, 90, 90)
                p0 = (int(x * W), int(y * H))
                p1 = (int((x + w) * W), int((y + h) * H))
                cv2.rectangle(view, p0, p1, c, 2)
                label = f"{names[k]} {s:.2f}" + ("" if z is None else f" {z:.1f}m")
                cv2.putText(view, label, (p0[0] + 3, max(12, p0[1] + 14)), cv2.FONT_HERSHEY_SIMPLEX, 0.45, c, 1, cv2.LINE_AA)
            preview_frames.append(view)
        i += 1
        if i % 100 == 0:
            print(f"  frame {i}", "  ".join(f"{names[k]} {results[k][-1][4]:.2f}" for k in range(len(boxes))))
    cap.release()

    for k in range(len(boxes)):
        lost = sum(1 for r in results[k] if r[4] < LOST_SCORE)
        print(f"{names[k]}: lost in {lost} of {i} frames")

    out = {
        "model": MODEL.name, "fps": fps, "frames": i, "width": W, "height": H, "lostScore": LOST_SCORE,
        "tracks": [{"name": names[k], "frames": results[k]} for k in range(len(boxes))],
    }
    (out_dir / "tracks.json").write_text(json.dumps(out, separators=(",", ":")))
    print("wrote", out_dir / "tracks.json")

    if preview_frames:
        raw = out_dir / "_tracks.avi"
        wr = cv2.VideoWriter(str(raw), cv2.VideoWriter_fourcc(*"MJPG"), fps, (W, H))
        for f in preview_frames:
            wr.write(f)
        wr.release()
        dst = out_dir / "tracks-preview.mp4"
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(raw), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-an", str(dst)], check=True)
        raw.unlink()
        print("wrote", dst)


if __name__ == "__main__":
    main()
