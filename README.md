# Audio Compare

Desktop app for hearing what lossy compression does to a lossless source.

Start from FLAC or WAV, encode it locally, then switch instantly between the original and the encode. Use **open A/B** when you want labels, or **blind ABX** when you want a score.

Built with [Tauri 2](https://tauri.app/), React, and Rust. Playback is raw PCM through [cpal](https://github.com/RustAudio/cpal). Encoding and decoding go through a **bundled ffmpeg** sidecar (LAME MP3 and Opus).

## Features

- **Open A/B** — A is lossless, B is the encode. Toggle freely.
- **Blind ABX** — X is randomly A or B each trial. Vote whether X is A or B. After N trials you get *k* correct of *N* and a one-sided binomial p-value vs chance.
- **Matched playback** — both sides decode to the same PCM format at the output device rate, so you are comparing codecs, not players or containers.
- **Instant A / B / X** — same playhead, no restart.
- **Output device picker** — including system default.
- **Bundled open-licensed tracks** plus import of your own FLAC/WAV.
- **Encode cache** — a given source + codec + bitrate is encoded once.

### Codecs

| Codec | Bitrates (kbps) |
| --- | --- |
| MP3 (LAME) | 320, 192, 128, 96, 64, 32 |
| Opus | 128, 96, 64, 32 |

ffmpeg is bundled with the app (LAME MP3 and Opus). You do not need to install it separately.

## Requirements

- Node.js 20+
- Rust (stable)

A static ffmpeg sidecar is downloaded on first `tauri dev` / `tauri build` (or run `npm run prepare-ffmpeg`). The packaged app includes it.

## Run

```bash
npm install
npm run tauri dev
```

Release build:

```bash
npm run tauri build
```

The library is read from `assets/tracks/manifest.json` at startup. After adding tracks, relaunch the app.

The setup screen defaults to **Jahzzar — Missing You** vs **32 kbps MP3** in **Open A/B**. That pair makes codec damage easy to hear; step the bitrate up once you can tell A from B.

## Using a session

1. Pick a bundled track or import FLAC/WAV. First listen: Missing You, lossless vs 32 kbps MP3.
2. Choose codec, bitrate, and **Open A/B** or **Blind ABX**.
3. Play. Switch with the pads or the keyboard. The playhead stays put.

| Key | Action |
| --- | --- |
| `A` `B` `X` | Switch source (`X` in blind mode only) |
| Space | Play / pause |
| `1` / `2` | Vote X is A or B (blind) |
| ← → | Seek |

In blind mode the UI does not reveal whether X is A or B. A sounding like X on some trials is expected.

## Bundled tracks

All recordings in `assets/tracks/` are open-licensed. Full attribution is in [`assets/tracks/LICENSE`](assets/tracks/LICENSE).

| Track | Notes | License |
| --- | --- | --- |
| Bach, Goldberg Aria and Variatio 1 — Kimiko Ishizaka | Open Goldberg Variations, 24-bit / 96 kHz | CC0 |
| Beethoven, Op. 18 No. 6, I — Musopen String Quartet | 24-bit / 48 kHz | Public domain |
| NJHB, Checking For Traps (2:30 excerpt) | Jazz combo, 16-bit / 44.1 kHz | CC BY 4.0 |
| Jahzzar, Missing You | Indie / synth pop, 24-bit / 44.1 kHz | CC BY-SA |
| Transients, harmonics, dense mix | Generated diagnostics for pre-echo and smearing | CC0 |

Import your own FLAC/WAV for anything else.

Regenerate only the synthetic diagnostics:

```bash
python3 scripts/generate_tracks.py
```

## Local data

Encoded files are cached under the OS app-data directory, keyed by source hash + codec + bitrate.

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Application Support/com.kolim.audiocompare/` |
| Windows | `%APPDATA%\com.kolim.audiocompare\` |
| Linux | `~/.local/share/com.kolim.audiocompare/` |

`history.json` stores completed sessions. `library.json` remembers imported paths; the audio files stay where you left them.

## Status

v0.2, desktop (macOS, Windows, Linux). ffmpeg is bundled.

Not in this version: staircase / threshold detection, exclusive (bit-perfect) output, AAC, mobile, or web.

## License

This project is licensed under the [MIT License](LICENSE).

The packaged app includes an [FFmpeg](https://ffmpeg.org) sidecar. FFmpeg is a separate GPL-licensed program; see [`src-tauri/binaries/NOTICE`](src-tauri/binaries/NOTICE). Bundled recordings keep their own licenses (CC0, public domain, CC BY, CC BY-SA). See [`assets/tracks/LICENSE`](assets/tracks/LICENSE).
