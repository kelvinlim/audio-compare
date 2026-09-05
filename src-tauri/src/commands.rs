use crate::cache::{cached_encode_path, file_sha256};
use crate::error::AppError;
use crate::ffmpeg::{self, FfmpegStatus};
use crate::history::{self, Session, SessionMode, SessionSummary};
use crate::library::{self, Library, Track};
use crate::player::{self, DeviceInfo, PlayerStatus, Source};
use crate::AppState;
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareProgress {
    pub stage: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareInfo {
    pub duration_seconds: f64,
    pub sample_rate: u32,
    pub cached: bool,
    pub encoded_path: String,
    pub diff_rms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodecOption {
    pub id: String,
    pub label: String,
    pub bitrates: Vec<u32>,
}

fn emit_progress(app: &AppHandle, stage: &str, message: &str) {
    let _ = app.emit(
        "prepare-progress",
        PrepareProgress {
            stage: stage.to_string(),
            message: message.to_string(),
        },
    );
}

#[tauri::command]
pub fn check_ffmpeg() -> FfmpegStatus {
    ffmpeg::probe_status()
}

#[tauri::command]
pub fn list_codecs() -> Vec<CodecOption> {
    vec![
        CodecOption {
            id: "mp3".into(),
            label: "MP3 (LAME)".into(),
            bitrates: vec![320, 192, 128, 64, 32],
        },
        CodecOption {
            id: "opus".into(),
            label: "Opus".into(),
            bitrates: vec![128, 96, 64, 32],
        },
    ]
}

#[tauri::command]
pub async fn list_output_devices() -> Result<Vec<DeviceInfo>, String> {
    tauri::async_runtime::spawn_blocking(player::list_devices_infallible)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn set_output_device(state: State<AppState>, name: Option<String>) -> Result<(), String> {
    state.player.set_device(name).map_err(Into::into)
}

#[tauri::command]
pub fn list_library(app: AppHandle, state: State<AppState>) -> Result<Library, String> {
    let ffmpeg = ffmpeg::find_ffmpeg();
    library::load_library(&app, &state.data_dir, ffmpeg.as_deref()).map_err(Into::into)
}

#[tauri::command]
pub fn import_track(app: AppHandle, state: State<AppState>, path: String) -> Result<Track, String> {
    let _ = app;
    let ffmpeg = ffmpeg::find_ffmpeg();
    library::import_user_track(&state.data_dir, &PathBuf::from(path), ffmpeg.as_deref())
        .map_err(Into::into)
}

#[tauri::command]
pub fn prepare_comparison(
    app: AppHandle,
    state: State<AppState>,
    track_id: String,
    codec: String,
    bitrate: u32,
) -> Result<PrepareInfo, String> {
    let track = library::find_track(&app, &state.data_dir, &track_id)?;
    let ffmpeg_bin = ffmpeg::require_ffmpeg()?;
    let source = PathBuf::from(&track.path);
    if !source.exists() {
        return Err(AppError::msg("source file is missing").into());
    }

    emit_progress(&app, "hash", "Fingerprinting the lossless source…");
    let hash = file_sha256(&source)?;
    let encoded_path = cached_encode_path(&state.cache_dir, &hash, &codec, bitrate);
    let cached = encoded_path.exists();

    if !cached {
        emit_progress(
            &app,
            "encode",
            &format!("Encoding {codec} {bitrate} kbps…"),
        );
        ffmpeg::encode_lossy(&ffmpeg_bin, &source, &encoded_path, &codec, bitrate)?;
    }

    let sample_rate = player::device_sample_rate(state.player.selected_device().as_deref());
    emit_progress(&app, "decode-a", "Decoding lossless reference to PCM…");
    let pcm_a = ffmpeg::decode_pcm_f32(&ffmpeg_bin, &source, sample_rate)?;
    emit_progress(&app, "decode-b", "Decoding the lossy encode to PCM…");
    let pcm_b = ffmpeg::decode_pcm_f32(&ffmpeg_bin, &encoded_path, sample_rate)?;

    if pcm_a.len() < 2 || pcm_b.len() < 2 {
        return Err(AppError::msg("decoded audio is empty").into());
    }

    let frames = (pcm_a.len().min(pcm_b.len()) / 2) as f64;
    let diff_rms = state.player.load(pcm_a, pcm_b, sample_rate)?;
    emit_progress(&app, "ready", "Ready to listen");

    Ok(PrepareInfo {
        duration_seconds: frames / sample_rate as f64,
        sample_rate,
        cached,
        encoded_path: encoded_path.to_string_lossy().into_owned(),
        diff_rms,
    })
}

#[tauri::command]
pub fn player_play(state: State<AppState>) -> Result<(), String> {
    state.player.play().map_err(Into::into)
}

#[tauri::command]
pub fn player_pause(state: State<AppState>) -> Result<(), String> {
    state.player.pause().map_err(Into::into)
}

#[tauri::command]
pub fn player_seek(state: State<AppState>, seconds: f64) -> Result<(), String> {
    state.player.seek(seconds).map_err(Into::into)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSwitch {
    pub requested: String,
    pub applied: bool,
}

#[tauri::command]
pub fn player_set_source(state: State<AppState>, source: String) -> Result<SourceSwitch, String> {
    let requested = source.to_ascii_lowercase();
    let resolved = match requested.as_str() {
        "a" => Source::A,
        "b" => Source::B,
        "x" => {
            let session = state.session.lock().map_err(|_| "session lock poisoned")?;
            history::current_x(session.as_ref().ok_or("no active session")?)
                .ok_or("no current trial")?
        }
        _ => return Err("unknown source".into()),
    };
    state.player.set_source(resolved)?;
    Ok(SourceSwitch {
        requested,
        applied: true,
    })
}

#[tauri::command]
pub fn player_status(state: State<AppState>) -> PlayerStatus {
    state.player.status()
}

#[tauri::command]
pub fn start_session(
    app: AppHandle,
    state: State<AppState>,
    track_id: String,
    codec: String,
    bitrate: u32,
    mode: SessionMode,
    trial_count: u32,
) -> Result<Session, String> {
    let track = library::find_track(&app, &state.data_dir, &track_id)?;
    let session = history::start_session(
        track.id,
        track.title,
        codec,
        bitrate,
        mode,
        trial_count,
    );
    if session.mode == SessionMode::Open {
        history::save_session(&state.data_dir, &session)?;
    }
    let mut slot = state.session.lock().map_err(|_| "session lock poisoned")?;
    *slot = Some(session.clone());
    let _ = state.player.set_source(Source::A);
    Ok(session)
}

#[tauri::command]
pub fn vote(state: State<AppState>, choice: String) -> Result<Session, String> {
    let source = match choice.as_str() {
        "a" | "A" => Source::A,
        "b" | "B" => Source::B,
        _ => return Err("vote must be A or B".into()),
    };
    let mut slot = state.session.lock().map_err(|_| "session lock poisoned")?;
    let session = slot.as_mut().ok_or("no active session")?;
    let updated = history::vote(session, source)?;
    *session = updated.clone();
    history::save_session(&state.data_dir, &updated)?;
    Ok(updated)
}

#[tauri::command]
pub fn current_session(state: State<AppState>) -> Result<Option<Session>, String> {
    let slot = state.session.lock().map_err(|_| "session lock poisoned")?;
    Ok(slot.clone())
}

#[tauri::command]
pub fn list_history(state: State<AppState>) -> Result<Vec<SessionSummary>, String> {
    let sessions = history::load_history(&state.data_dir)?;
    Ok(history::summaries(&sessions))
}
