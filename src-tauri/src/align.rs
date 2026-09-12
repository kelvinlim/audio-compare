//! Bounded-lag time alignment for stereo PCM A/B buffers.
//!
//! Lossy codecs add a roughly constant encoder/decoder delay (LAME priming,
//! Opus lookahead, leftover Xing `skip_samples`). We estimate that delay with
//! normalized cross-correlation over a mid-clip window, then trim one side so
//! playback shares a single playhead.
//!
//! Search is bounded by [`MAX_LAG_MS`]. Complexity is independent of track
//! length except for a linear stereo→mid downmix. NCC is full-rate over a
//! mid-clip window of [`ANALYSIS_WINDOW_MS`]: O(L·W) multiply-adds, about
//! 2×10⁸ at 48 kHz (L = 100 ms, W = 400 ms) — milliseconds in release.

use serde::Serialize;

pub const CHANNELS: usize = 2;

/// Maximum relative delay considered, in milliseconds.
pub const MAX_LAG_MS: u32 = 100;

/// Mid-clip analysis window for NCC, in milliseconds.
const ANALYSIS_WINDOW_MS: u32 = 400;

const MIN_WINDOW_FRAMES: usize = 256;

/// `lag_frames > 0` means B is delayed relative to A: `A[t] ≈ B[t + lag]`
/// before trimming (typical encoder delay).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LagEstimate {
    pub lag_frames: i32,
    pub lag_ms: f64,
}

pub fn max_lag_frames(sample_rate: u32) -> usize {
    let rate = u64::from(sample_rate.max(1));
    (rate * u64::from(MAX_LAG_MS) / 1000) as usize
}

fn analysis_window_frames(sample_rate: u32) -> usize {
    let rate = u64::from(sample_rate.max(1));
    (rate * u64::from(ANALYSIS_WINDOW_MS) / 1000) as usize
}

/// Downmix interleaved stereo to mid (`(L+R)/2`). Trailing odd samples are dropped.
fn downmix_mid(interleaved: &[f32]) -> Vec<f32> {
    let frames = interleaved.len() / CHANNELS;
    let mut mono = Vec::with_capacity(frames);
    for frame in interleaved.chunks_exact(CHANNELS) {
        mono.push((frame[0] + frame[1]) * 0.5);
    }
    mono
}

fn ncc(a: &[f32], b: &[f32]) -> f64 {
    let n = a.len().min(b.len());
    if n == 0 {
        return 0.0;
    }
    let mut dot = 0.0_f64;
    let mut energy_a = 0.0_f64;
    let mut energy_b = 0.0_f64;
    for i in 0..n {
        let av = f64::from(a[i]);
        let bv = f64::from(b[i]);
        dot += av * bv;
        energy_a += av * av;
        energy_b += bv * bv;
    }
    let denom = (energy_a * energy_b).sqrt();
    if denom < 1e-20 {
        0.0
    } else {
        dot / denom
    }
}

fn ncc_at(a: &[f32], b: &[f32], start: usize, window: usize, lag: i32) -> f64 {
    let b_start = start as i32 + lag;
    if start + window > a.len() || b_start < 0 {
        return 0.0;
    }
    let b_start = b_start as usize;
    if b_start + window > b.len() {
        return 0.0;
    }
    ncc(&a[start..start + window], &b[b_start..b_start + window])
}

fn is_better(score: f64, lag: i32, best_score: f64, best_lag: i32) -> bool {
    if !score.is_finite() {
        return false;
    }
    if score > best_score + 1e-12 {
        return true;
    }
    (score - best_score).abs() <= 1e-12 && lag.abs() < best_lag.abs()
}

struct SearchParams {
    max_lag: usize,
    window: usize,
    start: usize,
}

