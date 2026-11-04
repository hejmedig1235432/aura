//! Global hotkeys (work in any app, even games) and the "now playing" overlay they show.
//! A hotkey sends its action to the main window, which does the work and then asks for the
//! overlay with the result.

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

/// Ctrl+Alt + key. Ctrl+Alt+P is the fallback for play/pause when another app owns Ctrl+Alt+Space.
pub const KEYS: [(Code, &str); 7] = [
    (Code::Space, "toggle"),
    (Code::KeyP, "toggle"),
    (Code::ArrowRight, "next"),
    (Code::ArrowLeft, "prev"),
    (Code::ArrowUp, "volup"),
    (Code::ArrowDown, "voldown"),
    (Code::KeyL, "like"),
];

pub fn shortcuts() -> Vec<Shortcut> {
    KEYS.iter().map(|(code, _)| Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), *code)).collect()
}

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            if let Some((_, action)) = KEYS.iter().find(|(code, _)| shortcut.key == *code) {
                log::info!("aura: hotkey pressed: {action}");
                let _ = app.emit_to("main", "aura-hotkey", *action);
            }
        })
        .build()
}

/// The overlay: a small click-through, always-on-top card at the top of the screen.
/// It's created once and stays transparent; its page fades the card in and out.
fn overlay(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(w) = app.get_webview_window("overlay") {
        return Ok(w);
    }
    let size = (420.0, 112.0);
    let mut b = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title("Aura overlay")
        .inner_size(size.0, size.1)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .shadow(false);
    if let Some(m) = app.primary_monitor().ok().flatten() {
        let s = m.scale_factor();
        let w = m.size().width as f64 / s;
        b = b.position((w - size.0) / 2.0, 18.0);
    }
    let w = b.build().map_err(|e| e.to_string())?;
    let _ = w.set_ignore_cursor_events(true); // clicks go straight through to the game
    Ok(w)
}

/// Shows the overlay with the given now-playing payload. Async on purpose: creating a window
/// from a synchronous command can deadlock on Windows.
#[tauri::command]
pub async fn show_overlay(app: AppHandle, payload: serde_json::Value) -> Result<(), String> {
    let fresh = app.get_webview_window("overlay").is_none();
    let w = overlay(&app)?;
    let _ = w.set_always_on_top(true); // re-assert above games that grabbed the top spot
    if fresh {
        // give the new page a moment to load before it gets the first message
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(700));
            let _ = app.emit_to("overlay", "aura-overlay", payload);
        });
    } else {
        let _ = app.emit_to("overlay", "aura-overlay", payload);
    }
    Ok(())
}
