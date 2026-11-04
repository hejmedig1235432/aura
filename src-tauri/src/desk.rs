//! Live layer on the desktop: lyrics and play controls drawn on top of the song wallpaper.
//! A full-screen, see-through window that always stays at the bottom (only visible on the
//! desktop). Clicks pass through to the desktop everywhere except over the controls: a small
//! thread watches the cursor and only catches clicks while it's on the controls area.

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// The controls area in physical screen pixels (x, y, width, height), set by the page.
static HOT: [AtomicI32; 4] = [AtomicI32::new(0), AtomicI32::new(0), AtomicI32::new(0), AtomicI32::new(0)];
static WATCHING: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub async fn toggle_desk(app: AppHandle, show: bool) -> Result<(), String> {
    if !show {
        if let Some(w) = app.get_webview_window("desk") {
            w.close().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    if app.get_webview_window("desk").is_some() {
        return Ok(());
    }
    let m = app.primary_monitor().ok().flatten().ok_or("no monitor found")?;
    let scale = m.scale_factor();
    let (w, h) = (m.size().width as f64 / scale, m.size().height as f64 / scale);
    let (x, y) = (m.position().x as f64 / scale, m.position().y as f64 / scale);
    let win = WebviewWindowBuilder::new(&app, "desk", WebviewUrl::App("desk.html".into()))
        .title("Aura desktop")
        .position(x, y)
        .inner_size(w, h)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_bottom(true)
        .focused(false)
        .shadow(false)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = win.set_ignore_cursor_events(true);
    hide_from_alt_tab(&win);
    watch_cursor(app);
    Ok(())
}

/// The page tells us where its controls are, in physical screen pixels.
#[tauri::command]
pub fn desk_hot(x: i32, y: i32, w: i32, h: i32) {
    for (slot, v) in HOT.iter().zip([x, y, w, h]) {
        slot.store(v, Ordering::Relaxed);
    }
}

/// Catch clicks only while the cursor is over the controls; everywhere else they go to the desktop.
fn watch_cursor(app: AppHandle) {
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut catching = false;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(60));
            let Some(win) = app.get_webview_window("desk") else { break };
            let mut p = POINT { x: 0, y: 0 };
            unsafe { GetCursorPos(&mut p) };
            let [x, y, w, h] = [0, 1, 2, 3].map(|i| HOT[i].load(Ordering::Relaxed));
            let inside = w > 0 && p.x >= x && p.x < x + w && p.y >= y && p.y < y + h;
            if inside != catching {
                catching = inside;
                let _ = win.set_ignore_cursor_events(!inside);
            }
        }
        WATCHING.store(false, Ordering::SeqCst);
    });
}

/// A tool window doesn't show up in Alt+Tab.
fn hide_from_alt_tab(win: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW};
    if let Ok(hwnd) = win.hwnd() {
        let hwnd = hwnd.0 as _;
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex | WS_EX_TOOLWINDOW as isize) & !(WS_EX_APPWINDOW as isize));
        }
    }
}