fn search_params(n: usize, sample_rate: u32) -> Option<SearchParams> {
    if n < MIN_WINDOW_FRAMES {
        return None;
    }
    let named = max_lag_frames(sample_rate).max(1);
    let mut max_lag = named.min(n / 4).max(1);
    let mut window = analysis_window_frames(sample_rate).min(n.saturating_sub(2 * max_lag));
    if window < MIN_WINDOW_FRAMES {
        if n <= MIN_WINDOW_FRAMES {
            return None;
        }
        max_lag = ((n - MIN_WINDOW_FRAMES) / 2).min(named).max(1);
        window = n.saturating_sub(2 * max_lag);
    }
    if window < 32 || 2 * max_lag + window > n {
        return None;
    }
    let start = max_lag + (n - 2 * max_lag - window) / 2;
    Some(SearchParams {
        max_lag,
        window,
        start,
    })
}

fn estimate_lag_frames(a: &[f32], b: &[f32], sample_rate: u32) -> i32 {
    let n = a.len().min(b.len());
    let Some(params) = search_params(n, sample_rate) else {
        return 0;
    };
    let SearchParams {
        max_lag,
        window,
        start,
    } = params;
    let max_lag_i = max_lag as i32;

    let a_win = &a[start..start + window];
    let energy_a = a_win
        .iter()
        .map(|s| f64::from(*s) * f64::from(*s))
        .sum::<f64>();
    let mut best_lag = 0_i32;
    let mut best_score = ncc_at(a, b, start, window, 0);
    for lag in -max_lag_i..=max_lag_i {
        if lag == 0 {
            continue;
        }
        let b_start = (start as i32 + lag) as usize;
        let score = ncc_precomputed_a(a_win, &b[b_start..b_start + window], energy_a);
        if is_better(score, lag, best_score, best_lag) {
            best_score = score;
            best_lag = lag;
        }
    }

    best_lag.clamp(-max_lag_i, max_lag_i)
}

fn ncc_precomputed_a(a: &[f32], b: &[f32], energy_a: f64) -> f64 {
    let n = a.len().min(b.len());
    if n == 0 || energy_a < 1e-20 {
        return 0.0;
    }
    let mut dot = 0.0_f64;
    let mut energy_b = 0.0_f64;
    for i in 0..n {
        let bv = f64::from(b[i]);
        dot += f64::from(a[i]) * bv;
        energy_b += bv * bv;
    }
    let denom = (energy_a * energy_b).sqrt();
    if denom < 1e-20 {
        0.0
    } else {
        dot / denom
    }
}

fn apply_frame_lag(mut a: Vec<f32>, mut b: Vec<f32>, lag_frames: i32) -> (Vec<f32>, Vec<f32>) {
    let skip_frames = lag_frames.unsigned_abs() as usize;
    if skip_frames == 0 {
        return trim_to_pairs(a, b);
    }
    let max_skip = (a.len() / CHANNELS)
        .min(b.len() / CHANNELS)
        .saturating_sub(1);
    let skip = skip_frames.min(max_skip) * CHANNELS;
    if skip == 0 {
        return trim_to_pairs(a, b);
    }
    if lag_frames > 0 {
        // B delayed: drop leading frames of B and the unmatched tail of A.
        if a.len() > skip {
            a.truncate(a.len() - skip);
        }
        if b.len() > skip {
            b.drain(0..skip);
        }
    } else {
        if a.len() > skip {
            a.drain(0..skip);
        }
        if b.len() > skip {
            b.truncate(b.len() - skip);
        }
    }
    trim_to_pairs(a, b)
}

fn trim_to_pairs(mut a: Vec<f32>, mut b: Vec<f32>) -> (Vec<f32>, Vec<f32>) {
    a.truncate(a.len() - a.len() % CHANNELS);
    b.truncate(b.len() - b.len() % CHANNELS);
    (a, b)
}

