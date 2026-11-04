//! Play counts. Spotify's API has no play-count endpoint, but "recently played" returns the
//! last 50 plays from every device. Aura syncs that list regularly and keeps its own tally in
//! %APPDATA%\prism\plays.json, so counts grow from the day Aura was first used.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Default, Serialize, Deserialize)]
pub struct Track {
    pub name: String,
    pub artists: String,
    pub image: String,
    pub count: u32,
    pub last_played: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Play {
    pub uri: String,
    /// ISO 8601 UTC time the play finished, as Spotify reports it.
    pub at: String,
}

#[derive(Default, Serialize, Deserialize)]
pub struct Store {
    /// played_at of the newest play already counted (ISO 8601, sortable as text).
    pub newest: String,
    pub tracks: HashMap<String, Track>,
    /// Every play in order, for the history timeline, streaks and "this day last year".
    #[serde(default)]
    pub history: Vec<Play>,
}

fn path() -> PathBuf {
    dirs::config_dir().unwrap_or_default().join("prism").join("plays.json")
}

pub fn load() -> Store {
    std::fs::read_to_string(path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save(store: &Store) -> Result<(), String> {
    let json = serde_json::to_string(store).map_err(|e| e.to_string())?;
    let tmp = path().with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path()).map_err(|e| e.to_string())
}

/// Adds plays from a /me/player/recently-played response that are newer than what's stored.
/// Returns how many new plays were counted.
pub fn merge(store: &mut Store, recent: &Value) -> Result<usize, String> {
    let mut items: Vec<&Value> = recent["items"].as_array().map(|a| a.iter().collect()).unwrap_or_default();
    items.sort_by(|a, b| a["played_at"].as_str().cmp(&b["played_at"].as_str()));
    let mut added = 0;
    let known: std::collections::HashSet<String> = store.history.iter().map(|p| p.at.clone()).collect();
    for item in items {
        let played_at = item["played_at"].as_str().unwrap_or_default();
        if played_at <= store.newest.as_str() {
            // Counted before the timeline existed: add it to history without counting it again.
            if !known.contains(played_at) {
                if let Some(uri) = item["track"]["uri"].as_str() {
                    store.history.push(Play { uri: uri.to_string(), at: played_at.to_string() });
                    store.history.sort_by(|a, b| a.at.cmp(&b.at));
                    added += 1;
                }
            }
            continue;
        }
        let t = &item["track"];
        let Some(uri) = t["uri"].as_str() else { continue };
        let entry = store.tracks.entry(uri.to_string()).or_default();
        entry.name = t["name"].as_str().unwrap_or_default().to_string();
        entry.artists = t["artists"]
            .as_array()
            .map(|a| a.iter().filter_map(|x| x["name"].as_str()).collect::<Vec<_>>().join(", "))
            .unwrap_or_default();
        entry.image = t["album"]["images"].as_array().and_then(|i| i.last()).and_then(|i| i["url"].as_str()).unwrap_or_default().to_string();
        entry.count += 1;
        entry.last_played = played_at.to_string();
        store.history.push(Play { uri: uri.to_string(), at: played_at.to_string() });
        store.newest = played_at.to_string();
        added += 1;
    }
    if added > 0 {
        save(store)?;
    }
    Ok(added)
}
