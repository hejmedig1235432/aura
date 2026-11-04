/*
 * Aura on the web. The desktop app's interface (app.js) talks to a Rust backend through
 * window.__TAURI__.core.invoke. In the browser there's no Rust, so this file provides the same
 * commands in JavaScript: Spotify sign-in (PKCE), Web API requests with caching and rate-limit
 * pauses, play counts, history and the lyrics index (saved in this browser).
 * Desktop-only commands (wallpaper, hotkeys, widget, Discord, ...) quietly do nothing.
 */
(() => {
  // The website's own Spotify app ("AURA"), whose Redirect URI is the GitHub Pages address.
  // (The desktop app uses a separate one with http://127.0.0.1:8888/callback.)
  const CLIENT_ID = "81ad3cf96c904778a46f55e657db529a";
  const API = "https://api.spotify.com/v1";
  // Must match a Redirect URI in the Spotify dashboard exactly, so always send the folder
  // address (https://.../aura/), even if the page was opened as .../aura/index.html.
  const REDIRECT = location.origin + location.pathname.replace(/index\.html$/, "").replace(/([^/])$/, "$1/");
  const SCOPES = [
    "streaming", "user-read-email", "user-read-private", "user-read-playback-state", "user-modify-playback-state",
    "user-read-currently-playing", "user-read-recently-played", "user-top-read", "user-library-read",
    "user-library-modify", "playlist-read-private", "playlist-read-collaborative",
  ].join(" ");
  const LRCLIB_CLIENT = "Aura web (personal Spotify client)";

  window.AURA_WEB = true;
  document.documentElement.classList.add("web");

  /* ---------- small storage helpers ---------- */
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  /* ---------- sign-in (Authorization Code with PKCE, all in the browser) ---------- */
  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  let token = load("aura.web.token", null); // { access_token, refresh_token, expires_at, scope }

  async function exchange(params) {
    const r = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
    });
    const j = await r.json();
    if (!r.ok) throw `Spotify sign-in failed: ${j.error_description || j.error || r.status}`;
    token = {
      access_token: j.access_token,
      refresh_token: j.refresh_token || token?.refresh_token,
      expires_at: Date.now() + (j.expires_in - 60) * 1000,
      scope: j.scope,
    };
    store("aura.web.token", token);
  }

  // Coming back from Spotify's sign-in page with ?code=...
  const authReady = (async () => {
    const q = new URLSearchParams(location.search);
    if (q.get("code")) {
      const verifier = sessionStorage.getItem("aura.pkce");
      history.replaceState(null, "", REDIRECT);
      if (verifier) await exchange({ grant_type: "authorization_code", code: q.get("code"), redirect_uri: REDIRECT, code_verifier: verifier }).catch((e) => console.error(e));
    } else if (q.get("error")) {
      history.replaceState(null, "", REDIRECT);
    }
  })();

  async function accessToken() {
    await authReady;
    if (!token) throw "not signed in";
    if (Date.now() > token.expires_at) await exchange({ grant_type: "refresh_token", refresh_token: token.refresh_token });
    return token.access_token;
  }

  async function login() {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    sessionStorage.setItem("aura.pkce", verifier);
    location.href = "https://accounts.spotify.com/authorize?" + new URLSearchParams({
      client_id: CLIENT_ID, response_type: "code", redirect_uri: REDIRECT, scope: SCOPES,
      code_challenge_method: "S256", code_challenge: challenge,
    });
    return new Promise(() => {}); // the page is leaving
  }

  /* ---------- Spotify Web API with caching and rate-limit pauses ---------- */
  const cache = new Map();
  let blockedUntil = 0;
  const ttl = (path) =>
    ["/me/player", "/me/player/queue", "/me/player/recently-played"].includes(path) ? 0
    : path === "/me/player/devices" ? 5
    : path === "/search" ? 300
    : path.startsWith("/artists/") || path.startsWith("/albums/") ? 1800
    : path === "/me/library/contains" ? 120
    : path === "/me/tracks" || path === "/me/playlists" || path.startsWith("/playlists/") ? 600
    : 60;

  async function api(method, path, query = {}, body) {
    const qs = new URLSearchParams(query).toString();
    const key = `${path}?${qs}`;
    const fresh = method === "GET" ? ttl(path) * 1000 : 0;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < fresh) return hit.v;
    if (Date.now() < blockedUntil) {
      if (hit) return hit.v;
      throw `RATE_LIMITED ${Math.ceil((blockedUntil - Date.now()) / 1000)}`;
    }
    const r = await fetch(`${API}${path}${qs ? "?" + qs : ""}`, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429) {
      const wait = +r.headers.get("retry-after") || 30;
      blockedUntil = Date.now() + wait * 1000;
      if (hit) return hit.v;
      throw `RATE_LIMITED ${wait}`;
    }
    const text = await r.text();
    if (!r.ok) throw `Spotify ${r.status}: ${text}`;
    const v = text.trim() ? JSON.parse(text) : null;
    if (fresh) cache.set(key, { at: Date.now(), v });
    return v;
  }
  const get = (path, query) => api("GET", path, query);
  const forget = (...prefixes) => { for (const k of cache.keys()) if (prefixes.some((p) => k.startsWith(p))) cache.delete(k); };

  async function getAll(path, page, maxPages) {
    let items = [], total = 0;
    for (let n = 0; n < maxPages; n++) {
      let v;
      try { v = await get(path, { limit: page, offset: n * page }); }
      catch (e) { if (!items.length) throw e; break; }
      total = v.total ?? 0;
      const batch = v.items ?? [];
      items = items.concat(batch);
      if (batch.length < page || !v.next || items.length >= total) break;
    }
    return { items, total };
  }

  const toUri = (id) => (String(id).startsWith("spotify:") ? id : `spotify:track:${id}`);

  /* ---------- play counts and history (this browser) ---------- */
  let plays = load("aura.web.plays", { newest: "", tracks: {}, history: [] });
  function mergePlays(recent) {
    const items = [...(recent?.items ?? [])].sort((a, b) => a.played_at.localeCompare(b.played_at));
    let added = 0;
    for (const it of items) {
      if (it.played_at <= plays.newest) continue;
      const t = it.track, uri = t?.uri;
      if (!uri) continue;
      const e = (plays.tracks[uri] ??= { name: "", artists: "", image: "", count: 0, last_played: "" });
      e.name = t.name;
      e.artists = (t.artists ?? []).map((a) => a.name).join(", ");
      e.image = t.album?.images?.at(-1)?.url ?? "";
      e.count++;
      e.last_played = it.played_at;
      plays.history.push({ uri, at: it.played_at });
      plays.newest = it.played_at;
      added++;
    }
    if (added) store("aura.web.plays", plays);
    return added;
  }

  /* ---------- lyrics (lrclib) and the lyrics index ---------- */
  let lyricsIndex = load("aura.web.lyrics", {}); // uri -> { name, artists, image, text }
  const saveLyrics = () => store("aura.web.lyrics", lyricsIndex);
  const plainText = (res) => res?.plainLyrics ?? (res?.syncedLyrics ?? "").split("\n").map((l) => l.replace(/^\[[^\]]*\]\s*/, "")).join("\n");
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

  async function fetchLyrics(artist, title, album, duration) {
    const r = await fetch("https://lrclib.net/api/get?" + new URLSearchParams({ artist_name: artist, track_name: title, album_name: album, duration }), {
      headers: { "Lrclib-Client": LRCLIB_CLIENT },
    });
    if (r.status === 429) throw "RATE_LIMITED";
    return r.ok ? r.json() : null;
  }

  /* ---------- the commands app.js calls ---------- */
  const commands = {
    restore_session: async () => {
      await authReady;
      if (!token?.scope?.includes("streaming")) return false;
      try { await get("/me"); return true; } catch { return false; }
    },
    login: () => login(),
    sign_out: async () => { token = null; localStorage.removeItem("aura.web.token"); cache.clear(); },
    web_token: () => accessToken(),
    me: () => get("/me"),
    now_playing: () => get("/me/player"),
    devices: async () => (await get("/me/player/devices"))?.devices ?? [],
    transfer: ({ deviceId, play }) => api("PUT", "/me/player", {}, { device_ids: [deviceId], play: play ?? true }),
    control: ({ action }) => ({
      play: () => api("PUT", "/me/player/play"),
      pause: () => api("PUT", "/me/player/pause"),
      next: () => api("POST", "/me/player/next"),
      prev: () => api("POST", "/me/player/previous"),
    })[action](),
    set_volume: ({ percent }) => api("PUT", "/me/player/volume", { volume_percent: Math.min(100, percent) }),
    seek: ({ ms }) => api("PUT", "/me/player/seek", { position_ms: Math.max(0, Math.round(ms)) }),
    shuffle: ({ on }) => api("PUT", "/me/player/shuffle", { state: on }),
    repeat: ({ mode }) => api("PUT", "/me/player/repeat", { state: mode }),
    play_uris: ({ uris, start }) => api("PUT", "/me/player/play", {}, { uris: uris.map(toUri), ...(start ? { offset: { uri: toUri(start) } } : {}) }),
    play_playlist: ({ id }) => api("PUT", "/me/player/play", {}, { context_uri: String(id).startsWith("spotify:") ? id : `spotify:playlist:${id}` }),
    play_context: ({ uri, start }) => api("PUT", "/me/player/play", {}, { context_uri: uri, ...(start ? { offset: { uri: start } } : {}) }),
    add_queue: ({ uri }) => api("POST", "/me/player/queue", { uri: toUri(uri) }),
    search: async ({ query }) => {
      let items = [], artists = [], albums = [];
      for (const offset of [0, 10, 20]) {
        let v;
        try { v = await get("/search", { q: query, type: offset ? "track" : "track,artist,album", limit: 10, offset }); }
        catch (e) { if (!items.length) throw e; break; }
        if (!offset) { artists = v.artists?.items ?? []; albums = v.albums?.items ?? []; }
        const batch = v.tracks?.items ?? [];
        items = items.concat(batch);
        if (batch.length < 10) break;
      }
      return { tracks: { items }, artists, albums };
    },
    playlists: () => getAll("/me/playlists", 50, 20),
    library: async ({ kind, id }) => {
      if (kind === "liked") return getAll("/me/tracks", 50, 100);
      if (kind === "recent") return get("/me/player/recently-played", { limit: 50 });
      if (kind === "top") return get("/me/top/tracks", { limit: 50 });
      const pid = String(id).split(":").pop();
      try { return await getAll(`/playlists/${pid}/items`, 100, 50); }
      catch (e) { throw String(e).includes("403") ? "NOT_OWNER" : e; }
    },
    queue: () => get("/me/player/queue"),
    is_liked: async ({ id }) => !!(await get("/me/library/contains", { uris: toUri(id) }))?.[0],
    set_liked: async ({ id, on }) => {
      await api(on ? "PUT" : "DELETE", "/me/library", { uris: toUri(id) });
      forget("/me/library/contains", "/me/tracks");
    },
    top_items: ({ kind, range }) => get(`/me/top/${kind === "artists" ? "artists" : "tracks"}`, { time_range: range, limit: 50 }),
    artist: async ({ id }) => {
      const info = await get(`/artists/${id}`);
      const albums = await get(`/artists/${id}/albums`, { include_groups: "album,single", limit: 40 });
      return { artist: info, albums: albums?.items ?? [] };
    },
    album: ({ id }) => get(`/albums/${id}`),

    sync_plays: async () => mergePlays(await get("/me/player/recently-played", { limit: 50 })),
    play_counts: () => plays.tracks,
    play_history: () => ({ history: plays.history, tracks: plays.tracks }),

    lyrics: async ({ artist, title, album, duration, uri, image }) => {
      const res = await fetchLyrics(artist, title, album, duration).catch(() => null);
      if (uri) { lyricsIndex[uri] = { name: title, artists: artist, image: image ?? "", text: plainText(res) }; saveLyrics(); }
      return res;
    },
    index_lyrics: ({ songs }) => {
      const missing = songs.filter((s) => s.uri && !lyricsIndex[s.uri]);
      (async () => {
        for (const s of missing) {
          let res;
          try { res = await fetchLyrics(s.artist, s.name, s.album, s.duration); }
          catch { await new Promise((r) => setTimeout(r, 60000)); continue; }
          lyricsIndex[s.uri] = { name: s.name, artists: s.artist, image: s.image, text: plainText(res) };
          saveLyrics();
          await new Promise((r) => setTimeout(r, 1500)); // stay well under lrclib's limit
        }
      })();
      return missing.length;
    },
    lyrics_search: ({ query }) => {
      const q = norm(query);
      const entries = Object.entries(lyricsIndex);
      const hits = q.length < 3 ? [] : entries.flatMap(([uri, e]) => {
        const line = e.text.split("\n").find((l) => norm(l).includes(q));
        return line ? [{ uri, name: e.name, artists: e.artists, image: e.image, line: line.trim() }] : [];
      }).slice(0, 30);
      return { hits, indexed: entries.filter(([, e]) => e.text).length };
    },
    translate: async ({ lines, target }) => {
      const out = [], batches = [];
      let batch = [];
      for (const l of lines) {
        if (batch.length && batch.join("\n").length + l.length > 450) { batches.push(batch); batch = []; }
        batch.push(l);
      }
      if (batch.length) batches.push(batch);
      for (const b of batches) {
        const r = await (await fetch("https://api.mymemory.translated.net/get?" + new URLSearchParams({ q: b.join("\n"), langpair: `Autodetect|${target}` }))).json();
        const parts = (r.responseData?.translatedText ?? "").split("\n");
        b.forEach((_, i) => out.push((parts[i] ?? "").trim()));
      }
      return out;
    },

    check_update: () => ({ version: null, current: "web" }),
    report: ({ msg }) => console.info("[aura]", msg),
  };
  // desktop-only: nothing to do in a browser
  for (const c of ["set_material", "set_autostart", "open_spotify", "start_edge_player", "discord_set", "discord_clear",
    "toggle_widget", "show_overlay", "set_song_wallpaper", "restore_wallpaper", "toggle_desk", "desk_hot", "install_update", "start_player"]) {
    commands[c] = () => null;
  }

  async function invoke(cmd, args = {}) {
    const fn = commands[cmd];
    if (!fn) throw `unknown command ${cmd}`;
    try { return await fn(args); } catch (e) { throw typeof e === "string" ? e : String(e?.message ?? e); }
  }

  /* ---------- events between Aura's windows: in the browser it's one page ---------- */
  const listeners = new Map();
  const event = {
    emit: async (name, payload) => (listeners.get(name) ?? []).forEach((f) => f({ payload })),
    emitTo: async (_target, name, payload) => event.emit(name, payload),
    listen: async (name, f) => { listeners.set(name, [...(listeners.get(name) ?? []), f]); return () => {}; },
  };

  /* ---------- window controls map to the browser where they can ---------- */
  const win = {
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    isMaximized: async () => false,
    isFullscreen: async () => !!document.fullscreenElement,
    setFullscreen: async (on) => (on ? document.documentElement.requestFullscreen?.() : document.fullscreenElement && document.exitFullscreen()),
    setSize: async () => {},
    setAlwaysOnTop: async () => {},
    startDragging: async () => {},
  };

  window.__TAURI__ = {
    core: { invoke },
    event,
    window: { getCurrentWindow: () => win, LogicalSize: class { constructor(w, h) { this.width = w; this.height = h; } } },
  };
})();