/// Estimate relative lag and trim one stereo buffer so A and B line up.
pub fn align_stereo_pair(
    a: Vec<f32>,
    b: Vec<f32>,
    sample_rate: u32,
) -> (Vec<f32>, Vec<f32>, LagEstimate) {
    let rate = sample_rate.max(1);
    let a_mono = downmix_mid(&a);
    let b_mono = downmix_mid(&b);
    let lag_frames = estimate_lag_frames(&a_mono, &b_mono, rate);
    let (a, b) = apply_frame_lag(a, b, lag_frames);
    let lag_ms = f64::from(lag_frames) * 1000.0 / f64::from(rate);
    (a, b, LagEstimate { lag_frames, lag_ms })
}

#[cfg(test)]
mod tests {
    use super::{
        align_stereo_pair, apply_frame_lag, downmix_mid, max_lag_frames, CHANNELS, MAX_LAG_MS,
    };

    const SR: u32 = 48_000;

    fn chirp_stereo(frames: usize, sr: u32) -> Vec<f32> {
        let mut out = Vec::with_capacity(frames * CHANNELS);
        for n in 0..frames {
            let t = n as f64 / f64::from(sr);
            let phase = std::f64::consts::TAU * (180.0 * t + 3_200.0 * t * t);
            let left = (phase.sin() as f32) * 0.55;
            // Distinct right channel so pairing can be checked after a shift.
            let right = ((phase * 1.17).sin() as f32) * 0.35 + 0.08 * left;
            out.push(left);
            out.push(right);
        }
        out
    }

    fn delay_leading_silence(pcm: &[f32], frames: usize) -> Vec<f32> {
        let mut out = vec![0.0_f32; frames * CHANNELS];
        out.extend_from_slice(pcm);
        out
    }

    fn diff_rms(a: &[f32], b: &[f32]) -> f64 {
        let n = a.len().min(b.len());
        if n == 0 {
            return 0.0;
        }
        let mut sum = 0.0_f64;
        for i in 0..n {
            let delta = f64::from(a[i] - b[i]);
            sum += delta * delta;
        }
        (sum / n as f64).sqrt()
    }

    #[test]
    fn identical_signals_report_zero_lag() {
        let a = chirp_stereo(SR as usize * 2, SR);
        let (aligned_a, aligned_b, lag) = align_stereo_pair(a.clone(), a, SR);
        assert_eq!(lag.lag_frames, 0);
        assert!(lag.lag_ms.abs() < 1e-9);
        assert!(diff_rms(&aligned_a, &aligned_b) < 1e-7);
    }

    #[test]
    fn recovers_positive_delay_and_near_zero_aligned_rms() {
        let source = chirp_stereo(SR as usize * 2, SR);
        let delay = 1_234; // ~25.7 ms at 48 kHz, inside the 100 ms window
        let delayed = delay_leading_silence(&source, delay);
        let unaligned = diff_rms(&source, &delayed);
        let (aligned_a, aligned_b, lag) = align_stereo_pair(source, delayed, SR);
        assert_eq!(lag.lag_frames, delay as i32);
        assert!((lag.lag_ms - 1_234.0 * 1000.0 / f64::from(SR)).abs() < 1e-6);
        assert!(unaligned > 0.05, "delay should inflate unaligned RMS");
        assert!(
            diff_rms(&aligned_a, &aligned_b) < 1e-6,
            "aligned copy should cancel"
        );
    }

    #[test]
    fn recovers_negative_delay() {
        let source = chirp_stereo(SR as usize * 2, SR);
        let delay = 800;
        let delayed_a = delay_leading_silence(&source, delay);
        let (_, _, lag) = align_stereo_pair(delayed_a, source, SR);
        assert_eq!(lag.lag_frames, -(delay as i32));
    }

    #[test]
    fn impulse_delay_is_recovered() {
        let frames = SR as usize;
        let mut source = vec![0.0_f32; frames * CHANNELS];
        let hit = frames / 2;
        source[hit * CHANNELS] = 1.0;
        source[hit * CHANNELS + 1] = 0.4;
        let delay = 3; // not a multiple of COARSE_STEP
        let delayed = delay_leading_silence(&source, delay);
        let (_, _, lag) = align_stereo_pair(source, delayed, SR);
        assert_eq!(lag.lag_frames, delay as i32);
    }

