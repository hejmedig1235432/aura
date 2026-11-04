#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::TcpListener;

use rspotify::model::{Offset, PlayableId, RepeatState, TrackId};
use rspotify::prelude::*;
use rspotify::{scopes, AuthCodePkceSpotify, Config, Credentials, OAuth};
use serde_json::{json, Value};
use tauri::{Manager, State, WebviewWindow};
use tokio::sync::Mutex;

// PKCE client ids are public; RSPOTIFY_CLIENT_ID overrides this.
const CLIENT_ID: &str = "b7f26bd2252d4c4183edb7b330716cab";
const REDIRECT: &str = "http://127.0.0.1:8888/callback";
const API: &str = "https://api.spotify.com/v1";
/// Name of Aura's built-in player (the Edge window) as a Spotify Connect device.
const DEVICE_NAME: &str = "Aura";

mod discord;
mod edge;
mod hotkeys;
mod updates;
mod desk;
mod wallpaper;
mod lyrics_index;
mod plays;

struct App {
    sp: Mutex<AuthCodePkceSpotify>,
    http: reqwest::Client,
    edge: std::sync::Mutex<Option<std::process::Child>>,
    plays: Mutex<plays::Store>,
    lyrics: Mutex<lyrics_index::Index>,
    discord: std::sync::Mutex<discord::Presence>,
    /// Recent Spotify answers by request, to save the (shared, per-developer) request quota.
    cache: std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, Value)>>,
    /// Set when Spotify answers 429: no requests go out until then.
    blocked_until: std::sync::Mutex<Option<std::time::Instant>>,
}

type Res = Result<Value, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn build_client() -> AuthCodePkceSpotify {
    let id = std::env::var("RSPOTIFY_CLIENT_ID").unwrap_or_else(|_| CLIENT_ID.into());
    let oauth = OAuth {
        redirect_uri: REDIRECT.into(),
        scopes: scopes!(
            "streaming",
            "user-read-email",
            "user-read-playback-state",
            "user-modify-playback-state",
            "user-read-currently-playing",
            "user-read-recently-played",
            "user-read-private",
            "user-top-read",
            "user-library-read",
            "user-library-modify",
            "playlist-read-private",
            "playlist-read-collaborative"
        ),
        ..Default::default()
    };
    let cache = dirs::config_dir().unwrap_or_default().join("prism").join("token.json");
    let _ = std::fs::create_dir_all(cache.parent().unwrap());
    let config = Config { token_cached: true, token_refreshing: true, cache_path: cache, ..Default::default() };
    AuthCodePkceSpotify::with_config(Credentials::new_pkce(&id), oauth, config)
}

/// Blocks until Spotify redirects the browser back to our local callback.
fn wait_for_callback() -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:8888").map_err(err)?;
    let (mut stream, _) = listener.accept().map_err(err)?;
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).map_err(err)?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let path = req.split_whitespace().nth(1).ok_or("bad callback request")?.to_string();
    let body = "<html><body style='font-family:sans-serif;background:#0b0b10;color:#fff;text-align:center;padding-top:20vh'><h2>Aura is connected. You can close this tab.</h2></body></html>";
    let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}", body.len(), body);
    Ok(format!("http://127.0.0.1:8888{path}"))
}

fn track_id(s: &str) -> Result<TrackId<'static>, String> {
    TrackId::from_id_or_uri(s).map(|t| t.into_static()).map_err(err)
}

/// Current access token, refreshed first if it has expired.
async fn access_token(sp: &AuthCodePkceSpotify) -> Result<String, String> {
    let expired = sp.get_token().lock().await.unwrap().as_ref().map(|t| t.is_expired());
    match expired {
        None => return Err("not signed in".into()),
        Some(true) => sp.refresh_token().await.map_err(err)?,
        Some(false) => {}
    }
    let token = sp.get_token();
    let guard = token.lock().await.unwrap();
    guard.as_ref().map(|t| t.access_token.clone()).ok_or_else(|| "not signed in".into())
}

