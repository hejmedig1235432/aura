//! Offline library and request meter.
//!
//! Offline: answers for your library (Liked Songs, playlists, profile, top lists, artists,
//! albums) are kept in %APPDATA%\prism\offline.json. When Spotify can't answer (rate limit,
//! server error, no internet) Aura shows the saved copy instead of an empty page.
//!
//! Meter: every request sent to Spotify today is counted (reads and playback commands), plus
//! how many were answered from Aura's own copies instead. Kept in usage.json so restarts
//! don't reset it.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

fn dir() -> PathBuf {
    dirs::config_dir().unwrap_or_default().join("prism")
}

/* ---------------- offline copies ---------------- */

struct Store {
    map: HashMap<String, Value>,
    saved_at: Instant,
    dirty: bool,
}

fn store() -> &'static Mutex<Store> {
    static S: OnceLock<Mutex<Store>> = OnceLock::new();
    S.get_or_init(|| {
        let map = std::fs::read_to_string(dir().join("offline.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Mutex::new(Store { map, saved_at: Instant::now(), dirty: false })
    })
}

/// Library data worth keeping for offline use (not live playback state).
pub fn keeps(path: &str) -> bool {
    matches!(path, "/me" | "/me/tracks" | "/me/playlists" | "/me/top/tracks" | "/me/top/artists")
        || path.starts_with("/playlists/")
        || path.starts_with("/artists/")
        || path.starts_with("/albums/")
}

pub fn remember(key: &str, v: &Value) {
    let mut s = store().lock().unwrap();
    s.map.insert(key.to_string(), v.clone());
    s.dirty = true;
    // write at most every 15 s; the rest is flushed on exit
    if s.saved_at.elapsed() > Duration::from_secs(15) {
        write(&mut s);
    }
}

pub fn recall(key: &str) -> Option<Value> {
    store().lock().unwrap().map.get(key).cloned()
}

fn write(s: &mut Store) {
    let _ = std::fs::create_dir_all(dir());
    if let Ok(json) = serde_json::to_string(&s.map) {
        let tmp = dir().join("offline.json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(tmp, dir().join("offline.json"));
        }
    }
    s.saved_at = Instant::now();
    s.dirty = false;
}

/* ---------------- request meter ---------------- */

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Usage {
    day: String,
    sent: u64,
    saved: u64,
}

fn usage() -> &'static Mutex<Usage> {
    static U: OnceLock<Mutex<Usage>> = OnceLock::new();
    U.get_or_init(|| {
        Mutex::new(
            std::fs::read_to_string(dir().join("usage.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default(),
        )
    })
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn bump(sent: bool) {
    let mut u = usage().lock().unwrap();
    let day = today();
    if u.day != day {
        *u = Usage { day, sent: 0, saved: 0 };
    }
    if sent { u.sent += 1 } else { u.saved += 1 }
    if (u.sent + u.saved) % 10 == 0 {
        if let Ok(json) = serde_json::to_string(&*u) {
            let _ = std::fs::write(dir().join("usage.json"), json);
        }
    }
}

/// A request went to Spotify.
pub fn count_sent() {
    bump(true)
}

/// A request was answered from Aura's own copy (cache or offline) instead.
pub fn count_saved() {
    bump(false)
}

pub fn stats(blocked_secs: u64) -> Value {
    let u = usage().lock().unwrap();
    let fresh = u.day == today();
    json!({
        "sent": if fresh { u.sent } else { 0 },
        "saved": if fresh { u.saved } else { 0 },
        "blockedSecs": blocked_secs,
        "offlineItems": store().lock().unwrap().map.len(),
    })
}

/// Called when Aura closes: write whatever hasn't been saved yet.
pub fn flush() {
    let mut s = store().lock().unwrap();
    if s.dirty {
        write(&mut s);
    }
    if let Ok(json) = serde_json::to_string(&*usage().lock().unwrap()) {
        let _ = std::fs::write(dir().join("usage.json"), json);
    }
}
