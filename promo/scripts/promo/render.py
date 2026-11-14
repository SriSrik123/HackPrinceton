#!/usr/bin/env python3
"""Render the Rewind Cardboard promo (KAN-17) as a 65 s mono 360 video.

  python3 scripts/promo/render.py                    # full 3840x1920, 30 fps -> out/
  python3 scripts/promo/render.py --width 1920       # quick low-res pass
  python3 scripts/promo/render.py --stills 3,17,22   # PNG checks only (equirect + headset-view crops)

Drop-in assets in Video/assets/ (all optional; anything missing uses a labelled placeholder):
  home.png                equirect 2:1 render of the home room (kid scene)
  kid1.mp4 .. kid4.mp4    home videos of the kid at ages 1, 4, 7, 10
  party.mp4               the old party video, 20 s used from --party-in (its audio is used too)
  room.png                equirect 2:1 render of the Marble room from the original camera spot
  seat1.png .. seat3.png  equirect renders of the venue from each seat (clips then float, see SEAT_CLIP_VIEW)
  clip1.mp4 .. clip3.mp4  the fan clips, cut at the seat plan's in-times automatically
  concert_audio.wav       one track for all three seats (else clip1's audio from 22.4 s, else synth)
  vo/line1.wav .. line9.wav  recorded voice lines (else macOS `say`)
"""
import argparse
import os
import subprocess
import sys
import time
from multiprocessing import Pool

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
FPS, DUR = 30, 87.0


def prepare(W, cache, assets):
    from geom import Sphere, billboard, pill_tex
    from worlds import room_equirect, stadium_equirect
    os.makedirs(cache, exist_ok=True)
    sph = Sphere(W)
    H = W // 2
    rp = os.path.join(assets, "room.png")
    if os.path.exists(rp):
        room = np.asarray(Image.open(rp).convert("RGB").resize((W, H), Image.LANCZOS), np.float32) / 255
        print("  room: assets/room.png")
    else:
        room = room_equirect(sph)
        lab = pill_tex("PLACEHOLDER ROOM · Marble world goes here", 48, bg=(0, 0, 0, 120))
        for yaw in (-72, 72, 180):
            billboard(room, sph, lab, yaw, 16, 36)
        print("  room: placeholder")
    np.save(os.path.join(cache, "room.npy"), (np.clip(room, 0, 1) * 255).astype(np.uint8))
    hp = os.path.join(assets, "home.png")
    if os.path.exists(hp):
        home = np.asarray(Image.open(hp).convert("RGB").resize((W, H), Image.LANCZOS), np.float32) / 255
        print("  home: assets/home.png")
    else:
        home = room_equirect(sph, wall=(0.55, 0.52, 0.47), floor=(0.46, 0.34, 0.21), lights=False)
        lab = pill_tex("PLACEHOLDER HOME · Marble world goes here", 48, bg=(0, 0, 0, 120))
        for yaw in (-72, 72, 180):
            billboard(home, sph, lab, yaw, 16, 36)
        print("  home: placeholder")
    np.save(os.path.join(cache, "home.npy"), (np.clip(home, 0, 1) * 255).astype(np.uint8))
    for s in (1, 2, 3):
        sp = os.path.join(assets, f"seat{s}.png")
        if os.path.exists(sp):
            base = np.asarray(Image.open(sp).convert("RGB").resize((W, H), Image.LANCZOS), np.float32) / 255
            beams, idx, uv, real = np.zeros((1, 1, 3), np.float16), np.zeros(0, np.int64), np.zeros((0, 2), np.float32), True
            print(f"  seat {s}: assets/seat{s}.png")
        else:
            base, beams, idx, uv = stadium_equirect(sph, s)
            lab = pill_tex("PLACEHOLDER VENUE · splat render from KAN-13 goes here", 48, bg=(0, 0, 0, 120))
            for yaw in (90, -90, 180):
                billboard(base, sph, lab, yaw, 30, 40)
            real = False
            print(f"  seat {s}: placeholder")
        np.savez(os.path.join(cache, f"seat{s}.npz"), base=(np.clip(base, 0, 1) * 255).astype(np.uint8),
                 beams=beams.astype(np.float16), idx=idx, uv=uv, real=real)


def encoder(W, path):
    return subprocess.Popen(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{W // 2}", "-r", str(FPS),
         "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
         "-profile:v", "high", "-level", "5.1", "-g", "30", path], stdin=subprocess.PIPE)


def render_chunk(job):
    W, cache, assets, party_in, f0, f1, path = job
    from timeline import Promo
    p = Promo(W, cache, assets, party_in)
    enc = encoder(W, path)
    for f in range(f0, f1):
        enc.stdin.write(p.frame(f / FPS).tobytes())
    enc.stdin.close()
    enc.wait()
    return path


def stills(W, cache, assets, party_in, times, out):
    from timeline import Promo
    p = Promo(W, cache, assets, party_in)
    os.makedirs(out, exist_ok=True)
    for t in times:
        eq = os.path.join(out, f"eq_{t:05.1f}.png")
        Image.fromarray(p.frame(t)).save(eq)
        for name, yaw in (("front", 0), ("left", -90), ("right", 90)):
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", eq, "-vf",
                            f"v360=e:flat:yaw={yaw}:h_fov=100:v_fov=70:w=1280:h=840",
                            os.path.join(out, f"view_{t:05.1f}_{name}.png")], check=True)
        print("  still", t)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, default=3840)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--party-in", type=float, default=0.0)
    ap.add_argument("--stills", type=str, default="")
    ap.add_argument("--out", default=os.path.join(ROOT, "out"))
    a = ap.parse_args()
    assets = os.path.join(ROOT, "assets")
    cache = os.path.join(a.out, "cache")
    W = a.width - a.width % 32
    t0 = time.time()
    print("environments")
    prepare(W, cache, assets)
    if a.stills:
        stills(W, cache, assets, a.party_in, [float(x) for x in a.stills.split(",")], os.path.join(a.out, "stills"))
        return

    import audio
    print("audio")
    wav = os.path.join(a.out, "mix.wav")
    audio.build(assets, wav, a.party_in)

    print(f"video {W}x{W // 2}, {a.workers} workers")
    n = int(DUR * FPS)
    edges = np.linspace(0, n, a.workers + 1).astype(int)
    seg_dir = os.path.join(a.out, "segments")
    os.makedirs(seg_dir, exist_ok=True)
    jobs = [(W, cache, assets, a.party_in, int(edges[i]), int(edges[i + 1]), os.path.join(seg_dir, f"seg{i:02d}.mp4"))
            for i in range(a.workers)]
    with Pool(a.workers) as pool:
        segs = pool.map(render_chunk, jobs)
    lst = os.path.join(seg_dir, "list.txt")
    with open(lst, "w") as f:
        f.writelines(f"file '{s}'\n" for s in segs)

    raw = os.path.join(a.out, "raw.mp4")
    final = os.path.join(a.out, f"rewind_promo_360_{W}.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-i", wav,
                    "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-shortest", raw], check=True)
    from spherical import inject
    inject(raw, final)
    os.remove(raw)
    flat = os.path.join(a.out, f"rewind_promo_flat_preview.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", final, "-vf", "v360=e:flat:h_fov=100:v_fov=62:w=1920:h=1080",
                    "-c:v", "libx264", "-crf", "20", "-preset", "fast", "-c:a", "copy", flat], check=True)
    print(f"done in {time.time() - t0:.0f}s\n  {final}\n  {flat}")


if __name__ == "__main__":
    main()