/// Raw Web API GET. Spotify keeps trimming fields from its responses, which breaks
/// rspotify's typed models, so reads go through untyped JSON instead.
async fn get(app: &App, path: &str, query: &[(&str, &str)]) -> Res {
    let key = format!("{path}?{}", query.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&"));
    let fresh_for = cache_ttl(path);
    let cached = app.cache.lock().unwrap().get(&key).cloned();
    if let Some((at, v)) = &cached {
        if at.elapsed() < fresh_for {
            return Ok(v.clone());
        }
    }
    // While Spotify has asked us to slow down, don't send anything; serve older answers instead.
    if let Some(until) = *app.blocked_until.lock().unwrap() {
        let now = std::time::Instant::now();
        if now < until {
            return match cached {
                Some((_, v)) => Ok(v),
                None => Err(format!("RATE_LIMITED {}", (until - now).as_secs().max(1))),
            };
        }
    }

    let token = access_token(&*app.sp.lock().await).await?;
    REQUESTS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let r = app.http.get(format!("{API}{path}")).bearer_auth(token).query(query).send().await.map_err(err)?;
    let status = r.status();
    if status == reqwest::StatusCode::NO_CONTENT {
        return Ok(Value::Null);
    }
    let retry_after = r.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).unwrap_or(30);
    let body = r.text().await.map_err(err)?;
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        *app.blocked_until.lock().unwrap() = Some(std::time::Instant::now() + std::time::Duration::from_secs(retry_after));
        log::info!("aura: Spotify rate limit, pausing requests for {retry_after}s");
        return match cached {
            Some((_, v)) => Ok(v),
            None => Err(format!("RATE_LIMITED {retry_after}")),
        };
    }
    if !status.is_success() {
        return Err(format!("Spotify {status}: {body}"));
    }
    if body.trim().is_empty() {
        return Ok(Value::Null);
    }
    let v: Value = serde_json::from_str(&body).map_err(err)?;
    if !fresh_for.is_zero() {
        app.cache.lock().unwrap().insert(key, (std::time::Instant::now(), v.clone()));
    }
    Ok(v)
}

/// Spotify read requests actually sent (cache hits don't count), logged every 10 minutes.
static REQUESTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn log_request_rate() {
    std::thread::spawn(|| loop {
        std::thread::sleep(std::time::Duration::from_secs(600));
        let n = REQUESTS.swap(0, std::sync::atomic::Ordering::Relaxed);
        log::info!("aura: {n} Spotify read requests in the last 10 minutes");
    });
}

/// How long a Spotify answer stays good. Live playback state isn't cached; library data
/// changes rarely, so pages open instantly and don't spend the request quota.
fn cache_ttl(path: &str) -> std::time::Duration {
    let secs = match path {
        "/me/player" | "/me/player/queue" | "/me/player/recently-played" => 0,
        "/me/player/devices" => 5,
        "/search" => 300,
        p if p.starts_with("/artists/") || p.starts_with("/albums/") => 1800,
        "/me/library/contains" => 120,
        // long lists take many requests to load; liking a song clears this (see set_liked)
        "/me/tracks" | "/me/playlists" => 600,
        p if p.starts_with("/playlists/") => 600,
        _ => 60,
    };
    std::time::Duration::from_secs(secs)
}

/// Drops cached answers that a change just made out of date (e.g. after liking a song).
fn forget_cached(app: &App, prefixes: &[&str]) {
    app.cache.lock().unwrap().retain(|k, _| !prefixes.iter().any(|p| k.starts_with(p)));
}

#[tauri::command]
async fn restore_session(app: State<'_, App>) -> Res {
    {
        let sp = app.sp.lock().await;
        match sp.read_token_cache(true).await {
            // The Web Playback SDK needs streaming + user-read-email; older tokens lack them.
            Ok(Some(tok)) if tok.scopes.contains("streaming") && tok.scopes.contains("user-read-email") => *sp.get_token().lock().await.unwrap() = Some(tok),
            _ => return Ok(json!(false)),
        }
    }
    // "too many requests" doesn't mean signed out: let you in, Aura waits out the limit
    Ok(json!(match get(&app, "/me", &[]).await {
        Ok(_) => true,
        Err(e) => e.starts_with("RATE_LIMITED"),
    }))
}

