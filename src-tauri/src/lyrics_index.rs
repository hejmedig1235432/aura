//! Local lyrics index, so you can find a song by a line you remember. lrclib's search only
//! matches title/artist/album, so Aura keeps the plain lyrics of your own songs in
//! %APPDATA%\prism\lyrics.json and searches those.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Entry {
    pub name: String,
    pub artists: String,
    pub image: String,
    /// Plain lyrics; empty when lrclib has none (so we don't ask again).
    pub text: String,
}

#[derive(Serialize, Deserialize, Default)]
pub struct Index {
    pub songs: HashMap<String, Entry>,
}

fn path() -> PathBuf {
    dirs::config_dir().unwrap_or_default().join("prism").join("lyrics.json")
}

pub fn load() -> Index {
    std::fs::read_to_string(path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save(index: &Index) {
    if let Ok(json) = serde_json::to_string(index) {
        let tmp = path().with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(tmp, path());
        }
    }
}

/// Plain text from an lrclib response (synced lyrics with their timestamps stripped).
pub fn plain_text(res: &Value) -> String {
    if let Some(p) = res["plainLyrics"].as_str() {
        return p.to_string();
    }
    res["syncedLyrics"]
        .as_str()
        .map(|s| s.lines().map(|l| l.split_once(']').map(|x| x.1.trim()).unwrap_or(l)).collect::<Vec<_>>().join("\n"))
        .unwrap_or_default()
}

fn normalize(s: &str) -> String {
    s.to_lowercase().chars().map(|c| if c.is_alphanumeric() || c.is_whitespace() { c } else { ' ' }).collect::<String>()
        .split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Songs whose lyrics contain the query (punctuation and case ignored), with the matching line.
pub fn search(index: &Index, query: &str) -> Value {
    let q = normalize(query);
    if q.len() < 3 {
        return json!([]);
    }
    let mut hits: Vec<Value> = index
        .songs
        .iter()
        .filter_map(|(uri, e)| {
            let line = e.text.lines().find(|l| normalize(l).contains(&q))?;
            Some(json!({ "uri": uri, "name": e.name, "artists": e.artists, "image": e.image, "line": line.trim() }))
        })
        .collect();
    hits.truncate(30);
    json!(hits)
}
