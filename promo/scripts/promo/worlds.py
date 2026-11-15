"""Placeholder 360 environments (party room, stadium seats) and video sources.

Every placeholder can be replaced by a real asset in Video/assets/ (see render.py).
"""
import subprocess
import numpy as np
from PIL import Image, ImageDraw
from geom import font, to_tex, AV_BOLD, AV_DEMI, AV_MED, MENLO

FPS = 30


# ---------------------------------------------------------------- party room
def room_equirect(sph, wall=(0.36, 0.30, 0.27), floor=(0.30, 0.19, 0.11), lights=True):
    """A simple box room around the viewer: plank floor, plaster walls, string lights, faint grid."""
    D = sph.D
    bx = (-4.5, 4.5); by = (-1.5, 1.4); bz = (-4.0, 3.4)
    eps = 1e-6
    tx = np.where(D[..., 0] > 0, bx[1], bx[0]) / np.where(np.abs(D[..., 0]) < eps, eps, D[..., 0])
    ty = np.where(D[..., 1] > 0, by[1], by[0]) / np.where(np.abs(D[..., 1]) < eps, eps, D[..., 1])
    tz = np.where(D[..., 2] > 0, bz[1], bz[0]) / np.where(np.abs(D[..., 2]) < eps, eps, D[..., 2])
    tx, ty, tz = np.abs(tx), np.abs(ty), np.abs(tz)
    t = np.minimum(np.minimum(tx, ty), tz)
    P = D * t[..., None]
    face = np.argmin(np.stack([tx, ty, tz], -1), -1)  # 0 side walls, 1 floor/ceiling, 2 front/back
    X, Y, Z = P[..., 0], P[..., 1], P[..., 2]
    out = np.zeros(D.shape, np.float32)

    wall = np.array(wall, np.float32)
    floor_rgb = np.array(floor, np.float32)
    # walls: warm plaster, darker toward the floor
    h = (Y - by[0]) / (by[1] - by[0])
    shade = (0.55 + 0.45 * h)[..., None]
    out[:] = wall * shade
    # floor: planks along x
    floor = (face == 1) & (Y < 0)
    plank = (np.floor(Z / 0.22) % 2)[..., None]
    seam = (np.abs(((Z / 0.22) % 1) - 0.5) > 0.47)[..., None]
    fcol = floor_rgb * (0.85 + 0.15 * plank) * (1 - 0.5 * seam)
    out = np.where(floor[..., None], fcol, out)
    ceil = (face == 1) & (Y > 0)
    out = np.where(ceil[..., None], np.array([0.14, 0.12, 0.12], np.float32), out)
    # skirting and a doorway on the right wall, a picture frame on the left wall
    skirt = (face != 1) & (Y < by[0] + 0.12)
    out = np.where(skirt[..., None], np.array([0.18, 0.15, 0.14], np.float32), out)
    door = (face == 0) & (X > 0) & (np.abs(Z + 1.2) < 0.5) & (Y < 0.65)
    out = np.where(door[..., None], np.array([0.12, 0.09, 0.08], np.float32), out)
    frame = (face == 0) & (X < 0) & (np.abs(Z - 0.6) < 0.6) & (np.abs(Y - 0.25) < 0.4)
    out = np.where(frame[..., None], np.array([0.42, 0.33, 0.20], np.float32), out)
    # faint 0.5 m grid: reads as "reconstructed"
    g = 0.5
    def line(a):
        f = np.abs(((a / g) % 1) - 0.5)
        return (f > 0.493).astype(np.float32)
    grid = np.where(face == 0, np.maximum(line(Y), line(Z)),
           np.where(face == 1, np.maximum(line(X), line(Z)), np.maximum(line(X), line(Y))))
    out += grid[..., None] * np.array([0.05, 0.08, 0.12], np.float32)
    # string lights along the top of every wall
    glow = np.zeros(t.shape, np.float32)
    along = np.where(face == 0, Z, X)
    sag = 1.18 - 0.08 * np.cos((along % 1.0) * 2 * np.pi)
    near_top = face != 1
    for k in range(1):
        bulb = (along % 0.5) - 0.25
        d2 = bulb ** 2 + (Y - sag) ** 2
        glow += near_top * np.exp(-d2 / 0.0018) * 1.6 + near_top * np.exp(-d2 / 0.05) * 0.18
    wire = near_top & (np.abs(Y - sag) < 0.006)
    out = np.where(wire[..., None], np.array([0.05, 0.05, 0.05], np.float32), out)
    if lights:
        out += glow[..., None] * np.array([1.0, 0.72, 0.38], np.float32)
    # warm light falloff from the video wall
    out *= (0.75 + 0.25 * np.clip(D[..., 2], 0, 1))[..., None]
    return np.clip(out, 0, 1)