#[tauri::command]
async fn login(app: State<'_, App>) -> Res {
    {
        let mut sp = app.sp.lock().await;
        let url = sp.get_authorize_url(None).map_err(err)?;
        let waiter = tokio::task::spawn_blocking(wait_for_callback);
        webbrowser::open(&url).map_err(err)?;
        let redirected = waiter.await.map_err(err)??;
        let code = sp.parse_response_code(&redirected).ok_or("no code in callback")?;
        sp.request_token(&code).await.map_err(err)?;
    }
    match get(&app, "/me", &[]).await {
        // signed in fine; Spotify is only rate-limiting, so don't fail the sign-in
        Err(e) if e.starts_with("RATE_LIMITED") => Ok(json!({})),
        other => other,
    }
}


#[tauri::command]
async fn me(app: State<'_, App>) -> Res {
    get(&app, "/me", &[]).await
}

#[tauri::command]
async fn now_playing(app: State<'_, App>) -> Res {
    get(&app, "/me/player", &[]).await
}

#[tauri::command]
async fn devices(app: State<'_, App>) -> Res {
    let r = get(&app, "/me/player/devices", &[]).await?;
    Ok(r.get("devices").cloned().unwrap_or(json!([])))
}

#[tauri::command]
async fn search(app: State<'_, App>, query: String) -> Res {
    // Spotify caps search at 10 results per page for development-mode apps,
    // so fetch three pages and merge them.
    // The first page also brings artists and albums.
    let mut items = Vec::new();
    let mut artists = json!([]);
    let mut albums = json!([]);
    for offset in ["0", "10", "20"] {
        let kinds = if offset == "0" { "track,artist,album" } else { "track" };
        let page = get(&app, "/search", &[("q", query.as_str()), ("type", kinds), ("limit", "10"), ("offset", offset)]).await;
        match page {
            Ok(v) => {
                if offset == "0" {
                    artists = v["artists"]["items"].clone();
                    albums = v["albums"]["items"].clone();
                }
                let batch = v["tracks"]["items"].as_array().cloned().unwrap_or_default();
                let done = batch.len() < 10;
                items.extend(batch);
                if done {
                    break;
                }
            }
            Err(e) if items.is_empty() => return Err(e),
            Err(_) => break,
        }
    }
    Ok(json!({ "tracks": { "items": items }, "artists": artists, "albums": albums }))
}

/// An artist with their albums and singles (artist top tracks were removed from the API in 2026).
#[tauri::command]
async fn artist(app: State<'_, App>, id: String) -> Res {
    let info = get(&app, &format!("/artists/{id}"), &[]).await?;
    let albums = get(&app, &format!("/artists/{id}/albums"), &[("include_groups", "album,single"), ("limit", "40")]).await?;
    Ok(json!({ "artist": info, "albums": albums["items"] }))
}

/// An album with its track list.
#[tauri::command]
async fn album(app: State<'_, App>, id: String) -> Res {
    get(&app, &format!("/albums/{id}"), &[]).await
}

/// Plays an album, artist or playlist by its spotify: URI.
#[tauri::command]
async fn play_context(app: State<'_, App>, uri: String, start: Option<String>) -> Res {
    use rspotify::model::{AlbumId, ArtistId, PlayContextId, PlaylistId};
    let ctx = if uri.starts_with("spotify:album:") {
        PlayContextId::Album(AlbumId::from_uri(&uri).map_err(err)?.into_static())
    } else if uri.starts_with("spotify:artist:") {
        PlayContextId::Artist(ArtistId::from_uri(&uri).map_err(err)?.into_static())
    } else {
        PlayContextId::Playlist(PlaylistId::from_uri(&uri).map_err(err)?.into_static())
    };
    let offset = start.map(Offset::Uri);
    let first_try = app.sp.lock().await.start_context_playback(ctx.clone(), None, offset.clone(), None).await;
    if first_try.is_ok() {
        return Ok(Value::Null);
    }
    let device = fallback_device(&app).await?;
    let sp = app.sp.lock().await;
    sp.start_context_playback(ctx, Some(&device), offset, None).await.map_err(err)?;
    Ok(Value::Null)
}

#[tauri::command]
async fn playlists(app: State<'_, App>) -> Res {
    get_all(&app, "/me/playlists", 50, 20).await
}

