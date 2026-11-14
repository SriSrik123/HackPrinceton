"""Sound for the promo: voiceover (macOS `say` unless a recording is dropped in), placeholder music beds,
tape whooshes, a chime, 8 dB ducking under every voice line. Writes one 48 kHz stereo WAV."""
import os
import subprocess
import tempfile
import wave
import numpy as np
from scipy.signal import butter, sosfilt

SR = 48000
DUR = 87.0
VOICE = "Samantha"

# (start, line, must end by). Times from the storyboard's voiceover table.
VO = [
    (1.5, "From memories to reality.", 5.0),
    (14.0, "Rewind to the past.", 15.6),
    (19.0, "The original video is preserved while the room is generated around you.", 24.2),
    (27.5, "Or be in the crowd.", 29.6),
    (30.5, "By clips gathered from the internet, you can experience the concert yourself.", 36.3),
    (36.5, "Enjoy the thrill from all angles.", 39.8),
    (58.4, "Or watch your kid grow up.", 60.4),
    (62.2, "Every year, right where it happened.", 66.0),
    (81.0, "Rewind: where the past becomes reality.", 84.8),
]

rng = np.random.default_rng(11)


def decode(path, start=0.0, dur=None, channels=1):
    """Any audio/video file -> float32 array at SR, or None if it has no audio."""
    cmd = ["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-i", path]
    if dur:
        cmd += ["-t", f"{dur:.3f}"]
    cmd += ["-vn", "-ac", str(channels), "-ar", str(SR), "-f", "f32le", "-"]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0 or not r.stdout:
        return None
    a = np.frombuffer(r.stdout, np.float32)
    return a.reshape(-1, channels) if channels > 1 else a


def tts(text, rate):
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "l.aiff")
        subprocess.run(["say", "-v", VOICE, "-r", str(rate), "-o", p, text], check=True)
        return decode(p)


def trim(a, thr=0.003):
    idx = np.nonzero(np.abs(a) > thr)[0]
    return a[idx[0]: idx[-1] + 1] if len(idx) else a


def voice_lines(assets):
    out = []
    for i, (start, text, end_by) in enumerate(VO, 1):
        rec = os.path.join(assets, "vo", f"line{i}.wav")
        if os.path.exists(rec):
            a, src = trim(decode(rec)), "recording"
        else:
            rate = 165
            while True:
                a = trim(tts(text, rate))
                if start + len(a) / SR <= end_by or rate >= 205:
                    break
                rate += 10
            src = f"say {VOICE} r{rate}"
        a = a / (np.abs(a).max() + 1e-9) * 0.7
        end = start + len(a) / SR
        flag = "" if end <= end_by else "  << runs past its slot"
        print(f"  VO{i} {start:5.1f}-{end:5.1f}s ({src}){flag}  {text}")
        out.append((start, a))
    return out


# ---------------------------------------------------------------- synth parts
def lp(x, f, order=2):
    return sosfilt(butter(order, f, "low", fs=SR, output="sos"), x)


def hp(x, f, order=2):
    return sosfilt(butter(order, f, "high", fs=SR, output="sos"), x)


def bp(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, hi], "band", fs=SR, output="sos"), x)


def place(buf, sig, t0, gain=1.0):
    i = int(t0 * SR)
    if i >= len(buf):
        return
    j = min(len(buf), i + len(sig))
    buf[i:j] += sig[: j - i] * gain


def kick():
    t = np.arange(int(0.45 * SR)) / SR
    f = 45 + 90 * np.exp(-t * 28)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 7)


def noise_hit(dur, decay, lo, hi):
    n = int(dur * SR)
    t = np.arange(n) / SR
    return bp(rng.standard_normal(n), lo, hi) * np.exp(-t * decay)


def tone(freqs, dur, harmonics=6, attack=0.01, decay=1.5, detune=0.004):
    n = int(dur * SR)
    t = np.arange(n) / SR
    s = np.zeros(n)
    for f in freqs:
        for dt in (-detune, detune):
            for k in range(1, harmonics + 1):
                s += np.sin(2 * np.pi * f * (1 + dt) * k * t) / k
    env = np.minimum(t / attack, 1) * np.exp(-t * decay)
    return s * env / (len(freqs) * 2 * 2.5)


def note(n):  # MIDI -> Hz
    return 440 * 2 ** ((n - 69) / 12)


CHORDS = {"C": [60, 64, 67], "Am": [57, 60, 64], "F": [53, 57, 60], "G": [55, 59, 62], "Em": [52, 55, 59]}


