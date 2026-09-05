use crate::error::{AppError, AppResult};
use crate::ffmpeg;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
#[allow(unused_imports)]
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub title: String,
    pub path: String,
    pub source: TrackSource,
    pub genre: Option<String>,
    pub license: Option<String>,
    pub duration_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TrackSource {
    Bundled,
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestTrack {
    id: String,
    title: String,
    file: String,
    genre: Option<String>,
    license: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub bundled: Vec<Track>,
    pub user: Vec<Track>,
}

pub fn bundled_tracks_dir(app: &AppHandle) -> PathBuf {
    let mut candidates = vec![
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../assets/tracks"),
        PathBuf::from("assets/tracks"),
    ];
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("assets/tracks"));
        candidates.push(cwd.join("../assets/tracks"));
    }
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("tracks"));
    }
    candidates
        .into_iter()
        .find(|path| path.join("manifest.json").is_file())
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../assets/tracks"))
}

pub fn user_library_path(data_dir: &Path) -> PathBuf {
    data_dir.join("library.json")
}

pub fn load_library(app: &AppHandle, data_dir: &Path, ffmpeg: Option<&Path>) -> AppResult<Library> {
    Ok(Library {
        bundled: load_bundled(app, ffmpeg)?,
        user: load_user(data_dir)?,
    })
}

fn load_bundled(app: &AppHandle, _ffmpeg: Option<&Path>) -> AppResult<Vec<Track>> {
    let dir = bundled_tracks_dir(app);
    let manifest_path = dir.join("manifest.json");
    if !manifest_path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&manifest_path)?;
    let entries: Vec<ManifestTrack> = serde_json::from_str(&raw)?;
    let mut tracks = Vec::new();
    for entry in entries {
        let path = dir.join(&entry.file);
        if !path.exists() {
            continue;
        }
        tracks.push(Track {
            id: format!("bundled:{}", entry.id),
            title: entry.title,
            path: path.to_string_lossy().into_owned(),
            source: TrackSource::Bundled,
            genre: entry.genre,
            license: entry.license,
            duration_seconds: None,
        });
    }
    Ok(tracks)
}

fn load_user(data_dir: &Path) -> AppResult<Vec<Track>> {
    let path = user_library_path(data_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(path)?;
    let tracks: Vec<Track> = serde_json::from_str(&raw)?;
    Ok(tracks
        .into_iter()
        .filter(|track| Path::new(&track.path).exists())
        .collect())
}

fn save_user(data_dir: &Path, tracks: &[Track]) -> AppResult<()> {
    std::fs::create_dir_all(data_dir)?;
    let path = user_library_path(data_dir);
    let raw = serde_json::to_string_pretty(tracks)?;
    std::fs::write(path, raw)?;
    Ok(())
}

pub fn import_user_track(
    data_dir: &Path,
    file_path: &Path,
    ffmpeg: Option<&Path>,
) -> AppResult<Track> {
    if !file_path.exists() {
        return Err(AppError::msg("file does not exist"));
    }
    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(ext.as_str(), "flac" | "wav" | "aiff" | "aif") {
        return Err(AppError::msg(
            "please import a lossless file (FLAC, WAV, or AIFF)",
        ));
    }

    let title = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .to_string();
    let duration = ffmpeg.and_then(|bin| ffmpeg::probe_duration(bin, file_path));
    let id = format!("user:{}", uuid::Uuid::new_v4());
    let track = Track {
        id,
        title,
        path: file_path.to_string_lossy().into_owned(),
        source: TrackSource::User,
        genre: None,
        license: Some("User provided".into()),
        duration_seconds: duration,
    };

    let mut existing = load_user(data_dir)?;
    if let Some(index) = existing.iter().position(|item| item.path == track.path) {
        let updated = Track {
            id: existing[index].id.clone(),
            ..track
        };
        existing[index] = updated.clone();
        save_user(data_dir, &existing)?;
        return Ok(updated);
    }
    existing.push(track.clone());
    save_user(data_dir, &existing)?;
    Ok(track)
}

pub fn find_track(app: &AppHandle, data_dir: &Path, id: &str) -> AppResult<Track> {
    let library = load_library(app, data_dir, None)?;
    library
        .bundled
        .into_iter()
        .chain(library.user)
        .find(|track| track.id == id)
        .ok_or_else(|| AppError::msg("track not found"))
}
