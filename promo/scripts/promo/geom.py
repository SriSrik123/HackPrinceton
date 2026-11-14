"""Equirectangular helpers: ray directions, billboards (flat images placed on the sphere), text.

Convention: column u -> longitude (yaw), left to right = turning right. Row v -> latitude (pitch), top = up.
dir = (cos(p) sin(y), sin(p), cos(p) cos(y)). Yaw 0, pitch 0 is straight ahead (the centre of the frame).
+x is "right" when facing +z, so world geometry uses the same handedness as the image.
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFont

AVENIR = "/System/Library/Fonts/Avenir Next.ttc"
MENLO = "/System/Library/Fonts/Menlo.ttc"
AV_BOLD, AV_DEMI, AV_MED, AV_REG = 0, 2, 5, 7

_font_cache = {}


def font(size, face=AV_DEMI, path=AVENIR):
    key = (path, face, size)
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(path, size, index=face)
    return _font_cache[key]


def ydir(yaw_deg, pitch_deg):
    y, p = np.radians(yaw_deg), np.radians(pitch_deg)
    return np.array([np.cos(p) * np.sin(y), np.sin(p), np.cos(p) * np.cos(y)], np.float32)


def basis(yaw_deg, pitch_deg):
    y, p = np.radians(yaw_deg), np.radians(pitch_deg)
    c = ydir(yaw_deg, pitch_deg)
    r = np.array([np.cos(y), 0.0, -np.sin(y)], np.float32)
    u = np.array([-np.sin(p) * np.sin(y), np.cos(p), -np.sin(p) * np.cos(y)], np.float32)
    return c, r, u


class Sphere:
    def __init__(self, W):
        self.W, self.H = W, W // 2
        u = (np.arange(self.W) + 0.5) / self.W
        v = (np.arange(self.H) + 0.5) / self.H
        self.lon = ((u - 0.5) * 2 * np.pi).astype(np.float32)
        self.lat = ((0.5 - v) * np.pi).astype(np.float32)
        LON, LAT = np.meshgrid(self.lon, self.lat)
        cl = np.cos(LAT)
        self.D = np.stack([cl * np.sin(LON), np.sin(LAT), cl * np.cos(LON)], -1).astype(np.float32)
        self.yaw = np.degrees(LON).astype(np.float32)
        self.pitch = np.degrees(LAT).astype(np.float32)
        # angle from straight ahead, used by the spotlight iris
        self.fwd_angle = np.degrees(np.arccos(np.clip(self.D[..., 2], -1, 1))).astype(np.float32)

    def region(self, yaw_deg, pitch_deg, radius_deg):
        """Rows (slice) and columns (index array, wraps at the seam) that cover a cap of the sphere."""
        lat0 = max(-90.0, pitch_deg - radius_deg)
        lat1 = min(90.0, pitch_deg + radius_deg)
        r0 = int(np.clip(np.floor((90 - lat1) / 180 * self.H) - 1, 0, self.H))
        r1 = int(np.clip(np.ceil((90 - lat0) / 180 * self.H) + 1, 0, self.H))
        worst = np.radians(max(abs(lat0), abs(lat1)))
        if worst > np.radians(88):
            cols = np.arange(self.W)
        else:
            half = min(180.0, radius_deg / np.cos(worst) + 1)
            if half >= 179:
                cols = np.arange(self.W)
            else:
                c0 = (yaw_deg - half + 180) / 360 * self.W
                c1 = (yaw_deg + half + 180) / 360 * self.W
                cols = np.arange(int(np.floor(c0)), int(np.ceil(c1)) + 1) % self.W
        return slice(r0, r1), cols


def bilinear(img, tx, ty):
    """Sample img (h, w, c) float at float pixel coords."""
    h, w = img.shape[:2]
    tx = np.clip(tx, 0, w - 1.001)
    ty = np.clip(ty, 0, h - 1.001)
    x0 = tx.astype(np.int32)
    y0 = ty.astype(np.int32)
    fx = (tx - x0)[..., None]
    fy = (ty - y0)[..., None]
    a = img[y0, x0]
    b = img[y0, x0 + 1]
    c = img[y0 + 1, x0]
    d = img[y0 + 1, x0 + 1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def billboard(canvas, sph, tex, yaw, pitch, width_deg, opacity=1.0, add=False):
    """Composite a premultiplied RGBA float texture onto the equirect canvas as a flat card.

    width_deg is the card's angular width as seen from the centre.
    """
    if opacity <= 0.002:
        return
    ih, iw = tex.shape[:2]
    hw = np.tan(np.radians(width_deg) / 2)
    hh = hw * ih / iw
    radius = np.degrees(np.arctan(np.hypot(hw, hh))) + 1
    rows, cols = sph.region(yaw, pitch, radius)
    sub = sph.D[rows][:, cols]
    c, r, u = basis(yaw, pitch)
    dc = sub @ c
    ok = dc > 1e-3
    dcs = np.where(ok, dc, 1.0)
    x = (sub @ r) / dcs / hw
    y = (sub @ u) / dcs / hh
    inside = ok & (np.abs(x) <= 1) & (np.abs(y) <= 1)
    if not inside.any():
        return
    tx = (x + 1) * 0.5 * (iw - 1)
    ty = (1 - y) * 0.5 * (ih - 1)
    s = bilinear(tex, tx, ty) * (inside[..., None] * opacity)
    region = canvas[rows][:, cols]
    if add:
        region = region + s[..., :3]
    else:
        region = region * (1 - s[..., 3:4]) + s[..., :3]
    canvas[rows, cols] = region


def to_tex(img):
    """PIL RGBA -> premultiplied float32 (h, w, 4)."""
    a = np.asarray(img.convert("RGBA"), np.float32) / 255.0
    a[..., :3] *= a[..., 3:4]
    return a


def text_img(text, size, color=(235, 238, 245), face=AV_DEMI, path=AVENIR, pad=None, tracking=0):
    f = font(size, face, path)
    pad = int(size * 0.35) if pad is None else pad
    if tracking:
        widths = [f.getlength(ch) + tracking for ch in text]
        w = int(sum(widths)) + 2 * pad
    else:
        w = int(f.getlength(text)) + 2 * pad
    asc, desc = f.getmetrics()
    h = asc + desc + 2 * pad
    img = Image.new("RGBA", (max(w, 1), h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if tracking:
        x = pad
        for ch, cw in zip(text, widths):
            d.text((x, pad), ch, font=f, fill=color + (255,))
            x += cw
    else:
        d.text((pad, pad), text, font=f, fill=color + (255,))
    return img


def text_tex(text, size=96, **kw):
    return to_tex(text_img(text, size, **kw))


def pill_tex(text, size=64, fg=(240, 242, 248), bg=(8, 11, 18, 170), face=AV_DEMI, accent=None):
    """Caption on a translucent rounded pill, readable over any background."""
    f = font(size, face)
    padx, pady = int(size * 0.7), int(size * 0.35)
    w = int(f.getlength(text)) + 2 * padx
    asc, desc = f.getmetrics()
    h = asc + desc + 2 * pady
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=h // 2, fill=bg,
                        outline=(accent + (220,)) if accent else None, width=max(2, size // 16))
    d.text((padx, pady), text, font=f, fill=fg + (255,))
    return to_tex(img)


def ease(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def ease_out(x):
    x = np.clip(x, 0.0, 1.0)
    return 1 - (1 - x) ** 3


def ramp(t, a, b):
    """0 before a, 1 after b, smooth in between."""
    if b <= a:
        return 1.0 if t >= a else 0.0
    return float(ease((t - a) / (b - a)))


def window(t, a, b, fade_in, fade_out):
    return min(ramp(t, a, a + fade_in), 1 - ramp(t, b - fade_out, b))
