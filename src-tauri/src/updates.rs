//! Auto-update from GitHub Releases. Aura asks the latest release's latest.json whether a newer
//! version exists; the installer it downloads must be signed with Aura's updater key
//! (the public half is in tauri.conf.json), so only builds you made can be installed.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The update found by the last check, kept until you click Update.
#[derive(Default)]
pub struct Pending(pub tokio::sync::Mutex<Option<Update>>);

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Value, String> {
    let current = app.package_info().version.to_string();
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    log::info!("aura: update check: running {current}, latest {}", update.as_ref().map(|u| u.version.as_str()).unwrap_or("(same)"));
    let found = update.as_ref().map(|u| json!({ "version": u.version, "notes": u.body, "current": current }));
    *app.state::<Pending>().0.lock().await = update;
    Ok(found.unwrap_or(json!({ "version": null, "current": current })))
}

/// Downloads, verifies and installs the pending update, then restarts Aura.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let update = app.state::<Pending>().0.lock().await.take().ok_or("no update to install")?;
    log::info!("aura: installing update {}", update.version);
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    // a restart skips Aura's normal exit, so close the Edge player here or it's left behind
    if let Some(mut child) = app.state::<crate::App>().edge.lock().unwrap().take() {
        crate::edge::stop(&mut child);
    }
    crate::edge::close_leftovers();
    crate::offline::flush();
    app.restart();
}
