# Audio Compare

Desktop A/B and blind ABX listening tests: start from a lossless track, encode it locally, and switch instantly between the original and a compressed version.

v1 compares **FLAC/WAV** against **MP3 (LAME)** at 320 / 192 / 128 kbps and **Opus** at 128 / 96 / 64 kbps. Both sides are decoded to the same PCM format before playback so you are hearing codec artifacts, not player or container differences.

## Requirements

- Node.js 20+
- Rust (stable)
- **ffmpeg** with `libmp3lame` and `libopus`

The app does not bundle ffmpeg (license and size). It looks on `PATH`, then common install locations.

### Install ffmpeg

**macOS (Homebrew)**

```bash
brew install ffmpeg
```

**Windows (Chocolatey)**

```bash
choco install ffmpeg
```

**Debian / Ubuntu**

```bash
sudo apt install ffmpeg
```

Confirm the encoders exist:

```bash
ffmpeg -hide_banner -encoders | grep -E 'libmp3lame|libopus'
```

## Run

```bash
npm install
npm run tauri dev
```

Release build:

```bash
npm run tauri build
```

## How a session works

1. Pick a bundled diagnostic track or import your own FLAC/WAV.
2. Choose codec, bitrate, and **Open A/B** or **Blind ABX**.
3. Both files decode to PCM at the output device sample rate. Switching A/B/X keeps the same playhead.

**Open A/B** — A is lossless, B is the encode. Toggle freely.

**Blind ABX** — A and B are the two files. X is randomly A or B. Say whether X is A or B. After N trials the app shows *k* correct of *N* and a one-sided binomial p-value against chance.

Keyboard: `A` `B` `X` switch, Space play/pause, `1`/`2` vote, arrows seek.

## Cache and history

Encoded files are cached under the OS app-data directory, keyed by source hash + codec + bitrate. They are not re-encoded on every listen.

- macOS: `~/Library/Application Support/com.kolim.audiocompare/`
- Windows: `%APPDATA%\com.kolim.audiocompare\`
- Linux: `~/.local/share/com.kolim.audiocompare/`

`history.json` stores completed sessions. `library.json` remembers imported paths (the audio files themselves stay where you left them).

## Bundled tracks

`assets/tracks/` includes:

- **Bach, Goldberg Aria and Variatio 1** — Kimiko Ishizaka, Open Goldberg Variations, 24-bit/96 kHz, **CC0**
- **Beethoven, Op. 18 No. 6, I** — Musopen String Quartet, 24-bit/48 kHz, **public domain** (2012 Kickstarter)
- **NJHB, Checking For Traps** (2:30 excerpt) — jazz combo, **CC BY 4.0**
- **Jahzzar, Missing You** — indie/synth pop, **CC BY-SA**
- Short generated diagnostics (transients, harmonic study, dense mix) for isolating pre-echo and smearing

See `assets/tracks/LICENSE` for sources. Import your own FLAC/WAV for anything else.

Regenerate only the synthetic diagnostics:

```bash
python3 scripts/generate_tracks.py
```

## Out of v1

Threshold / staircase detection, exclusive (bit-perfect) output, AAC, mobile, and web.