    #[test]
    fn preserves_stereo_channel_pairing() {
        let source = chirp_stereo(SR as usize * 2, SR);
        let delay = 240;
        let delayed = delay_leading_silence(&source, delay);
        let (aligned_a, aligned_b, lag) = align_stereo_pair(source.clone(), delayed, SR);
        assert_eq!(lag.lag_frames, delay as i32);
        assert_eq!(aligned_a.len() % CHANNELS, 0);
        assert_eq!(aligned_b.len() % CHANNELS, 0);
        // Mid-clip frame should still have the original L/R pair, not a channel slip.
        let frame = (aligned_a.len() / CHANNELS) / 2;
        let idx = frame * CHANNELS;
        let orig_idx = idx; // positive lag keeps A's start
        assert!((aligned_a[idx] - source[orig_idx]).abs() < 1e-6);
        assert!((aligned_a[idx + 1] - source[orig_idx + 1]).abs() < 1e-6);
        assert!((aligned_a[idx] - aligned_b[idx]).abs() < 1e-6);
        assert!((aligned_a[idx + 1] - aligned_b[idx + 1]).abs() < 1e-6);
    }

    #[test]
    fn uncorrelated_noise_stays_inside_search_window() {
        let frames = SR as usize;
        let mut a = Vec::with_capacity(frames * CHANNELS);
        let mut b = Vec::with_capacity(frames * CHANNELS);
        let mut state = 1_u64;
        for _ in 0..frames * CHANNELS {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
            a.push(((state >> 33) as f32 / (1u32 << 31) as f32) - 1.0);
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
            b.push(((state >> 33) as f32 / (1u32 << 31) as f32) - 1.0);
        }
        let max = max_lag_frames(SR) as i32;
        let (aligned_a, aligned_b, lag) = align_stereo_pair(a, b, SR);
        assert!(lag.lag_frames.abs() <= max);
        assert!(aligned_a.len() >= CHANNELS);
        assert!(aligned_b.len() >= CHANNELS);
        assert!(diff_rms(&aligned_a, &aligned_b).is_finite());
    }

    #[test]
    fn delay_beyond_window_does_not_invent_out_of_range_lag() {
        let source = chirp_stereo(SR as usize * 2, SR);
        let delay = max_lag_frames(SR) + 3_000; // ~160 ms at 48 kHz
        let delayed = delay_leading_silence(&source, delay);
        let (_, _, lag) = align_stereo_pair(source, delayed, SR);
        let max = max_lag_frames(SR) as i32;
        assert!(lag.lag_frames.abs() <= max);
    }

    #[test]
    fn empty_and_tiny_buffers_do_not_panic() {
        let (_, _, lag) = align_stereo_pair(vec![], vec![], SR);
        assert_eq!(lag.lag_frames, 0);
        let tiny = vec![0.1_f32, -0.2];
        let (_, _, lag) = align_stereo_pair(tiny.clone(), tiny, SR);
        assert_eq!(lag.lag_frames, 0);
    }

    #[test]
    fn apply_lag_trims_whole_frames_only() {
        let a = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
        let b = vec![0.0, 0.0, 1.0, 2.0, 3.0, 4.0];
        let (a, b) = apply_frame_lag(a, b, 1);
        assert_eq!(a, vec![1.0, 2.0, 3.0, 4.0]);
        assert_eq!(b, vec![1.0, 2.0, 3.0, 4.0]);
    }

    #[test]
    fn downmix_drops_odd_trailing_sample() {
        let mono = downmix_mid(&[1.0, 3.0, 5.0]);
        assert_eq!(mono, vec![2.0]);
    }

    #[test]
    fn named_lag_bound_is_100ms() {
        assert_eq!(MAX_LAG_MS, 100);
        assert_eq!(max_lag_frames(48_000), 4_800);
        assert_eq!(max_lag_frames(44_100), 4_410);
    }
}