/// Follows Spotify's pages (it returns at most `page` items per request) and joins them.
/// Stops after `max_pages` so a huge library can't eat the whole request quota.
async fn get_all(app: &App, path: &str, page: usize, max_pages: usize) -> Res {
    let limit = page.to_string();
    let mut items: Vec<Value> = Vec::new();
    let mut total = 0;
    for n in 0..max_pages {
        let offset = (n * page).to_string();
        let v = match get(app, path, &[("limit", limit.as_str()), ("offset", offset.as_str())]).await {
            Ok(v) => v,
            Err(e) if items.is_empty() => return Err(e),
            Err(_) => break, // keep what we have (e.g. rate limited halfway)
        };
        total = v["total"].as_u64().unwrap_or(0) as usize;
        let batch = v["items"].as_array().cloned().unwrap_or_default();
        let done = batch.len() < page || v["next"].is_null();
        items.extend(batch);
        if done || items.len() >= total {
            break;
        }
    }
    Ok(json!({ "items": items, "total": total }))
}

/// Track lists for the sidebar views: liked, recent, top, playlist.
#[tauri::command]
async fn library(app: State<'_, App>, kind: String, id: Option<String>) -> Res {
    match kind.as_str() {
        // up to 5,000 liked songs (100 pages of 50)
        "liked" => get_all(&app, "/me/tracks", 50, 100).await,
        "recent" => get(&app, "/me/player/recently-played", &[("limit", "50")]).await,
        "top" => get(&app, "/me/top/tracks", &[("limit", "50")]).await,
        "playlist" => {
            let id = id.ok_or("missing playlist id")?;
            let id = id.rsplit(':').next().unwrap_or(&id).to_string();
            // Only playlists you own can be listed; followed ones return 403 (Feb 2026 change).
            get_all(&app, &format!("/playlists/{id}/items"), 100, 50)
                .await
                .map_err(|e| if e.contains("403") { "NOT_OWNER".to_string() } else { e })
        }
        _ => Err(format!("unknown library kind {kind}")),
    }
}

#[tauri::command]
async fn queue(app: State<'_, App>) -> Res {
    get(&app, "/me/player/queue", &[]).await
}

#[tauri::command]
// Spotify moved saved-track endpoints to /me/library (the old /me/tracks ones return 403).
async fn is_liked(app: State<'_, App>, id: String) -> Res {
    let uri = track_id(&id)?.uri();
    let r = get(&app, "/me/library/contains", &[("uris", uri.as_str())]).await?;
    Ok(json!(r.get(0).and_then(Value::as_bool).unwrap_or(false)))
}

#[tauri::command]
async fn set_liked(app: State<'_, App>, id: String, on: bool) -> Res {
    let uri = track_id(&id)?.uri();
    let token = access_token(&*app.sp.lock().await).await?;
    let req = if on { app.http.put(format!("{API}/me/library")) } else { app.http.delete(format!("{API}/me/library")) };
    let r = req.bearer_auth(token).query(&[("uris", uri.as_str())]).header("Content-Length", "0").send().await.map_err(err)?;
    if !r.status().is_success() {
        return Err(format!("Spotify {}: {}", r.status(), r.text().await.unwrap_or_default()));
    }
    forget_cached(&app, &["/me/library/contains", "/me/tracks"]); // so the heart and Liked Songs update
    Ok(Value::Null)
}

#[tauri::command]
/// Moves playback to a device. play=false makes it the active device without starting music.
async fn transfer(app: State<'_, App>, device_id: String, play: Option<bool>) -> Res {
    let sp = app.sp.lock().await;
    sp.transfer_playback(&device_id, Some(play.unwrap_or(true))).await.map_err(err)?;
    Ok(Value::Null)
}

#[tauri::command]
async fn control(app: State<'_, App>, action: String) -> Res {
    if action == "play" {
        if app.sp.lock().await.resume_playback(None, None).await.is_ok() {
            return Ok(Value::Null);
        }
        let device = fallback_device(&app).await?;
        let sp = app.sp.lock().await;
        sp.transfer_playback(&device, Some(true)).await.map_err(err)?;
        return Ok(Value::Null);
    }
    let sp = app.sp.lock().await;
    match action.as_str() {
        "pause" => sp.pause_playback(None).await,
        "next" => sp.next_track(None).await,
        "prev" => sp.previous_track(None).await,
        _ => return Err(format!("unknown action {action}")),
    }
    .map_err(err)?;
    Ok(Value::Null)
}

