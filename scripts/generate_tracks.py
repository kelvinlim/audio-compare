#!/usr/bin/env python3
"""Generate short CC0 diagnostic FLAC tracks for Audio Compare."""

from __future__ import annotations

import math
import struct
import subprocess
import tempfile
import wave
from pathlib import Path

SR = 48000
CHANNELS = 2
DURATION = 24.0
ROOT = Path(__file__).resolve().parents[1] / "assets" / "tracks"


def clamp(value: float) -> float:
    return max(-1.0, min(1.0, value))


def write_wav(path: Path, frames: list[tuple[float, float]]) -> None:
    with wave.open(str(path), "w") as wav:
        wav.setnchannels(CHANNELS)
        wav.setsampwidth(2)
        wav.setframerate(SR)
        packed = bytearray()
        for left, right in frames:
            packed.extend(struct.pack("<hh", int(clamp(left) * 32767), int(clamp(right) * 32767)))
        wav.writeframes(packed)


def to_flac(wav_path: Path, flac_path: Path) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(wav_path),
            "-c:a",
            "flac",
            str(flac_path),
        ],
        check=True,
    )


def env_adsr(t: float, attack: float, decay: float, sustain: float, release: float, hold: float) -> float:
    if t < 0 or t > attack + hold + release:
        return 0.0
    if t < attack:
        return t / attack if attack > 0 else 1.0
    if t < attack + hold:
        lived = t - attack
        return 1.0 - (1.0 - sustain) * min(1.0, lived / max(decay, 1e-6))
    tail = t - attack - hold
    return sustain * max(0.0, 1.0 - tail / release)


def transients() -> list[tuple[float, float]]:
    total = int(SR * DURATION)
    frames = [(0.0, 0.0)] * total
    rng = 0xC0FFEE

    def rnd() -> float:
        nonlocal rng
        rng = (1103515245 * rng + 12345) & 0x7FFFFFFF
        return rng / 0x7FFFFFFF

    events = [0.4, 1.1, 1.8, 2.9, 3.4, 4.6, 5.2, 6.8, 7.5, 8.1, 9.4, 10.2, 11.6, 12.3, 13.7, 14.8, 16.0, 17.1, 18.5, 19.2, 20.8, 21.6, 22.7]
    for start in events:
        burst = 0.035 + rnd() * 0.04
        brightness = 1800 + rnd() * 4200
        for i in range(int(burst * SR)):
            t = i / SR
            idx = int((start + t) * SR)
            if idx >= total:
                break
            click = math.exp(-t * 85.0) * math.sin(2 * math.pi * brightness * t)
            noise = (rnd() * 2 - 1) * math.exp(-t * 70.0)
            sample = 0.72 * click + 0.22 * noise
            pan = -0.35 + rnd() * 0.7
            left = sample * (1 - max(0.0, pan))
            right = sample * (1 - max(0.0, -pan))
            frames[idx] = (frames[idx][0] + left, frames[idx][1] + right)
    return frames


def harmonics() -> list[tuple[float, float]]:
    total = int(SR * DURATION)
    frames: list[tuple[float, float]] = []
    notes = [
        (0.0, 196.0, 2.4),
        (0.6, 247.0, 2.2),
        (1.3, 293.7, 2.6),
        (2.2, 392.0, 3.0),
        (3.4, 329.6, 2.4),
        (4.2, 261.6, 2.8),
        (5.5, 196.0, 2.2),
        (6.1, 311.1, 2.6),
        (7.4, 440.0, 3.2),
        (8.8, 349.2, 2.4),
        (9.6, 293.7, 2.8),
        (11.0, 220.0, 2.6),
        (12.2, 277.2, 2.4),
        (13.0, 370.0, 3.0),
        (14.6, 523.3, 2.8),
        (16.0, 392.0, 3.4),
        (17.6, 329.6, 2.6),
        (18.8, 246.9, 3.0),
        (20.4, 196.0, 3.4),
    ]
    for i in range(total):
        t = i / SR
        left = 0.0
        right = 0.0
        for start, freq, hold in notes:
            local = t - start
            amp = env_adsr(local, 0.012, 0.45, 0.22, 0.9, hold)
            if amp <= 0:
                continue
            tone = 0.0
            for harmonic, weight in enumerate((1.0, 0.55, 0.28, 0.16, 0.09, 0.05), start=1):
                tone += weight * math.sin(2 * math.pi * freq * harmonic * local)
            tone *= amp * 0.18
            spread = 0.15 if int(freq) % 2 == 0 else -0.15
            left += tone * (1 - spread)
            right += tone * (1 + spread)
        frames.append((left, right))
    return frames


def dense_mix() -> list[tuple[float, float]]:
    total = int(SR * DURATION)
    frames: list[tuple[float, float]] = []
    rng = 0x5EED

    def rnd() -> float:
        nonlocal rng
        rng = (1664525 * rng + 1013904223) & 0xFFFFFFFF
        return (rng / 0xFFFFFFFF) * 2 - 1

    for i in range(total):
        t = i / SR
        pad = (
            0.12 * math.sin(2 * math.pi * 110 * t)
            + 0.08 * math.sin(2 * math.pi * 164.8 * t + 0.3)
            + 0.06 * math.sin(2 * math.pi * 220 * t + 0.7)
            + 0.04 * math.sin(2 * math.pi * 329.6 * t + 1.1)
        )
        pad *= 0.7 + 0.3 * math.sin(2 * math.pi * 0.15 * t)
        hat = 0.0
        if int(t * 8) % 2 == 0:
            hat = rnd() * 0.09 * math.exp(-((t * 8) % 1) * 18)
        kick = 0.0
        if int(t * 2) % 2 == 0:
            local = (t * 2) % 1
            kick = math.sin(2 * math.pi * (70 - 30 * local) * local) * math.exp(-local * 8) * 0.28
        noise = rnd() * 0.03
        left = pad + kick + hat + noise
        right = pad * 0.92 + kick + hat * 0.7 + noise * 0.8
        frames.append((left, right))
    return frames


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    jobs = {
        "transients.flac": transients,
        "harmonics.flac": harmonics,
        "dense-mix.flac": dense_mix,
    }
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        for name, builder in jobs.items():
            wav_path = tmp_dir / name.replace(".flac", ".wav")
            flac_path = ROOT / name
            print(f"writing {name}")
            write_wav(wav_path, builder())
            to_flac(wav_path, flac_path)
    print(f"tracks written to {ROOT}")


if __name__ == "__main__":
    main()
