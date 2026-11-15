#!/usr/bin/env python3
"""Depth for every frame of a video with Video Depth Anything, on Apple silicon (Metal) or CPU.

    .depth/venv/bin/python scripts/depth-video.py public/world/source.mp4 [--metric] [--frames 90]

Writes next to the video:
  depth.mp4    grayscale, same size and frame count as the source. White = near, black = far.
               Relative model: scaled per clip (0 to 255 over the clip's own range, "disparity").
               --metric: 0 to 255 maps to near..far meters from depth.json.
  depth.json   { kind, near, far, fps, frames, width, height, seconds, model }

Setup (once, from the repo root):
  git clone --depth 1 https://github.com/DepthAnything/Video-Depth-Anything.git .depth/Video-Depth-Anything
  uv venv --python 3.12 .depth/venv && VIRTUAL_ENV=.depth/venv uv pip install torch torchvision opencv-python-headless numpy einops easydict tqdm
  checkpoints from huggingface.co/depth-anything into .depth/Video-Depth-Anything/checkpoints/
  (video_depth_anything_vits.pth, metric_video_depth_anything_vits.pth). The Small models are Apache-2.0;
  Base and Large are CC-BY-NC.

The upstream run.py is CUDA-only and needs decord/xformers, so this file loads the model directly.
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import torch

ROOT = Path(__file__).resolve().parent.parent
REPO = ROOT / ".depth" / "Video-Depth-Anything"
sys.path.insert(0, str(REPO))
from video_depth_anything.video_depth import VideoDepthAnything  # noqa: E402

CONFIGS = {
    "vits": {"encoder": "vits", "features": 64, "out_channels": [48, 96, 192, 384]},
    "vitb": {"encoder": "vitb", "features": 128, "out_channels": [96, 192, 384, 768]},
    "vitl": {"encoder": "vitl", "features": 256, "out_channels": [256, 512, 1024, 1024]},
}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video")
    ap.add_argument("--encoder", default="vits", choices=list(CONFIGS))
    ap.add_argument("--metric", action="store_true", help="metric (meters) model instead of relative")
    ap.add_argument("--frames", type=int, default=0, help="only the first N frames (a speed test)")
    ap.add_argument("--input-size", type=int, default=518)
    ap.add_argument("--fp32", action="store_true")
    ap.add_argument("--device", default=None, help="mps, cpu or cuda (default: best available)")
    a = ap.parse_args()

    device = a.device or ("cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu")
    src = Path(a.video)
    cap = cv2.VideoCapture(str(src))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frames = []
    while True:
        ok, bgr = cap.read()
        if not ok or (a.frames and len(frames) >= a.frames):
            break
        frames.append(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    cap.release()
    frames = np.stack(frames)
    n, h, w = frames.shape[:3]
    print(f"{n} frames {w}x{h} @ {fps:.2f} fps, device {device}, {'metric' if a.metric else 'relative'} {a.encoder}")

    name = ("metric_" if a.metric else "") + f"video_depth_anything_{a.encoder}.pth"
    model = VideoDepthAnything(**CONFIGS[a.encoder], metric=a.metric)
    model.load_state_dict(torch.load(REPO / "checkpoints" / name, map_location="cpu"), strict=True)
    model = model.to(device).eval()

    t0 = time.time()
    depths, _ = model.infer_video_depth(frames, fps, input_size=a.input_size, device=device, fp32=a.fp32)
    secs = time.time() - t0
    depths = np.asarray(depths, dtype=np.float32)
    print(f"depth done in {secs:.1f} s ({n / secs:.1f} frames/s)")

    if a.metric:
        near, far = float(np.percentile(depths, 0.5)), float(np.percentile(depths, 99.5))
        norm = 1.0 - np.clip((depths - near) / max(far - near, 1e-6), 0, 1)       # white = near
    else:
        lo, hi = float(np.percentile(depths, 0.5)), float(np.percentile(depths, 99.5))
        near, far = lo, hi                                                          # relative units
        norm = np.clip((depths - lo) / max(hi - lo, 1e-6), 0, 1)                    # model output: larger = nearer
    gray = (norm * 255).astype(np.uint8)

    out_dir = src.parent
    tag = "-metric" if a.metric else ""
    raw = out_dir / f"_depth{tag}.avi"
    writer = cv2.VideoWriter(str(raw), cv2.VideoWriter_fourcc(*"MJPG"), fps, (w, h), isColor=False)
    for g in gray:
        writer.write(g)
    writer.release()
    dst = out_dir / f"depth{tag}.mp4"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(raw), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "14", "-an", str(dst)], check=True)
    raw.unlink()
    meta = {
        "kind": "metric-meters" if a.metric else "relative-disparity",
        "near": near, "far": far, "fps": fps, "frames": n, "width": w, "height": h,
        "seconds": round(secs, 2), "model": name,
    }
    (out_dir / f"depth{tag}.json").write_text(json.dumps(meta, indent=2))
    print("wrote", dst)


if __name__ == "__main__":
    main()