#[tauri::command]
async fn set_volume(app: State<'_, App>, percent: u8) -> Res {
    let sp = app.sp.lock().await;
    sp.volume(percent.min(100), None).await.map_err(err)?;
    Ok(Value::Null)
}

#[tauri::command]
async fn seek(app: State<'_, App>, ms: i64) -> Res {
    let sp = app.sp.lock().await;
    sp.seek_track(chrono::Duration::milliseconds(ms), None).await.map_err(err)?;
    Ok(Value::Null)
}

#[tauri::command]
async fn shuffle(app: State<'_, App>, on: bool) -> Res {
    let sp = app.sp.lock().await;
    sp.shuffle(on, None).await.map_err(err)?;
    Ok(Value::Null)
}

#[tauri::command]
async fn repeat(app: State<'_, App>, mode: String) -> Res {
    let state = match mode.as_str() {
        "track" => RepeatState::Track,
        "context" => RepeatState::Context,
        _ => RepeatState::Off,
    };
    let sp = app.sp.lock().await;
    sp.repeat(state, None).await.map_err(err)?;
    Ok(Value::Null)
}

/// Plays a whole playlist. Works for followed playlists, whose songs Spotify no longer lets
/// apps list (only playlists you own return their items).
#[tauri::command]
async fn play_playlist(app: State<'_, App>, id: String) -> Res {
    let pid = rspotify::model::PlaylistId::from_id_or_uri(&id).map_err(err)?.into_static();
    let ctx = rspotify::model::PlayContextId::Playlist(pid);
    let first_try = app.sp.lock().await.start_context_playback(ctx.clone(), None, None, None).await;
    if first_try.is_ok() {
        return Ok(Value::Null);
    }
    let device = fallback_device(&app).await?;
    let sp = app.sp.lock().await;
    sp.start_context_playback(ctx, Some(&device), None, None).await.map_err(err)?;
    Ok(Value::Null)
}

#[tauri::command]
async fn add_queue(app: State<'_, App>, uri: String) -> Res {
    let id = PlayableId::Track(track_id(&uri)?);
    let sp = app.sp.lock().await;
    sp.add_item_to_queue(id, None).await.map_err(err)?;
    Ok(Value::Null)
}

/// Plays a list of tracks, optionally starting at one of them.
#[tauri::command]
async fn play_uris(app: State<'_, App>, uris: Vec<String>, start: Option<String>) -> Res {
    let ids = uris.iter().map(|u| track_id(u).map(PlayableId::Track)).collect::<Result<Vec<_>, _>>()?;
    let offset = start.map(Offset::Uri);
    let first_try = app.sp.lock().await.start_uris_playback(ids.clone(), None, offset.clone(), None).await;
    if first_try.is_ok() {
        return Ok(Value::Null);
    }
    // No active device: fall back to any device Spotify is open on.
    let device = fallback_device(&app).await?;
    let sp = app.sp.lock().await;
    sp.start_uris_playback(ids, Some(&device), offset, None).await.map_err(err)?;
    Ok(Value::Null)
}

async fn fallback_device(app: &App) -> Result<String, String> {
    let list = get(app, "/me/player/devices", &[]).await?;
    list["devices"]
        .as_array()
        .and_then(|d| {
            // A real Spotify app first; the page moves playback to Aura's web player itself.
            d.iter()
                .find(|d| d["is_active"] == true && d["name"] != DEVICE_NAME)
                .or_else(|| d.iter().find(|d| d["name"] != DEVICE_NAME))
        })
        .and_then(|d| d["id"].as_str())
        .map(String::from)
        .ok_or_else(|| "No active device: open Spotify on your PC or phone first.".into())
}

// lrclib asks clients to name themselves (app, version, where it's from).
const LRCLIB_UA: &str = concat!("Aura/", env!("CARGO_PKG_VERSION"), " (personal desktop Spotify client)");

/// Fetches lyrics from lrclib.net. Ok(None) means lrclib has no lyrics for the song.
async fn fetch_lyrics(http: &reqwest::Client, artist: &str, title: &str, album: &str, duration: u32) -> Result<Option<Value>, String> {
    let dur = duration.to_string();
    let r = http
        .get("https://lrclib.net/api/get")
        .header("User-Agent", LRCLIB_UA)
        .query(&[("artist_name", artist), ("track_name", title), ("album_name", album), ("duration", dur.as_str())])
        .send()
        .await
        .map_err(err)?;
    if r.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("RATE_LIMITED".into());
    }
    if !r.status().is_success() {
        return Ok(None);
    }
    r.json::<Value>().await.map(Some).map_err(err)
}

