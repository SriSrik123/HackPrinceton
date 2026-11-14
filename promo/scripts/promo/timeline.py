"""The 65 second storyboard (KAN-17), one equirect frame at a time."""
import os
import numpy as np
from PIL import Image, ImageDraw
from geom import (Sphere, billboard, text_tex, pill_tex, to_tex, font, ease, ease_out, ramp, window,
                  AV_BOLD, AV_DEMI, AV_MED, AV_REG)
from worlds import (PartyPlaceholder, ClipPlaceholder, KidPlaceholder, FileSource, feather, pin_tex, SEAT_POS)

# Party video placement (panel 2 end size = panel 3/4 size, so the build never jumps)
VID_YAW, VID_PITCH, VID_W_START, VID_W_END = 0.0, -2.0, 14.0, 64.0
PARTY_START, PARTY_LEN = 6.0, 20.0
# Concert seats: (start, end, clip name, time in that clip at the seat's start, label)
SEATS = {
    1: (30.0, 40.0, "TheValia6", 22.4, "Center"),
    2: (40.0, 48.0, "krhtikos4", 38.3, "Front"),
    3: (48.0, 56.0, "Can Uzunyol", 83.7, "Upper right"),
}
# Where a clip floats when a real seat image (assets/seat{n}.png) replaces the placeholder venue:
# yaw, pitch, width in degrees. Line these up with the venue render.
SEAT_CLIP_VIEW = {1: (0.0, 2.0, 40.0), 2: (0.0, 4.0, 70.0), 3: (-25.0, -3.0, 30.0)}
BPM = 128
# Kid scene: card, then one home video at a time in the same room, years apart
KID_CARD, KID_START, KID_END, LOGO = 58.0, 60.5, 76.0, 78.0
KIDS = [(1, 2016), (4, 2019), (7, 2022), (10, 2025)]
KID_SEG = (KID_END - KID_START) / len(KIDS)
BLUE = np.array([0.36, 0.78, 1.0], np.float32)


