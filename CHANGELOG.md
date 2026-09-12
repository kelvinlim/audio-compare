# Changelog

## 0.4.0 — 2026-09-12

- Time-align A and B before Δ RMS and playback so codec encoder/decoder delay does not inflate the residual or jump the playhead on A↔B switches
- Show estimated lag (samples and milliseconds) plus aligned vs unaligned Δ RMS on the player

## 0.3.3 — 2026-09-09

- Show the Tauri runtime app version in the header and About page so packaged builds cannot display a stale bake-time string (v0.3.2 Linux packages still showed v0.3.1)
- Fail the frontend build if the JS bundle is missing the `package.json` version

## 0.3.2 — 2026-09-09

- Publish Linux aarch64 packages (`.deb`, AppImage, `.rpm`) alongside the existing macOS, Windows, and Linux x86_64 builds

## 0.3.1 — 2026-09-06

- Install the bundled ffmpeg sidecar as `audio-compare-ffmpeg` so Linux `.deb`/`.rpm` packages do not overwrite `/usr/bin/ffmpeg`

## 0.3.0 — 2026-09-06

- Tab cycles A/B in open mode and A/B/X in blind mode
- Show the app version in the header
- About page with the GitHub repo link and this changelog
- History lists only completed ABX sessions, with date/time and correct/total

## 0.2.1 — 2026-09-06

- Sign the macOS app with Developer ID Application
- Notarize and staple the DMG so Gatekeeper can open it without a right-click workaround

## 0.2.0 — 2026-09-05

- Bundle ffmpeg in the app so a system install is not required
- Add 96 kbps MP3
- List more output devices on macOS, including built-in speakers

## 0.1.0 — 2026-09-05

- First desktop release: open A/B and blind ABX listening tests
- MP3 (LAME) and Opus encodes from FLAC/WAV
- Bundled open-licensed tracks plus import of your own files
