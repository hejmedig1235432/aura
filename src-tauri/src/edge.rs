//! Audio through Spotify's official Web Playback SDK, hosted in an off-screen Microsoft Edge
//! window. Aura's own WebView2 can't decrypt Spotify audio, but Edge has full Widevine.
//!
//! A tiny localhost server hands Edge the player page and the access token. Requests must
//! carry a random key from the page URL, so other local programs can't read the token.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::process::{Child, Command};

use tauri::{AppHandle, Manager};

use crate::App;

const PAGE: &str = include_str!("edge_player.html");
const PORT: u16 = 8899;

fn edge_path() -> Option<std::path::PathBuf> {
    let candidates = [
        std::env::var("ProgramFiles(x86)").ok(),
        std::env::var("ProgramFiles").ok(),
        std::env::var("LOCALAPPDATA").ok(),
    ];
    candidates
        .into_iter()
        .flatten()
        .map(|base| std::path::Path::new(&base).join("Microsoft\\Edge\\Application\\msedge.exe"))
        .find(|p| p.exists())
}

fn random_key() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
    format!("{:016x}{:016x}", h.finish(), std::process::id() as u64 ^ 0x9e37_79b9_7f4a_7c15)
}

fn query_param<'a>(path: &'a str, name: &str) -> Option<&'a str> {
    path.split_once('?')?.1.split('&').find_map(|kv| kv.strip_prefix(name)?.strip_prefix('='))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
                match hex {
                    Some(b) => { out.push(b); i += 3; }
                    None => { out.push(b'%'); i += 1; }
                }
            }
            b'+' => { out.push(b' '); i += 1; }
            b => { out.push(b); i += 1; }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn respond(stream: &mut std::net::TcpStream, status: &str, kind: &str, body: &str) {
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
}

fn serve(app: AppHandle, listener: TcpListener, key: String) {
    for stream in listener.incoming().flatten() {
        let app = app.clone();
        let key = key.clone();
        std::thread::spawn(move || {
            let mut stream = stream;
            let mut line = String::new();
            if BufReader::new(&stream).read_line(&mut line).is_err() {
                return;
            }
            let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
            let authorized = query_param(&path, "k") == Some(key.as_str());
            if !authorized {
                return respond(&mut stream, "403 Forbidden", "text/plain", "forbidden");
            }
            if path.starts_with("/token") {
                let state = app.state::<App>();
                let token = tauri::async_runtime::block_on(async { crate::access_token(&crate::spotify(&state).await).await });
                match token {
                    Ok(t) => respond(&mut stream, "200 OK", "text/plain", &t),
                    Err(e) => respond(&mut stream, "500 Internal Server Error", "text/plain", &e),
                }
            } else if path.starts_with("/state") {
                // the player's own playback state: Aura uses it instead of polling Spotify
                use tauri::Emitter;
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&percent_decode(query_param(&path, "s").unwrap_or(""))) {
                    let _ = app.emit_to("main", "edge-state", v);
                }
                respond(&mut stream, "204 No Content", "text/plain", "");
            } else if path.starts_with("/log") {
                let msg = percent_decode(query_param(&path, "m").unwrap_or(""));
                log::info!("edgeplayer: {msg}");
                use tauri::Emitter;
                let _ = app.emit("edge-player", msg); // lets Aura tell you when a song was skipped
                respond(&mut stream, "204 No Content", "text/plain", "");
            } else {
                respond(&mut stream, "200 OK", "text/html; charset=utf-8", PAGE);
            }
        });
    }
}

/// Starts the localhost page server and the off-screen Edge window. Returns the Edge process.
pub fn start(app: &AppHandle) -> Result<Child, String> {
    let edge = edge_path().ok_or("Microsoft Edge was not found")?;
    let listener = TcpListener::bind(("127.0.0.1", PORT)).map_err(|e| e.to_string())?;
    let key = random_key();
    let url = format!("http://127.0.0.1:{PORT}/?k={key}");
    {
        let app = app.clone();
        let key = key.clone();
        std::thread::spawn(move || serve(app, listener, key));
    }
    let profile = dirs::config_dir().unwrap_or_default().join("prism").join("edge-player");
    close_leftovers();
    Command::new(edge)
        .arg(format!("--app={url}"))
        .arg(format!("--user-data-dir={}", profile.display()))
        .args([
            "--window-position=-32000,-32000",
            "--window-size=320,200",
            "--autoplay-policy=no-user-gesture-required",
            "--no-first-run",
            "--no-default-browser-check",
            // An off-screen window counts as hidden; without these Edge freezes playback there.
            "--disable-features=msImplicitSignin,msEdgeSidebar,CalculateNativeWinOcclusion",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-background-timer-throttling",
            "--disable-background-media-suspend",
        ])
        .no_window()
        .spawn()
        .map_err(|e| e.to_string())
}

/// Keeps the Edge player out of the taskbar and Alt+Tab by making it a "tool window".
/// It stays open off-screen (a truly hidden window would get its playback suspended).
/// Edge can recreate its window, so this re-checks for a while after launch.
pub fn hide_from_taskbar() {
    std::thread::spawn(|| {
        for _ in 0..60 {
            unsafe { hide_once() };
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    });
}

unsafe fn hide_once() {
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    unsafe extern "system" fn visit(hwnd: HWND, _: LPARAM) -> BOOL {
        let mut buf = [0u16; 256];
        let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        let title = String::from_utf16_lossy(&buf[..len.max(0) as usize]);
        if title.starts_with("Aura player") {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let want = (ex | WS_EX_TOOLWINDOW as isize) & !(WS_EX_APPWINDOW as isize);
            if ex != want {
                // the taskbar only re-reads the style when the window is shown again
                ShowWindow(hwnd, SW_HIDE);
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
                ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            }
        }
        1
    }
    EnumWindows(Some(visit), 0);
}

/// Closes Edge player windows left over from an earlier Aura run (e.g. one that was closed by
/// an update or crashed). Edge allows one window per profile: if an old one is still open, a
/// new launch hands over to it and exits, and Aura ends up with no working player.
pub fn close_leftovers() {
    let script = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | \
        Where-Object { $_.CommandLine -like '*prism\\edge-player*' } | \
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .no_window()
        .output();
}

/// Closes the Edge window and its child processes.
pub fn stop(child: &mut Child) {
    let _ = Command::new("taskkill").args(["/F", "/T", "/PID", &child.id().to_string()]).no_window().output();
    let _ = child.kill();
}

trait NoWindow {
    fn no_window(&mut self) -> &mut Self;
}

impl NoWindow for Command {
    fn no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(0x0800_0000) // CREATE_NO_WINDOW
    }
}