class Promo:
    def __init__(self, W, cache, assets, party_in=0.0):
        self.sph = Sphere(W)
        self.W, self.H = W, W // 2
        self.assets = assets
        self.cache = cache
        self._seat = {}
        self.room = np.load(os.path.join(cache, "room.npy")).astype(np.float32) / 255
        pv = os.path.join(assets, "party.mp4")
        self.party = FileSource(pv, (1280, 720), party_in) if os.path.exists(pv) else PartyPlaceholder()
        self.clips = {}
        for s, (_, _, name, cin, _) in SEATS.items():
            cp = os.path.join(assets, f"clip{s}.mp4")
            self.clips[s] = FileSource(cp, (1280, 720), cin) if os.path.exists(cp) else ClipPlaceholder(name, cin, BPM)
        self._build_cells()
        self._tex = {}
        self._frozen = None
        self.home = np.load(os.path.join(cache, "home.npy")).astype(np.float32) / 255
        self.kids = []
        for i, (age, year) in enumerate(KIDS, 1):
            kp = os.path.join(assets, f"kid{i}.mp4")
            self.kids.append(FileSource(kp, (1280, 720), 0.0) if os.path.exists(kp) else KidPlaceholder(i, age, year))
        self.t_kid = KID_START + 0.4 + (self.t_in - 15.5) * 0.5

    # ------------------------------------------------------------ cube cells
    def _build_cells(self):
        H, W, sph = self.H, self.W, self.sph
        base = max(8, W // 96)
        redges = np.round(np.linspace(0, H, H // base + 1)).astype(int)
        cid = np.zeros((H, W), np.int32)
        cx, cy, hx, hy, yaw, pitch = [], [], [], [], [], []
        k = 0
        for r in range(len(redges) - 1):
            r0, r1 = redges[r], redges[r + 1]
            lat = 90 - (r0 + r1) / 2 / H * 180
            ncol = max(1, int(round(W * np.cos(np.radians(lat)) / base)))
            cedges = np.round(np.linspace(0, W, ncol + 1)).astype(int)
            for c in range(ncol):
                c0, c1 = cedges[c], cedges[c + 1]
                cid[r0:r1, c0:c1] = k
                cx.append((c0 + c1 - 1) / 2); cy.append((r0 + r1 - 1) / 2)
                hx.append((c1 - c0) / 2); hy.append((r1 - r0) / 2)
                yaw.append(((c0 + c1) / 2 / W - 0.5) * 360); pitch.append(lat)
                k += 1
        self.cid = cid
        self.ccx, self.ccy = np.array(cx, np.float32), np.array(cy, np.float32)
        self.chx, self.chy = np.array(hx, np.float32), np.array(hy, np.float32)
        yaw, pitch = np.array(yaw), np.array(pitch)
        hw = VID_W_END / 2
        hh = hw * 9 / 16
        d = np.hypot(np.maximum(0, np.abs(yaw - VID_YAW) - hw), np.maximum(0, np.abs(pitch - VID_PITCH) - hh))
        dn = d / d.max()
        rng = np.random.default_rng(5)
        # build: nearest the frame first, 15.5 -> 19.0
        self.t_in = 15.5 + 2.95 * dn ** 0.8 + rng.random(k) * 0.25
        self.t_in[d == 0] = 15.5 + rng.random((d == 0).sum()) * 0.3
        # collapse: mostly random, the video area last, 26.0 -> 27.0
        self.t_out = 26.0 + 0.45 * rng.random(k) + 0.25 * (1 - dn)
        Y, X = np.mgrid[0:H, 0:W]
        self.pdx = (X - self.ccx[cid]).astype(np.float32)
        self.pdy = (Y - self.ccy[cid]).astype(np.float32)

    def _cubes(self, t, src, starts, dur, grow):
        """Each cell pops in (grow) or shrinks away, showing src scaled about its centre, tinted blue."""
        prog = np.clip((t - starts) / dur, 0, 1)
        s = ease_out(prog) if grow else 1 - ease(prog)
        S = s[self.cid]
        hx, hy = self.chx[self.cid], self.chy[self.cid]
        inside = (S > 0.01) & (np.abs(self.pdx) <= S * hx) & (np.abs(self.pdy) <= S * hy)
        out = np.zeros_like(src)
        if not inside.any():
            return out
        Ss = np.maximum(S, 0.01)
        sx = np.clip(np.round(self.ccx[self.cid] + self.pdx / Ss), 0, self.W - 1).astype(np.int32)
        sy = np.clip(np.round(self.ccy[self.cid] + self.pdy / Ss), 0, self.H - 1).astype(np.int32)
        out[inside] = src[sy[inside], sx[inside]]
        # blue tint that fades after each cell lands, and a bright edge while it moves
        age = np.clip((t - starts) / (dur + 0.45), 0, 1)
        tint = ((1 - age) * 0.3 if grow else prog * 0.6)[self.cid]
        moving = ((prog > 0) & (prog < 1))[self.cid]
        rel = np.maximum(np.abs(self.pdx) / np.maximum(S * hx, 1e-3), np.abs(self.pdy) / np.maximum(S * hy, 1e-3))
        edge = inside & moving & (rel > 0.84)
        a = (tint * inside)[..., None]
        out = out * (1 - a) + BLUE * a
        out[edge] = out[edge] * 0.3 + BLUE * 0.9
        return out

    # ------------------------------------------------------------ helpers
    def tex(self, key, fn):
        if key not in self._tex:
            self._tex[key] = fn()
        return self._tex[key]

    def seat(self, s):
        if s not in self._seat:
            z = np.load(os.path.join(self.cache, f"seat{s}.npz"))
            self._seat = {s: dict(base=z["base"].astype(np.float32) / 255,
                                  beams=z["beams"].astype(np.float32),
                                  idx=z["idx"], uv=z["uv"], real=bool(z["real"]))}
        return self._seat[s]

    def video_tex(self, t):
        return feather(self.party.get(max(0.0, min(t, PARTY_LEN - 1 / 30))), 0.05)

    # ------------------------------------------------------------ scenes
    def frame(self, t):
        C = np.zeros((self.H, self.W, 3), np.float32)
        if t < PARTY_START:
            self.title(C, t)
        elif t < 26.0:
            self.party_scene(C, t)
        elif t < 27.0:
            C[:] = self._cubes(t, self.frozen(), self.t_out, 0.28, grow=False)
        elif t < 30.6:
            self.crowd_card(C, t)
        elif t < 58.0:
            self.concert(C, t)
            C *= 1 - ramp(t, 56.0, 58.0)
        elif t < KID_START:
            self.kid_card(C, t)
        elif t < LOGO:
            self.kid_scene(C, t)
            C *= 1 - ramp(t, KID_END, LOGO)
        else:
            self.logo(C, t - LOGO + 58.0)
        return (np.clip(C, 0, 1) * 255 + 0.5).astype(np.uint8)

    def title(self, C, t):
        a = window(t, 1.0, 6.0, 1.0, 1.0)
        tex = self.tex("title", lambda: text_tex("From memories to reality", 120, face=AV_DEMI))
        billboard(C, self.sph, tex, 0, 0, 44, a)

    def party_scene(self, C, t, caption=True):
        lt = t - PARTY_START
        if t >= 15.4:
            C[:] = self._cubes(t, self.room, self.t_in, 0.32, grow=True)
        w = VID_W_START + (VID_W_END - VID_W_START) * ease(lt / 6.0)
        billboard(C, self.sph, self.video_tex(lt), VID_YAW, VID_PITCH, w, ramp(t, 6.0, 7.5))
        if caption:
            a = window(t, 19.3, 25.8, 0.5, 0.5)
            tex = self.tex("cap_room", lambda: pill_tex("Original video preserved. Room generated.", 56, accent=(240, 180, 76)))
            billboard(C, self.sph, tex, 0, -27, 30, a)

    def frozen(self):
        if self._frozen is None:
            f = np.zeros((self.H, self.W, 3), np.float32)
            self.party_scene(f, 25.99, caption=False)
            self._frozen = f
        return self._frozen

    def crowd_card(self, C, t):
        r = 186 * ease_out((t - 29.5) / 1.0)
        if r > 0:
            self.concert(C, max(t, 30.0))
            m = np.clip((r - self.sph.fwd_angle) / 6.0, 0, 1)[..., None]
            rim = np.exp(-((self.sph.fwd_angle - r) / 2.5) ** 2)[..., None] * (1 - ramp(t, 29.8, 30.6))
            C *= m
            C += rim * np.array([1.0, 0.95, 0.85], np.float32) * 0.9
        a = window(t, 27.0, 29.8, 0.5, 0.4)
        tex = self.tex("crowd", lambda: text_tex("Or be in the crowd", 120, face=AV_DEMI))
        billboard(C, self.sph, tex, 0, 0, 36, a)

    def concert(self, C, t):
        s = 1 if t < 40 else 2 if t < 48 else 3
        start = SEATS[s][0]
        seat = self.seat(s)
        beat = ((t - 30.0) * BPM / 60) % 1
        pulse = 0.55 + 0.45 * np.exp(-beat * 4)
        C[:] = seat["base"] + seat["beams"] * pulse
        clip = self.clips[s].get(t - start)
        if seat["real"]:
            yaw, pitch, w = SEAT_CLIP_VIEW[s]
            billboard(C, self.sph, feather(clip, 0.03), yaw, pitch, w)
        else:
            h, w = clip.shape[:2]
            uv = seat["uv"]
            px = np.clip(uv[:, 0] * (w - 1), 0, w - 1).astype(np.int32)
            py = np.clip(uv[:, 1] * (h - 1), 0, h - 1).astype(np.int32)
            flat = C.reshape(-1, 3)
            flat[seat["idx"]] = clip[py, px, :3]
        self.pins(C, t, s)
        if s == 1:
            a = window(t, 30.6, 34.2, 0.5, 0.5)
            tex = self.tex("cap_venue", lambda: pill_tex("Venue recreated from fan clips", 56, accent=(92, 200, 255)))
            billboard(C, self.sph, tex, 0, -27, 24, a)
        for s_cd, (c0, nxt) in {1: (35.0, 2), 2: (43.0, 3)}.items():
            if s == s_cd and c0 <= t < c0 + 5:
                n = 5 - int(t - c0)
                tex = self.tex(f"cd{nxt}{n}", lambda: pill_tex(f"Moving to seat {nxt} in {n}", 52, accent=(92, 200, 255)))
                a = min(ramp(t, c0, c0 + 0.3), 1 - ramp(t, c0 + 4.85, c0 + 5))
                for yaw in (0, 120, -120):
                    billboard(C, self.sph, tex, yaw, -17, 19, a)
        # 0.2 s dip to black at each jump
        for tj in (40.0, 48.0):
            if abs(t - tj) < 0.1:
                C *= abs(t - tj) / 0.1

    def pins(self, C, t, s):
        if s == 1:
            a = ramp(t, 34.0, 34.6)
        elif s == 3:
            a = 1 - ramp(t, 55.0, 56.0)
        else:
            a = 1.0
        if a <= 0:
            return
        me = SEAT_POS[s]
        for o, (_, _, _, _, label) in SEATS.items():
            if o == s:
                tex = self.tex(f"pin_me{o}", lambda: pin_tex(f"You · {label}", current=True))
                billboard(C, self.sph, tex, 0, -30, 6.5, a)
                continue
            v = SEAT_POS[o] - me
            yaw = np.degrees(np.arctan2(v[0], v[2]))
            pitch = np.degrees(np.arctan2(v[1], np.hypot(v[0], v[2])))
            tex = self.tex(f"pin{o}", lambda: pin_tex(label))
            billboard(C, self.sph, tex, yaw, pitch + 3.6, 5.0, a)

    def kid_card(self, C, t):
        a = window(t, KID_CARD, KID_START, 0.5, 0.4)
        tex = self.tex("kidcard", lambda: text_tex("Or watch your kid grow up", 120, face=AV_DEMI))
        billboard(C, self.sph, tex, 0, 0, 44, a)

    def kid_scene(self, C, t):
        C[:] = self._cubes(t, self.home, self.t_kid, 0.3, grow=True)
        lt = t - KID_START
        i = min(len(KIDS) - 1, int(lt / KID_SEG))
        local = lt - i * KID_SEG
        op = ramp(t, KID_START, KID_START + 0.6)
        if i > 0 and local < 0.5:  # dissolve from the previous year
            prev = feather(self.kids[i - 1].get(KID_SEG - 1 / 30), 0.05)
            billboard(C, self.sph, prev, VID_YAW, VID_PITCH, VID_W_END, op)
        billboard(C, self.sph, feather(self.kids[i].get(local), 0.05), VID_YAW, VID_PITCH, VID_W_END,
                  op * ramp(local, 0, 0.5) if i > 0 else op)
        age, year = KIDS[i]
        tex = self.tex(f"kidcap{i}", lambda: pill_tex(f"Age {age} \u00b7 {year}", 60, accent=(240, 180, 76)))
        a = window(local, 0.3, KID_SEG, 0.4, 0.4) if i < len(KIDS) - 1 else ramp(local, 0.3, 0.7) * (1 - ramp(t, 75.0, 75.6))
        billboard(C, self.sph, tex, 0, -27, 13, a)

    def logo(self, C, t):
        g = 1 - ramp(t, 63.0, 65.0)
        if g <= 0:
            return
        W, H = 2400, 900
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        word = "Rewind"
        f = font(300, AV_BOLD)
        total = f.getlength(word)
        icon_w = 250
        x0 = (W - total - icon_w - 60) / 2
        # icon: two left-pointing triangles
        ia = ease_out((t - 58.0) / 0.4)
        ix = x0 + (1 - ia) * 60
        col = (232, 236, 243, int(255 * ia))
        cy = 330
        for k in range(2):
            bx = ix + k * 120
            d.polygon([(bx, cy), (bx + 130, cy - 95), (bx + 130, cy + 95)], fill=col)
        # letters assemble right to left, like tape winding back
        tx = x0 + icon_w + 60
        for i, ch in enumerate(word):
            rank = len(word) - 1 - i
            p = ease_out((t - 58.15 - rank * 0.09) / 0.35)
            if p <= 0:
                continue
            x = tx + f.getlength(word[:i]) + (1 - p) * 220
            d.text((x, cy), ch, font=f, fill=(232, 236, 243, int(255 * p)), anchor="lm")
        ta = ease((t - 59.0) / 0.6)
        if ta > 0:
            d.text((W / 2, 610), "where the past becomes reality", font=font(96, AV_MED),
                   fill=(154, 166, 186, int(255 * ta)), anchor="mm")
        ca = ease((t - 59.8) / 0.6)
        if ca > 0:
            d.text((W / 2, 800), "Fan clips: TheValia6, krhtikos4, Can Uzunyol (Athens, 8 June 2024)  ·  HackPrinceton 2026",
                   font=font(46, AV_REG), fill=(150, 160, 180, int(255 * ca)), anchor="mm")
        billboard(C, self.sph, to_tex(img), 0, 0, 52, g)