fn remember_lyrics(index: &mut lyrics_index::Index, uri: &str, title: &str, artist: &str, image: &str, res: Option<&Value>) {
    index.songs.insert(
        uri.to_string(),
        lyrics_index::Entry {
            name: title.to_string(),
            artists: artist.to_string(),
            image: image.to_string(),
            text: res.map(lyrics_index::plain_text).unwrap_or_default(),
        },
    );
}

/// Synced lyrics from lrclib.net (Spotify's API doesn't expose lyrics). Also adds the song
/// to the local lyrics index used by "search by lyrics".
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn lyrics(
    app: State<'_, App>, artist: String, title: String, album: String, duration: u32, uri: Option<String>, image: Option<String>,
) -> Res {
    let res = fetch_lyrics(&app.http, &artist, &title, &album, duration).await.unwrap_or(None);
    if let Some(uri) = uri {
        let mut index = app.lyrics.lock().await;
        remember_lyrics(&mut index, &uri, &title, &artist, image.as_deref().unwrap_or(""), res.as_ref());
        lyrics_index::save(&index);
    }
    Ok(res.unwrap_or(Value::Null))
}

/// Fetches lyrics for songs not in the index yet, slowly in the background (lrclib allows
/// about 90 requests a minute; this stays well under). Each song: {uri, name, artist, album, duration, image}.
#[tauri::command]
async fn index_lyrics(handle: tauri::AppHandle, app: State<'_, App>, songs: Vec<Value>) -> Res {
    let missing: Vec<Value> = {
        let index = app.lyrics.lock().await;
        songs.into_iter().filter(|s| s["uri"].as_str().map(|u| !index.songs.contains_key(u)).unwrap_or(false)).collect()
    };
    let count = missing.len();
    tauri::async_runtime::spawn(async move {
        let app = handle.state::<App>();
        for (i, s) in missing.iter().enumerate() {
            let get = |k: &str| s[k].as_str().unwrap_or_default().to_string();
            let res = match fetch_lyrics(&app.http, &get("artist"), &get("name"), &get("album"), s["duration"].as_u64().unwrap_or(0) as u32).await {
                Ok(r) => r,
                Err(e) if e == "RATE_LIMITED" => {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    continue;
                }
                Err(_) => continue,
            };
            let mut index = app.lyrics.lock().await;
            remember_lyrics(&mut index, &get("uri"), &get("name"), &get("artist"), &get("image"), res.as_ref());
            if i % 10 == 9 || i + 1 == missing.len() {
                lyrics_index::save(&index);
            }
            drop(index);
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        }
    });
    Ok(json!(count))
}

#[tauri::command]
async fn lyrics_search(app: State<'_, App>, query: String) -> Res {
    let index = app.lyrics.lock().await;
    Ok(json!({ "hits": lyrics_index::search(&index, &query), "indexed": index.songs.values().filter(|e| !e.text.is_empty()).count() }))
}

/// Translates lyric lines with the free MyMemory API (no account needed). Lines are sent in
/// small batches joined by newlines, since a request is limited to about 500 characters.
#[tauri::command]
async fn translate(app: State<'_, App>, lines: Vec<String>, target: String) -> Res {
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut batch: Vec<String> = Vec::new();
    let mut batches: Vec<Vec<String>> = Vec::new();
    for l in lines {
        if batch.iter().map(|x| x.len() + 1).sum::<usize>() + l.len() > 450 && !batch.is_empty() {
            batches.push(std::mem::take(&mut batch));
        }
        batch.push(l);
    }
    if !batch.is_empty() {
        batches.push(batch);
    }
    for b in batches {
        let text = b.join("\n");
        let pair = format!("Autodetect|{target}");
        let r: Value = app
            .http
            .get("https://api.mymemory.translated.net/get")
            .query(&[("q", text.as_str()), ("langpair", pair.as_str())])
            .send()
            .await
            .map_err(err)?
            .json()
            .await
            .map_err(err)?;
        let translated = r["responseData"]["translatedText"].as_str().unwrap_or_default();
        let parts: Vec<&str> = translated.split('\n').collect();
        for i in 0..b.len() {
            out.push(parts.get(i).map(|s| s.trim().to_string()).unwrap_or_default());
        }
    }
    Ok(json!(out))
}

