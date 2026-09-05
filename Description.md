I've always been interested how much I am able to detect the effect of compression approaches on audio tracks.

The purpose of this app is to start with a lossless track and be able to A/B comparisons between lossless and different compression levels/algorithms 

Current idea is that I can use my usb-c connected Bose QC Ultra headphones with direct DAC access,playing through my macbook

The A/B comparisons can be set to either blind or open 

Want to do a a valid blind comparison so could have multiple choices of comparison

Different modes 

1.  Threshold detection - what level is the listener unable to distinguish between levels of compression and FLAC

Platforms

1. Start with desktop (mac, windows, linux) but have ability to also build for mobile and for full web app in the future


Tracks

1. Need to identify open access tracks to avoid copyright issues

2. Variety of music types - classical, etc. 


Questions

1. what type of compressions to compare that have open implmentation

2. code implementation to cover the multiple target platforms


Some notes from gemini about mac

Building a dedicated macOS A/B or ABX tool for evaluating audio compression artifacts (e.g., lossless reference vs. 320 kbps MP3 vs. 256/128 kbps AAC) is an excellent project. The human auditory system has remarkably short sensory echoic memory (under 2 seconds), so how the audio engine handles switching, alignment, and level calibration will make or break your ability to hear subtle compression artifacts.

### Core Audio Architecture & Playback Pipeline

**1. Avoid High-Level Media Players**
Do not use `AVPlayer` or standard multi-instance playback loops. They introduce non-deterministic buffering latency, making synchronized switching impossible.

**2. The Dual-Player AVAudioEngine or Custom Render Graph**
The most responsive architecture on macOS uses **`AVAudioEngine`** with two `AVAudioPlayerNode` instances (or a single custom audio unit / render callback reading from RAM buffers):

* **Synchronous Start:** Schedule both decoded buffers into memory (`AVAudioPCMBuffer`). Start both `AVAudioPlayerNode` instances with the exact same host render timestamp (`node.play(at: renderTime)`) so they play in exact sample lock.
* **Volume/Bus Muting Instead of Transport Pausing:** Keep both streams running continuously in the background. When the user toggles between A and B, crossfade the mixer bus volumes rather than pausing and seeking.
* **Micro-Crossfade (Anti-Clicking):** Instant hard cuts produce high-frequency transient clicks (due to non-zero-crossing phase jumps) that mask subtle compression artifacts and create false positive differences. Use a **2 ms to 5 ms equal-power crossfade** on volume changes to keep switching seamless.

---

### Critical Engineering Requirements for Compression A/B

**Sample-Accurate Time Alignment (Encoder Padding & Delay)**
Lossy encoders (like MP3 or AAC) introduce priming delay (padding samples at the start, often 576–2112 samples) and trailing padding.

* If you simply line up the start of the decoded MP3/AAC file against the source WAV/FLAC, they will be out of phase by several milliseconds.
* *Fix:* Compute cross-correlation across the onset samples or parse the container's encoder delay atom (`iTunSMPB` in M4A/AAC) to discard prepended delay samples before playback so both streams align down to the individual sample.

**LUFS / RMS Loudness Normalization**
Psychoacoustically, louder almost always sounds "better" or "more open." Lossy encoding (especially at lower bitrates) clips peaks or slightly shifts perceived RMS energy.

* Integrate an EBU R128 loudness analysis pass (integrated LUFS) or True-Peak normalization when loading tracks.
* Match loudness within **±0.05 dB** before initiating the trial.

**Short-Segment Looping & Memory Buffers**
Trained listeners pinpoint compression artifacts (swishy cymbals, pre-echo on sharp drum transients, collapsed stereo width) within very specific 1- to 3-second windows.

* Implement seamless loop points with keyboard shortcuts (e.g., Space to Play/Pause, `1`/`2` or `A`/`B` to hot-swap, `[` and `]` to nudge loop bounds).
* Pre-decode the target loop slices directly into uncompressed 32-bit float memory arrays to eliminate disk I/O jitter.

**Bit-Perfect macOS Output Handling**
macOS Core Audio defaults to the sample rate selected in *Audio MIDI Setup* and will transparently resample streams that do not match.

* Ensure your engine queries the active output device format (`kAudioDevicePropertyStreamFormat`) and conforms the decoded pipeline appropriately, or match the device's native rate to prevent OS-level resampling from smoothing out or adding high-frequency distortion.

---

### Recommended Tooling & Stack

* **Language/Framework:** Swift + SwiftUI for the interface; `AVAudioEngine` for high-level audio routing, or a pure C/Swift `AURenderCallback` if you want zero-overhead buffer swapping.
* **Decoding:** `ExtAudioFile` or `AVAudioFile` for reading WAV/AIFF/FLAC/AAC natively into memory.
* **Evaluation Protocol:** Include a double-blind **ABX mode** with automated p-value/binomial confidence calculation (e.g., 16 trials; at least 12/16 correct to achieve $p < 0.05$ statistical significance).

Are you building the UI in native SwiftUI/AppKit, and would you like a sample Swift implementation of the synchronized dual-player node architecture?