def party_bed(dur):
    """Warm, slightly muffled pop loop, like music in the background of an old phone video."""
    bpm = 116
    beat = 60 / bpm
    buf = np.zeros(int(dur * SR))
    prog = ["C", "Am", "F", "G"]
    nbeats = int(dur / beat) + 1
    for b in range(nbeats):
        t0 = b * beat
        place(buf, kick(), t0, 0.8)
        if b % 2 == 1:
            place(buf, noise_hit(0.2, 18, 900, 4000), t0, 0.35)
        place(buf, noise_hit(0.06, 60, 6000, 12000), t0 + beat / 2, 0.15)
        if b % 4 == 0:
            ch = CHORDS[prog[(b // 4) % 4]]
            place(buf, tone([note(n) for n in ch], beat * 4, decay=0.7), t0, 0.55)
            place(buf, tone([note(ch[0] - 24)], beat * 4, harmonics=2, decay=0.5), t0, 0.7)
        if b % 4 == 2:
            ch = CHORDS[prog[(b // 4) % 4]]
            place(buf, tone([note(n + 12) for n in ch], beat, decay=4), t0, 0.2)
    buf = lp(buf, 3800)  # phone-mic dullness
    # small room: a couple of early reflections
    out = buf.copy()
    for d, g in [(0.023, 0.35), (0.041, 0.25), (0.067, 0.15)]:
        out[int(d * SR):] += buf[: len(buf) - int(d * SR)] * g
    out += lp(rng.standard_normal(len(out)), 600) * 0.02  # chatter-ish murmur
    return out


def concert_bed(dur):
    """Big arena placeholder: 128 bpm, sub bass, pads, crowd roar. Starts on a downbeat."""
    bpm = 128
    beat = 60 / bpm
    n = int(dur * SR)
    buf = np.zeros(n)
    prog = ["Am", "F", "C", "G"]
    for b in range(int(dur / beat) + 1):
        t0 = b * beat
        place(buf, kick(), t0, 1.0)
        if b % 2 == 1:
            place(buf, noise_hit(0.25, 14, 700, 5000), t0, 0.45)
        place(buf, noise_hit(0.05, 70, 7000, 14000), t0 + beat / 2, 0.18)
        if b % 4 == 0:
            ch = CHORDS[prog[(b // 4) % 4]]
            place(buf, tone([note(x) for x in ch] + [note(ch[0] + 12)], beat * 4, harmonics=8, attack=0.05, decay=0.25), t0, 0.6)
            place(buf, tone([note(ch[0] - 24)], beat * 4, harmonics=3, decay=0.4), t0, 0.9)
    place(buf, noise_hit(2.5, 1.6, 3000, 15000), 0, 0.6)  # crash on the first beat
    buf = lp(buf, 7000)
    # arena slap-back
    out = buf.copy()
    for d, g in [(0.09, 0.3), (0.17, 0.18), (0.29, 0.1)]:
        out[int(d * SR):] += buf[: n - int(d * SR)] * g
    t = np.arange(n) / SR
    crowd = lp(rng.standard_normal(n), 1400) * (0.10 + 0.04 * np.sin(2 * np.pi * 0.23 * t))
    cheer = bp(rng.standard_normal(n), 900, 3500) * 0.05 * (0.5 + 0.5 * np.sin(2 * np.pi * 0.11 * t + 1)) ** 4
    return out + crowd + cheer


def kid_bed(dur):
    """Gentle music-box arpeggios over a soft pad: home-video warmth."""
    bpm = 84
    step = 60 / bpm / 2
    buf = np.zeros(int(dur * SR))
    prog = ["C", "G", "Am", "F"]
    for i in range(int(dur / step) + 1):
        ch = CHORDS[prog[(i // 8) % 4]]
        nt = ch[i % 3] + 12 + (12 if i % 8 >= 6 else 0)
        place(buf, tone([note(nt)], 1.2, harmonics=2, attack=0.002, decay=4, detune=0.001), i * step, 0.35)
        if i % 8 == 0:
            place(buf, tone([note(x) for x in ch], step * 8, harmonics=3, attack=0.4, decay=0.3), i * step, 0.25)
    return lp(buf, 5000)


def whoosh(dur, f_from, f_to, flutter=0.0):
    """Band-swept noise. flutter adds tape-like amplitude wobble."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = t / dur
    centers = np.geomspace(150, 9000, 10)
    noise = rng.standard_normal(n)
    bands = [bp(noise, c / 1.4, min(c * 1.4, SR / 2 - 100)) for c in centers]
    fc = np.exp(np.log(f_from) + (np.log(f_to) - np.log(f_from)) * x)
    s = np.zeros(n)
    for c, bnd in zip(centers, bands):
        s += bnd * np.exp(-(np.log(c / fc)) ** 2 / 0.35)
    env = np.sin(np.pi * x) ** 1.5
    if flutter:
        env *= 1 + flutter * np.sin(2 * np.pi * 11 * t)
    return s * env / (np.abs(s).max() + 1e-9)


def tape_rewind(dur):
    t = np.arange(int(dur * SR)) / SR
    f = 2400 * np.exp(-t * 1.2) + 300 + 40 * np.sin(2 * np.pi * 13 * t)
    chirp = np.sin(2 * np.pi * np.cumsum(f) / SR) * 0.15 * np.sin(np.pi * t / dur)
    return whoosh(dur, 6000, 500, flutter=0.35) + chirp


def chime():
    t = np.arange(int(3.0 * SR)) / SR
    s = sum(a * np.sin(2 * np.pi * f * t) * np.exp(-t * d)
            for f, a, d in [(880, 1, 1.4), (1320, 0.5, 2.0), (1760, 0.35, 2.6), (2637, 0.2, 3.5)])
    return s * np.minimum(t / 0.004, 1) / 2.0


def env_fade(n_total, pts):
    """Piecewise-linear gain curve from (time, gain) points, in dB-ish smoothness via cosine ramps."""
    t = np.arange(n_total) / SR
    g = np.interp(t, [p[0] for p in pts], [p[1] for p in pts])
    return g


def build(assets, out_path, party_in=0.0, concert_in=22.4):
    n = int(DUR * SR)
    music = np.zeros(n)
    fx = np.zeros(n)
    voice = np.zeros(n)

    # room tone under the intro
    fx[: int(6.5 * SR)] += lp(rng.standard_normal(int(6.5 * SR)), 400) * 0.004

    # party: real audio from assets/party.mp4 if it has any
    party_file = os.path.join(assets, "party.mp4")
    party = decode(party_file, party_in, 22.0) if os.path.exists(party_file) else None
    src = "assets/party.mp4" if party is not None else "placeholder synth"
    if party is None:
        party = party_bed(22.0)
    else:
        party = party / (np.abs(party).max() + 1e-9) * 0.8
    g = env_fade(len(party), [(0, 0), (6.0, 1.0), (20.0, 1.0), (22.0, 0.0)])
    place(music, party * g ** 2, 6.0, 0.55)
    print(f"  party audio: {src}")

    # concert: one track under all three seats so the sound never changes at a jump
    concert = None
    for name in ("concert_audio.wav", "concert_audio.m4a", "concert_audio.mp3"):
        p = os.path.join(assets, name)
        if os.path.exists(p):
            concert, src = decode(p, 0.0, 28.0), name
            break
    if concert is None and os.path.exists(os.path.join(assets, "clip1.mp4")):
        concert, src = decode(os.path.join(assets, "clip1.mp4"), concert_in, 28.0), "clip1.mp4 audio"
    if concert is None:
        concert, src = concert_bed(28.0), "placeholder synth"
    else:
        concert = concert / (np.abs(concert).max() + 1e-9) * 0.8
    g = env_fade(len(concert), [(0, 1.0), (25.0, 1.0), (28.0, 0.0)])
    place(music, concert * g, 30.0, 0.5)
    print(f"  concert audio: {src}")

    # effects
    place(fx, tape_rewind(3.3), 15.4, 0.10)
    place(fx, whoosh(1.1, 400, 5000), 25.9, 0.10)
    place(fx, whoosh(0.9, 200, 2500), 29.3, 0.08)
    for tj in (40.0, 48.0):
        place(fx, whoosh(0.4, 800, 6000), tj - 0.25, 0.12)
    place(fx, whoosh(0.9, 200, 2500), 59.9, 0.08)
    for tc in (64.375, 68.25, 72.125):
        place(fx, tape_rewind(0.7), tc - 0.35, 0.07)
    kid = kid_bed(19.0)
    place(music, kid * env_fade(len(kid), [(0, 0), (1.0, 1), (16.0, 1), (18.5, 0), (19, 0)]), 59.5, 0.5)
    place(fx, tape_rewind(1.3), 79.2, 0.12)
    place(fx, chime(), 80.5, 0.16)

    # voice + ducking
    t = np.arange(n) / SR
    duck = np.ones(n)
    for start, a in voice_lines(assets):
        place(voice, a, start)
        end = start + len(a) / SR
        d = np.interp(t, [start - 0.15, start, end, end + 0.35], [1, 10 ** (-8 / 20), 10 ** (-8 / 20), 1])
        duck = np.minimum(duck, d)
    mix = (music + fx) * duck + voice
    mix = mix / (np.abs(mix).max() + 1e-9) * 0.89  # -1 dBFS peak
    # fade everything out by 1:05
    mix *= np.interp(t, [0, 85.0, 86.9, DUR], [1, 1, 0, 0])
    st = np.stack([mix, mix], 1)
    pcm = (np.clip(st, -1, 1) * 32767).astype(np.int16)
    with wave.open(out_path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