/// The full play timeline plus track details, for the History page.
#[tauri::command]
async fn play_history(app: State<'_, App>) -> Res {
    let store = app.plays.lock().await;
    Ok(json!({ "history": store.history, "tracks": store.tracks }))
}

/// Shows or hides the floating desktop widget (album art + current lyric line).
#[tauri::command]
async fn toggle_widget(app: tauri::AppHandle, show: bool) -> Res {
    if let Some(w) = app.get_webview_window("widget") {
        if show { w.show().map_err(err)?; } else { w.close().map_err(err)?; }
        return Ok(json!(show));
    }
    if !show {
        return Ok(json!(false));
    }
    let size = (380.0, 150.0);
    let mut b = tauri::WebviewWindowBuilder::new(&app, "widget", tauri::WebviewUrl::App("widget.html".into()))
        .title("Aura widget")
        .inner_size(size.0, size.1)
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_bottom(true)
        .shadow(false);
    if let Some(m) = app.primary_monitor().ok().flatten() {
        let s = m.scale_factor();
        let w = m.size().width as f64 / s;
        b = b.position(w - size.0 - 24.0, 24.0);
    }
    b.build().map_err(err)?;
    Ok(json!(true))
}

#[tauri::command]
fn set_material(window: WebviewWindow, kind: String) -> Res {
    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::*;
        let _ = clear_mica(&window);
        let _ = clear_acrylic(&window);
        let _ = clear_tabbed(&window);
        let _ = match kind.as_str() {
            "mica" => apply_mica(&window, Some(true)),
            "acrylic" => apply_acrylic(&window, Some((18, 18, 24, 120))),
            "tabbed" => apply_tabbed(&window, Some(true)),
            _ => Ok(()),
        };
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (window, kind);
    Ok(Value::Null)
}

/// Pulls the latest plays from Spotify into Aura's play counter. Returns how many were new.
#[tauri::command]
async fn sync_plays(app: State<'_, App>) -> Res {
    let recent = get(&app, "/me/player/recently-played", &[("limit", "50")]).await?;
    let mut store = app.plays.lock().await;
    Ok(json!(plays::merge(&mut store, &recent)?))
}

/// All play counts Aura has recorded, keyed by track URI.
#[tauri::command]
async fn play_counts(app: State<'_, App>) -> Res {
    let store = app.plays.lock().await;
    serde_json::to_value(&store.tracks).map_err(err)
}

/// Your top artists or tracks. range: short_term (4 weeks), medium_term (6 months), long_term (all time).
#[tauri::command]
async fn top_items(app: State<'_, App>, kind: String, range: String) -> Res {
    let kind = if kind == "artists" { "artists" } else { "tracks" };
    get(&app, &format!("/me/top/{kind}"), &[("time_range", range.as_str()), ("limit", "50")]).await
}

// Talking to Discord can block (it waits for Discord's reply), so it runs on a background
// thread, never on the window's thread. If an update is still in flight, the new one is
// skipped rather than queued: the next song change sends a fresh one anyway.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn discord_set(
    handle: tauri::AppHandle, app_id: String, title: String, artist: String, album: String, image: String, start_ms: i64, end_ms: i64,
) -> Res {
    tauri::async_runtime::spawn_blocking(move || {
        let app = handle.state::<App>();
        let Ok(mut presence) = app.discord.try_lock() else { return Ok(()) };
        presence.set(&app_id, &title, &artist, &album, &image, start_ms, end_ms)
    })
    .await
    .map_err(err)??;
    Ok(Value::Null)
}

#[tauri::command]
async fn discord_clear(handle: tauri::AppHandle) -> Res {
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(mut presence) = handle.state::<App>().discord.try_lock() {
            presence.clear();
        }
    })
    .await
    .map_err(err)?;
    Ok(Value::Null)
}

/// Starts Aura's audio player in an off-screen Edge window (once per app run).
#[tauri::command]
fn start_edge_player(app: tauri::AppHandle, state: State<'_, App>) -> Res {
    let mut slot = state.edge.lock().unwrap();
    if slot.is_none() {
        *slot = Some(edge::start(&app)?);
        edge::hide_from_taskbar();
    }
    Ok(json!(DEVICE_NAME))
}