# ---------------------------------------------------------------- stadium
SCREEN = dict(x0=-13.0, x1=13.0, y0=3.0, y1=17.625, z=41.0)
SEAT_POS = {1: np.array([0.0, 3.0, -25.0]), 2: np.array([0.0, 1.7, 14.0]), 3: np.array([34.0, 15.0, -20.0])}


def stadium_equirect(sph, seat):
    """Raycast a placeholder arena from one seat. Returns (base rgb, beams rgb, screen_idx, screen_uv)."""
    p = SEAT_POS[seat].astype(np.float32)
    D = sph.D.reshape(-1, 3)
    n = D.shape[0]
    INF = np.float32(1e9)
    dx, dy, dz = D[:, 0], D[:, 1], D[:, 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        t_floor = np.where(dy < -1e-6, (0 - p[1]) / dy, INF)
        t_roof = np.where(dy > 1e-6, (34 - p[1]) / dy, INF)
        R = 58.0
        a = dx * dx + dz * dz
        b = 2 * (p[0] * dx + p[2] * dz)
        c = p[0] ** 2 + p[2] ** 2 - R * R
        t_wall = np.where(a > 1e-8, (-b + np.sqrt(np.maximum(b * b - 4 * a * c, 0))) / (2 * a), INF)
        # stage front face and top
        t_sf = np.where(dz > 1e-6, (30 - p[2]) / dz, INF)
        xs, ys = p[0] + t_sf * dx, p[1] + t_sf * dy
        t_sf = np.where((np.abs(xs) < 18) & (ys >= 0) & (ys < 1.8), t_sf, INF)
        t_st = np.where(dy < -1e-6, (1.8 - p[1]) / dy, INF)
        xs, zs = p[0] + t_st * dx, p[2] + t_st * dz
        t_st = np.where((np.abs(xs) < 18) & (zs > 30) & (zs < 43), t_st, INF)
        t_sc = np.where(dz > 1e-6, (SCREEN["z"] - p[2]) / dz, INF)
        xs, ys = p[0] + t_sc * dx, p[1] + t_sc * dy
        on_sc = (xs > SCREEN["x0"] - 0.6) & (xs < SCREEN["x1"] + 0.6) & (ys > SCREEN["y0"] - 0.6) & (ys < SCREEN["y1"] + 0.6)
        t_sc = np.where(on_sc, t_sc, INF)
    T = np.stack([t_floor, t_roof, t_wall, t_sf, t_st, t_sc], -1)
    T = np.where(T > 0, T, INF)
    hit = np.argmin(T, -1)
    t = T[np.arange(n), hit]
    P = p[None, :] + D * t[:, None]
    X, Y, Z = P[:, 0], P[:, 1], P[:, 2]
    col = np.zeros((n, 3), np.float32)

    def hashf(i, j, s):
        h = np.sin(i * 127.1 + j * 311.7 + s * 74.7) * 43758.5453
        return h - np.floor(h)

    def lights(u, v, cell, prob, rad, seed):
        i, j = np.floor(u / cell), np.floor(v / cell)
        on = hashf(i, j, seed) < prob
        ox = hashf(i, j, seed + 1) * 0.6 + 0.2
        oy = hashf(i, j, seed + 2) * 0.6 + 0.2
        du, dv = (u / cell - i - ox), (v / cell - j - oy)
        d2 = (du * du + dv * dv) * cell * cell
        r = rad + t * 0.0012  # soften with distance so it does not alias
        hue = hashf(i, j, seed + 3)
        return on * np.exp(-d2 / (r * r)), hue

    stage_c = np.array([0, 8, 38.0])
    dist_stage = np.sqrt((X - stage_c[0]) ** 2 + (Z - stage_c[2]) ** 2)
    stage_glow = np.exp(-dist_stage / 38.0)

    # floor: the pit with phone lights
    m = hit == 0
    base = np.array([0.03, 0.035, 0.06]) + np.array([0.10, 0.08, 0.16]) * stage_glow[:, None]
    lt, hue = lights(X, Z, 0.9, 0.30, 0.035, 1.0)
    phone = np.stack([0.9 + 0.1 * hue, 0.9 * np.ones_like(hue), np.ones_like(hue)], -1) * lt[:, None] * 0.7
    col[m] = (base + phone)[m]
    # roof: dark with a truss grid
    m = hit == 1
    tr = ((np.abs((X / 6) % 1 - 0.5) > 0.48) | (np.abs((Z / 6) % 1 - 0.5) > 0.48)).astype(np.float32)
    col[m] = (np.array([0.015, 0.015, 0.025]) + tr[:, None] * np.array([0.05, 0.05, 0.07]))[m]
    # wall: stands with rows of seats and phone lights, a ring light at the top, black behind the stage
    m = hit == 2
    ang = np.arctan2(X, Z) * R
    rows = (np.abs((Y / 1.1) % 1 - 0.5) > 0.42).astype(np.float32)
    stands = (Y < 20).astype(np.float32)
    wl, hue = lights(ang, Y, 0.8, 0.22, 0.06, 7.0)
    behind = ((Z > 26) & (np.abs(X) < 24)).astype(np.float32)
    wc = (np.array([0.05, 0.05, 0.09]) + rows[:, None] * 0.03) * stands[:, None] \
        + wl[:, None] * stands[:, None] * np.stack([np.ones_like(hue), 0.85 + 0.15 * hue, 0.95 * np.ones_like(hue)], -1) * 0.8
    ring = np.exp(-((Y - 20.5) ** 2) / 0.05)[:, None] * np.array([0.25, 0.55, 0.95])
    wc = wc * (0.4 + 0.8 * stage_glow[:, None]) + ring
    wc = wc * (1 - behind[:, None]) + behind[:, None] * np.array([0.01, 0.01, 0.015])
    col[m] = wc[m]
    # stage
    m = hit == 3
    strip = np.exp(-((Y - 1.6) ** 2) / 0.004)[:, None] * np.array([0.3, 0.7, 1.0])
    col[m] = (np.array([0.04, 0.04, 0.05]) + strip)[m]
    m = hit == 4
    col[m] = np.array([0.10, 0.10, 0.13])
    # screen (frame here, content is composited per frame)
    m = hit == 5
    col[m] = np.array([0.02, 0.02, 0.03])
    sx = (X - SCREEN["x0"]) / (SCREEN["x1"] - SCREEN["x0"])
    sy = (SCREEN["y1"] - Y) / (SCREEN["y1"] - SCREEN["y0"])
    inner = m & (sx >= 0) & (sx <= 1) & (sy >= 0) & (sy <= 1)
    screen_idx = np.nonzero(inner)[0]
    screen_uv = np.stack([sx[inner], sy[inner]], -1).astype(np.float32)

    # light beams from the stage: closest distance between the view ray and each beam segment
    beams = np.zeros((n, 3), np.float32)
    srcs = [(-12, 18, 40), (-6, 18, 40), (0, 18, 40), (6, 18, 40), (12, 18, 40)]
    tgts = [(-30, 2, -10), (-12, 30, 0), (0, 4, -30), (12, 30, 0), (30, 2, -10)]
    tints = [(0.35, 0.6, 1.0), (0.8, 0.4, 1.0), (0.4, 0.8, 1.0), (0.8, 0.4, 1.0), (0.35, 0.6, 1.0)]
    for s, e, tint in zip(srcs, tgts, tints):
        s = np.array(s, np.float32); e = np.array(e, np.float32)
        u = e - s; L = np.linalg.norm(u); u /= L
        w0 = (p - s).astype(np.float32)
        b_ = D @ u
        d_ = D @ w0
        e_ = float(u @ w0)
        den = np.maximum(1 - b_ ** 2, 1e-6)
        tc = np.clip((e_ - b_ * d_) / den, 0, L)  # along the beam
        sc = np.maximum(((s[None, :] + u[None, :] * tc[:, None] - p) * D).sum(1), 0)  # along the view ray
        q1 = p[None, :] + D * sc[:, None]
        q2 = s[None, :] + u[None, :] * tc[:, None]
        dist = np.linalg.norm(q1 - q2, axis=1)
        width = 0.4 + tc * 0.12
        vis = (sc < t + 0.5).astype(np.float32)
        inten = np.exp(-(dist / width) ** 2) * (1 - tc / L) * 0.22 * vis
        beams += inten[:, None] * np.array(tint, np.float32)
    H, W = sph.H, sph.W
    return (np.clip(col, 0, 1).reshape(H, W, 3).astype(np.float32),
            beams.reshape(H, W, 3).astype(np.float32), screen_idx, screen_uv)


# ---------------------------------------------------------------- video sources
class FileSource:
    """Reads a real video sequentially through ffmpeg, starting at `start` seconds in the file."""

    def __init__(self, path, size, start=0.0):
        self.path, self.size, self.start = path, size, start
        self.proc = None
        self.idx = -1
        self.frame = np.zeros((size[1], size[0], 4), np.float32)
        self.frame[..., 3] = 1

    def _open(self, t):
        w, h = self.size
        self.base = int(round(t * FPS))
        cmd = ["ffmpeg", "-v", "error", "-ss", f"{self.start + t:.3f}", "-i", self.path,
               "-vf", f"fps={FPS},scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2",
               "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
        self.idx = self.base - 1

    def get(self, t):
        target = int(round(t * FPS))
        if self.proc is None or target < self.idx:
            self._open(t)
        w, h = self.size
        while self.idx < target:
            buf = self.proc.stdout.read(w * h * 3)
            if len(buf) < w * h * 3:
                self.idx = target
                break
            self.idx += 1
            if self.idx >= target:
                rgb = np.frombuffer(buf, np.uint8).reshape(h, w, 3).astype(np.float32) / 255
                self.frame = np.dstack([rgb, np.ones((h, w, 1), np.float32)])
        return self.frame


class PartyPlaceholder:
    """Stand-in for the old party video: warm colours, moving lights, confetti, a running timecode."""

    def __init__(self, size=(960, 540)):
        self.size = size
        rng = np.random.default_rng(3)
        self.conf = rng.random((70, 4))

    def get(self, t):
        w, h = self.size
        img = Image.new("RGB", (w, h), (40, 22, 30))
        d = ImageDraw.Draw(img, "RGBA")
        for i, (cx, cy, col) in enumerate([(0.25, 0.35, (255, 120, 60)), (0.7, 0.3, (240, 80, 160)), (0.5, 0.75, (255, 190, 80))]):
            x = (cx + 0.12 * np.sin(t * 0.9 + i * 2)) * w
            y = (cy + 0.08 * np.cos(t * 1.3 + i)) * h
            for r, a in [(260, 28), (170, 40), (90, 60)]:
                d.ellipse([x - r, y - r, x + r, y + r], fill=col + (a,))
        for cx, cy, sp, hue in self.conf:
            x = (cx * w + 30 * np.sin(t * 2 + hue * 9)) % w
            y = (cy * h + t * (40 + sp * 60)) % h
            c = (255, int(150 + 100 * hue), int(80 + 150 * (1 - hue)), 200)
            d.rectangle([x, y, x + 9, y + 6], fill=c)
        d.rectangle([0, 0, w - 1, h - 1], outline=(240, 180, 76), width=6)
        d.text((w / 2, h * 0.40), "PARTY VIDEO", font=font(64, AV_BOLD), fill=(255, 240, 220), anchor="mm")
        d.text((w / 2, h * 0.53), "placeholder · drop assets/party.mp4", font=font(30, AV_MED), fill=(255, 225, 190), anchor="mm")
        d.text((w / 2, h * 0.68), f"{int(t // 60):02d}:{t % 60:04.1f}", font=font(34, 0, MENLO), fill=(255, 235, 210), anchor="mm")
        a = np.asarray(img, np.float32) / 255
        return np.dstack([a, np.ones((h, w, 1), np.float32)])


class KidPlaceholder:
    """Stand-in for one home video of the kid at a given age; the figure gets taller with age."""

    def __init__(self, n, age, year, size=(960, 540)):
        self.n, self.age, self.year, self.size = n, age, year, size

    def get(self, t):
        w, h = self.size
        img = Image.new("RGB", (w, h), (58, 52, 44))
        d = ImageDraw.Draw(img, "RGBA")
        d.ellipse([w * 0.55, -h * 0.3, w * 1.2, h * 0.5], fill=(255, 236, 200, 50))  # window light
        s = 0.35 + 0.06 * self.age
        cx = w * 0.32 + 18 * np.sin(t * 1.4)
        base = h * 0.92
        body = h * 0.42 * s
        head = h * 0.11 * (0.8 + 0.2 * s)
        d.rounded_rectangle([cx - body * 0.28, base - body, cx + body * 0.28, base], radius=20, fill=(240, 180, 76, 230))
        hy = base - body - head + 4 * np.sin(t * 3)
        d.ellipse([cx - head, hy - head, cx + head, hy + head], fill=(250, 214, 170, 255))
        d.rectangle([0, 0, w - 1, h - 1], outline=(240, 180, 76), width=6)
        d.text((w * 0.66, h * 0.36), "HOME VIDEO", font=font(54, AV_BOLD), fill=(255, 240, 220), anchor="mm")
        d.text((w * 0.66, h * 0.49), f"age {self.age} \u00b7 {self.year}", font=font(40, AV_DEMI), fill=(255, 225, 190), anchor="mm")
        d.text((w * 0.66, h * 0.60), f"placeholder \u00b7 assets/kid{self.n}.mp4", font=font(26, AV_MED), fill=(255, 225, 190), anchor="mm")
        d.text((w * 0.66, h * 0.72), f"{int(t // 60):02d}:{t % 60:04.1f}", font=font(30, 0, MENLO), fill=(255, 235, 210), anchor="mm")
        a = np.asarray(img, np.float32) / 255
        return np.dstack([a, np.ones((h, w, 1), np.float32)])


class ClipPlaceholder:
    """Stand-in for one fan clip on the stage screen: name, its own clip time, bars on the beat."""

    def __init__(self, name, clip_in, bpm=128, size=(960, 540)):
        self.name, self.clip_in, self.bpm, self.size = name, clip_in, bpm, size

    def get(self, t):
        w, h = self.size
        img = Image.new("RGB", (w, h), (10, 26, 48))
        d = ImageDraw.Draw(img, "RGBA")
        beat = (t * self.bpm / 60) % 1
        pulse = np.exp(-beat * 5)
        for i in range(24):
            bh = (0.2 + 0.6 * abs(np.sin(i * 1.7 + t * 3.1)) * (0.5 + 0.5 * pulse)) * h * 0.5
            x = 40 + i * (w - 80) / 24
            d.rectangle([x, h - 30 - bh, x + (w - 80) / 24 - 8, h - 30], fill=(92, 200, 255, 120))
        d.rectangle([0, 0, w - 1, h - 1], outline=(92, 200, 255), width=6)
        d.text((w / 2, h * 0.30), "FAN CLIP", font=font(58, AV_BOLD), fill=(225, 244, 255), anchor="mm")
        d.text((w / 2, h * 0.43), self.name, font=font(40, AV_DEMI), fill=(200, 235, 255), anchor="mm")
        ct = self.clip_in + t
        d.text((w / 2, h * 0.56), f"clip time {int(ct // 60)}:{ct % 60:04.1f}", font=font(30, 0, MENLO), fill=(200, 235, 255), anchor="mm")
        a = np.asarray(img, np.float32) / 255
        return np.dstack([a, np.ones((h, w, 1), np.float32)])


def feather(tex, frac=0.06):
    """Soft edges so a flat video blends into the room (premultiplied alpha)."""
    h, w = tex.shape[:2]
    fx = np.minimum(np.arange(w), np.arange(w)[::-1]) / (w * frac)
    fy = np.minimum(np.arange(h), np.arange(h)[::-1]) / (h * frac)
    m = np.clip(np.minimum(fy[:, None], fx[None, :]), 0, 1)
    m = m * m * (3 - 2 * m)
    out = tex.copy()
    out[..., :4] *= m[..., None]
    return out


def pin_tex(label, current=False, size=220):
    w, h = size, int(size * 1.55)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, r = w / 2, w * 0.28
    cy = r + w * 0.12
    fill = (92, 200, 255, 255) if current else (60, 72, 96, 235)
    edge = (92, 200, 255, 255) if current else (170, 185, 210, 255)
    d.polygon([(cx - r * 0.82, cy + r * 0.5), (cx + r * 0.82, cy + r * 0.5), (cx, cy + r * 2.0)], fill=fill)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill, outline=edge, width=5)
    d.ellipse([cx - r * 0.38, cy - r * 0.38, cx + r * 0.38, cy + r * 0.38], fill=(6, 8, 13, 255))
    if current:
        d.ellipse([cx - r * 1.45, cy + r * 2.0 - r * 0.5, cx + r * 1.45, cy + r * 2.0 + r * 0.5], outline=(92, 200, 255, 255), width=6)
    f = font(int(size * 0.17), AV_DEMI)
    d.text((cx, h - size * 0.13), label, font=f, fill=(235, 240, 250, 255), anchor="mm",
           stroke_width=4, stroke_fill=(0, 0, 0, 200))
    return to_tex(img)
