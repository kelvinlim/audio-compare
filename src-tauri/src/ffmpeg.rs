use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegStatus {
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub has_lame: bool,
    pub has_opus: bool,
}

pub fn find_ffmpeg() -> Option<PathBuf> {
    if let Ok(path) = which::which("ffmpeg") {
        return Some(path);
    }
    const CANDIDATES: &[&str] = &[
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
        "C:\\ffmpeg\\bin\\ffmpeg.exe",
    ];
    CANDIDATES
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
}

pub fn probe_status() -> FfmpegStatus {
    let Some(path) = find_ffmpeg() else {
        return FfmpegStatus {
            available: false,
            path: None,
            version: None,
            has_lame: false,
            has_opus: false,
        };
    };

    let version = Command::new(&path)
        .arg("-version")
        .output()
        .ok()
        .and_then(|out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .map(|line| line.trim().to_string())
        });

    let encoders = Command::new(&path)
        .args(["-hide_banner", "-encoders"])
        .output()
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
        .unwrap_or_default();

    FfmpegStatus {
        available: true,
        path: Some(path.display().to_string()),
        version,
        has_lame: encoders.contains("libmp3lame"),
        has_opus: encoders.contains("libopus"),
    }
}

pub fn require_ffmpeg() -> AppResult<PathBuf> {
    find_ffmpeg().ok_or(AppError::FfmpegMissing)
}

pub fn encode_lossy(
    ffmpeg: &Path,
    source: &Path,
    dest: &Path,
    codec: &str,
    bitrate_kbps: u32,
) -> AppResult<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let bitrate = format!("{bitrate_kbps}k");
    let (encoder, extra): (&str, Vec<&str>) = match codec {
        "mp3" => ("libmp3lame", vec!["-write_xing", "1"]),
        "opus" => ("libopus", vec!["-application", "audio", "-vbr", "on"]),
        other => return Err(AppError::msg(format!("unsupported codec: {other}"))),
    };

    let mut command = Command::new(ffmpeg);
    command
        .args(["-y", "-hide_banner", "-loglevel", "error"])
        .arg("-i")
        .arg(source)
        .args(["-vn", "-map", "0:a:0", "-c:a", encoder, "-b:a", &bitrate]);
    command.args(extra);
    command.arg(dest);

    let output = command.output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::msg(format!("ffmpeg encode failed: {stderr}")));
    }
    Ok(())
}

pub fn decode_pcm_f32(ffmpeg: &Path, source: &Path, sample_rate: u32) -> AppResult<Vec<f32>> {
    let output = Command::new(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error"])
        .arg("-i")
        .arg(source)
        .args([
            "-vn",
            "-ac",
            "2",
            "-ar",
            &sample_rate.to_string(),
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::msg(format!("ffmpeg decode failed: {stderr}")));
    }

    let bytes = output.stdout;
    if bytes.len() % 4 != 0 {
        return Err(AppError::msg("decoded PCM length is not aligned to f32"));
    }

    let mut samples = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        samples.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Ok(samples)
}

pub fn probe_duration(ffmpeg: &Path, source: &Path) -> Option<f64> {
    let output = Command::new(ffmpeg)
        .args(["-hide_banner", "-i"])
        .arg(source)
        .output()
        .ok()?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    parse_duration_from_ffmpeg(&text)
}

fn parse_duration_from_ffmpeg(text: &str) -> Option<f64> {
    let marker = "Duration: ";
    let start = text.find(marker)? + marker.len();
    let clock = text[start..].split(',').next()?.trim();
    let mut parts = clock.split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

#[cfg(test)]
mod tests {
    use super::parse_duration_from_ffmpeg;

    #[test]
    fn parses_duration_line() {
        let text = "  Duration: 00:02:15.12, start: 0.000000, bitrate: 1411 kb/s";
        let seconds = parse_duration_from_ffmpeg(text).unwrap();
        assert!((seconds - 135.12).abs() < 0.001);
    }

    #[test]
    fn encode_and_decode_if_ffmpeg_present() {
        let Some(ffmpeg) = super::find_ffmpeg() else {
            return;
        };
        let source = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../assets/tracks/transients.flac");
        if !source.exists() {
            return;
        }
        let dir = std::env::temp_dir().join("audio-compare-encode-test");
        let _ = std::fs::create_dir_all(&dir);
        let mp3 = dir.join("transients-128.mp3");
        let opus = dir.join("transients-64.opus");
        super::encode_lossy(&ffmpeg, &source, &mp3, "mp3", 128).expect("mp3 encode");
        super::encode_lossy(&ffmpeg, &source, &opus, "opus", 64).expect("opus encode");
        let pcm_a = super::decode_pcm_f32(&ffmpeg, &source, 48_000).expect("flac decode");
        let pcm_b = super::decode_pcm_f32(&ffmpeg, &mp3, 48_000).expect("mp3 decode");
        let pcm_c = super::decode_pcm_f32(&ffmpeg, &opus, 48_000).expect("opus decode");
        assert!(pcm_a.len() > 48_000);
        assert!((pcm_a.len() as i64 - pcm_b.len() as i64).abs() < 48_000);
        assert!((pcm_a.len() as i64 - pcm_c.len() as i64).abs() < 48_000);
    }
}
