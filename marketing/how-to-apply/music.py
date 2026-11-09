"""Original background tune for the "How to apply" video.

Composed and synthesised here from scratch (no samples, no third-party
music), so it is free to use anywhere. Upbeat, light "explainer" style:
marimba-like plucks, soft pads, bass and gentle drums at 112 BPM.

    python3 marketing/how-to-apply/music.py out.wav [seconds]
"""
import sys
import wave
import numpy as np

SR = 44100
BPM = 112
BEAT = 60 / BPM
BAR = 4 * BEAT
rng = np.random.default_rng(7)


def note_hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def env(n, attack, decay_rate):
    t = np.arange(n) / SR
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    return a * np.exp(-t * decay_rate)


def place(buf, start_s, sig, gain=1.0):
    i = int(start_s * SR)
    if i >= len(buf):
        return
    j = min(len(buf), i + len(sig))
    sig = sig.copy()
    tail = min(len(sig), int(0.012 * SR))   # short fade-out so notes never end in a click
    sig[-tail:] *= np.linspace(1, 0, tail)
    buf[i:j] += sig[: j - i] * gain


def pluck(midi, dur=0.45):
    """Marimba-ish: fundamental + bright 4th harmonic, fast decay."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = note_hz(midi)
    s = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * 4 * f * t) * np.exp(-t * 30)
    return s * env(n, 0.003, 9)


def pad(midis, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    s = np.zeros(n)
    for m in midis:
        f = note_hz(m)
        for h, a in ((1, 1.0), (2, 0.3), (3, 0.12)):
            s += a * np.sin(2 * np.pi * f * h * t + rng.uniform(0, 6.28))
    shape = np.clip(t / 0.35, 0, 1) * np.clip((dur - t) / 0.35, 0, 1)
    return s * shape / len(midis)


def bass(midi, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = note_hz(midi)
    return (np.sin(2 * np.pi * f * t) + 0.25 * np.sin(2 * np.pi * 2 * f * t)) * env(n, 0.005, 3.5)


def kick():
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    f = 50 + 90 * np.exp(-t * 35)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)


def clap():
    n = int(0.22 * SR)
    t = np.arange(n) / SR
    noise = rng.uniform(-1, 1, n)
    noise = np.diff(noise, prepend=0)  # brighter
    return noise * np.exp(-t * 22) * 0.6 + 0.3 * np.sin(2 * np.pi * 190 * t) * np.exp(-t * 30)


def hat():
    n = int(0.06 * SR)
    t = np.arange(n) / SR
    noise = np.diff(rng.uniform(-1, 1, n), prepend=0)
    return noise * np.exp(-t * 90) * 0.25


# C major: I – V – vi – IV, then a lift to IV – V – I – I for the middle part.
CHORDS = {"C": [60, 64, 67], "G": [55, 59, 62], "Am": [57, 60, 64], "F": [53, 57, 60], "Dm": [50, 53, 57]}
ROOT = {"C": 36, "G": 43, "Am": 45, "F": 41, "Dm": 38}
VERSE = ["C", "G", "Am", "F"]
LIFT = ["F", "G", "C", "Am", "Dm", "G", "C", "C"]
# Melody shapes (scale-step offsets on top of the chord's top tone), one per bar position.
SHAPES = [[0, 2, 4, 2, 7, 4, 2, 4], [0, 4, 7, 4, 9, 7, 4, 2], [0, 2, 0, 4, 2, 7, 4, 2], [4, 2, 0, 2, 4, 7, 9, 7]]
SCALE = [0, 2, 4, 5, 7, 9, 11]


def degree_to_midi(base, steps):
    """Move `steps` scale degrees (in semitone list terms) up from base, staying in C major."""
    pc = [p for p in range(base, base + 24) if (p % 12) in SCALE]
    return pc[min(steps, len(pc) - 1)]


def render(seconds):
    total = int(seconds * SR) + SR
    mus, drm = np.zeros(total), np.zeros(total)
    bars = int(np.ceil(seconds / BAR))
    for b in range(bars):
        start = b * BAR
        section = "intro" if b < 2 else ("lift" if 18 <= b < 26 else ("outro" if b >= bars - 2 else "main"))
        chord = (LIFT[(b - 18) % len(LIFT)] if section == "lift" else VERSE[b % 4])
        place(mus, start, pad(CHORDS[chord], BAR), 0.16)
        if section != "intro":
            for q in range(4):
                place(mus, start + q * BEAT, bass(ROOT[chord], BEAT * 0.95), 0.32)
        # melody: eighth notes; sparser in intro/outro
        shape = SHAPES[b % 4]
        top = CHORDS[chord][0] + 12
        for e in range(8):
            if section in ("intro", "outro") and e % 2:
                continue
            m = degree_to_midi(top, shape[e])
            place(mus, start + e * BEAT / 2, pluck(m), 0.22 if e % 2 else 0.28)
        if section in ("main", "lift"):
            for q in range(4):
                place(drm, start + q * BEAT, kick(), 0.55)
                if q in (1, 3):
                    place(drm, start + q * BEAT, clap(), 0.18)
            for e in range(8):
                place(drm, start + e * BEAT / 2 + (0.02 if e % 2 else 0), hat(), 0.22 if e % 2 else 0.12)
    mix = mus + drm
    mix = mix[: int(seconds * SR)]
    # fade in / out
    fi, fo = int(0.8 * SR), int(3.0 * SR)
    mix[:fi] *= np.linspace(0, 1, fi)
    mix[-fo:] *= np.linspace(1, 0, fo)
    # gentle stereo width: slightly delayed copy of the plucks/pads on the right
    d = int(0.012 * SR)
    right = mix.copy()
    right[d:] = 0.85 * mix[d:] + 0.15 * mix[:-d]
    stereo = np.stack([mix, right], axis=1)
    stereo /= np.max(np.abs(stereo)) + 1e-9
    return (stereo * 0.8 * 32767).astype(np.int16)


if __name__ == "__main__":
    out = sys.argv[1]
    secs = float(sys.argv[2]) if len(sys.argv) > 2 else 90
    data = render(secs)
    with wave.open(out, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())
    print(f"{out}: {secs:.1f} s")
