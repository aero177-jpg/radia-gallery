use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

const FILE_OPEN_EVENT: &str = "radia://open-files";

struct PendingFilePaths(Mutex<Vec<String>>);

#[derive(Clone, Serialize)]
struct FileOpenPayload {
    paths: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SplatFileInfo {
    name: String,
    size: u64,
    last_modified: u64,
}

fn supported_splat_path(value: impl AsRef<Path>) -> Option<PathBuf> {
    let path = value.as_ref();
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    if !matches!(extension.as_str(), "ply" | "sog") {
        return None;
    }

    path.canonicalize().ok().filter(|candidate| candidate.is_file())
}

fn paths_from_arguments(arguments: &[String]) -> Vec<String> {
    arguments
        .iter()
        .skip(1)
        .filter_map(supported_splat_path)
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

fn queue_paths(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }

    if let Ok(mut pending) = app.state::<PendingFilePaths>().0.lock() {
        pending.extend(paths);
    }
}

fn emit_open_paths(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }

    let _ = app.emit(FILE_OPEN_EVENT, FileOpenPayload { paths });
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn get_splat_file_info(path: String) -> Result<SplatFileInfo, String> {
    let path = supported_splat_path(path)
        .ok_or_else(|| "The selected file is missing or is not a supported .ply/.sog splat.".to_owned())?;
    let metadata = std::fs::metadata(&path)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
    let last_modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default();

    Ok(SplatFileInfo {
        name: path.file_name().and_then(|name| name.to_str()).unwrap_or("splat").to_owned(),
        size: metadata.len(),
        last_modified,
    })
}

#[tauri::command]
fn take_startup_file_paths(pending_paths: State<'_, PendingFilePaths>) -> Vec<String> {
    let Ok(mut pending) = pending_paths.0.lock() else {
        return Vec::new();
    };
    std::mem::take(&mut *pending)
}

pub fn run() {
    let initial_paths = paths_from_arguments(&std::env::args().collect::<Vec<_>>());

    tauri::Builder::default()
        .manage(PendingFilePaths(Mutex::new(initial_paths)))
        .plugin(tauri_plugin_single_instance::init(|app, arguments, _working_directory| {
            emit_open_paths(app, paths_from_arguments(&arguments));
        }))
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_splat_file_info, take_startup_file_paths])
        .run(tauri::generate_context!())
        .expect("error while running Radia");
}