/// Access token for Spotify's Web Playback SDK running in the page.
#[tauri::command]
async fn web_token(app: State<'_, App>) -> Res {
    Ok(json!(access_token(&*app.sp.lock().await).await?))
}

/// Lets the page write diagnostics into aura.log.
#[tauri::command]
fn report(msg: String) {
    log::info!("{msg}");
}

/// Forgets the saved Spotify sign-in (and the old librespot player's, if one is left over).
#[tauri::command]
async fn sign_out(app: State<'_, App>) -> Res {
    *app.sp.lock().await.get_token().lock().await.unwrap() = None;
    let dir = dirs::config_dir().unwrap_or_default().join("prism");
    let _ = std::fs::remove_file(dir.join("token.json"));
    let _ = std::fs::remove_dir_all(dir.join("librespot"));
    Ok(Value::Null)
}

/// Launches the Spotify desktop app (minimized to the background) so it can act as the player.
#[tauri::command]
fn open_spotify() -> Res {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/C", "start", "/min", "", "spotify:"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(err)?;
    }
    Ok(Value::Null)
}

/// Turns "open Aura when Windows starts" on or off.
#[tauri::command]
fn set_autostart(app: tauri::AppHandle, on: bool) -> Res {
    use tauri_plugin_autostart::ManagerExt;
    let launcher = app.autolaunch();
    if on { launcher.enable() } else { launcher.disable() }.map_err(err)?;
    Ok(json!(launcher.is_enabled().unwrap_or(on)))
}

/// Player logs go to %APPDATA%\prism\aura.log so playback problems can be diagnosed.
fn init_log() {
    let dir = dirs::config_dir().unwrap_or_default().join("prism");
    let _ = std::fs::create_dir_all(&dir);
    // Append across runs, but start over once the log passes 2 MB.
    let path = dir.join("aura.log");
    let big = std::fs::metadata(&path).map(|m| m.len() > 2_000_000).unwrap_or(false);
    let file = std::fs::OpenOptions::new().create(true).write(true).append(!big).truncate(big).open(&path);
    if let Ok(file) = file {
        let cfg = simplelog::ConfigBuilder::new().add_filter_allow_str("aura").build();
        let _ = simplelog::WriteLogger::init(log::LevelFilter::Info, cfg, file);
    }
}

fn main() {
    init_log();
    log_request_rate();
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(hotkeys::plugin())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::Pending::default())
        .setup(|app| {
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            for s in hotkeys::shortcuts() {
                if let Err(e) = app.global_shortcut().register(s) {
                    log::info!("aura: hotkey {s:?} is taken by another app: {e}");
                }
            }
            Ok(())
        })
        .manage(App {
            sp: Mutex::new(build_client()),
            http: reqwest::Client::new(),
            edge: std::sync::Mutex::new(None),
            plays: Mutex::new(plays::load()),
            lyrics: Mutex::new(lyrics_index::load()),
            discord: std::sync::Mutex::new(discord::Presence::default()),
            cache: Default::default(),
            blocked_until: Default::default(),
        })
        .invoke_handler(tauri::generate_handler![
            restore_session, login, me, now_playing, devices, transfer, control, set_volume, seek,
            shuffle, repeat, search, play_uris, play_playlist, add_queue, playlists, library, queue, is_liked, set_liked,
            lyrics, set_material, set_autostart, open_spotify, sign_out, web_token, report, start_edge_player,
            sync_plays, play_counts, top_items, discord_set, discord_clear,
            index_lyrics, lyrics_search, translate, play_history, toggle_widget,
            artist, album, play_context, hotkeys::show_overlay,
            updates::check_update, updates::install_update,
            wallpaper::set_song_wallpaper, wallpaper::restore_wallpaper,
            desk::toggle_desk, desk::desk_hot
        ])
        .build(tauri::generate_context!())
        .expect("error while building Aura")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let _ = wallpaper::restore_now(); // give you your own wallpaper back
                if let Some(mut child) = app.state::<App>().edge.lock().unwrap().take() {
                    edge::stop(&mut child);
                }
            }
        });
}
