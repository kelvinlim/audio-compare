mod cache;
mod commands;
mod error;
mod ffmpeg;
mod history;
mod library;
mod player;
mod stats;

use player::PlayerHandle;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub player: PlayerHandle,
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub session: Mutex<Option<history::Session>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
            let cache_dir = data_dir.join("cache");
            std::fs::create_dir_all(&cache_dir)?;
            app.manage(AppState {
                player: PlayerHandle::start(),
                data_dir,
                cache_dir,
                session: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::check_ffmpeg,
            commands::list_codecs,
            commands::list_output_devices,
            commands::set_output_device,
            commands::list_library,
            commands::import_track,
            commands::prepare_comparison,
            commands::player_play,
            commands::player_pause,
            commands::player_seek,
            commands::player_set_source,
            commands::player_status,
            commands::start_session,
            commands::vote,
            commands::current_session,
            commands::list_history,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
