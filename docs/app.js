const { invoke } = window.__TAURI__.core;
const win = window.__TAURI__.window.getCurrentWindow();
const { LogicalSize } = window.__TAURI__.window;

const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (ms = 0) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;
const trackUri = (t) => t.uri ?? (String(t.id).startsWith("spotify:") ? t.id : `spotify:track:${t.id}`);
const artists = (t) => (t.artists || []).map((a) => a.name).join(", ");
const durOf = (t) => t.duration_ms ?? t.duration ?? 0;

/* ================= settings ================= */

const DEFAULTS = {
  accentMatch: false, accent: "#ffffff", gradientOn: true, accent2: "#fe9090",
  bgMode: "art", g1: "#0e1118", g2: "#3b4660", angle: 82,
  spotlight: true, spotSize: 226, spotStrength: 56,
  material: "tabbed", blur: 30, panelAlpha: 55, autostart: true, webPlayerBeta: false, edgePlayer: true, fade: true, discord: true, discordId: "1567260633156554803", lyricsOffset: 400, visualizer: true, saverMin: "5",
};
const SWATCHES = ["#22c55e", "#2dd4bf", "#38bdf8", "#6366f1", "#a855f7", "#ec4899", "#f43f5e", "#f97316", "#facc15", "#a3e635", "#ffffff", "#94a3b8"];
const PRESETS = {
  Dusk: ["#3b1d5e", "#d0587e"], Ocean: ["#0f2b46", "#1fa2c9"], Aurora: ["#0f3d3e", "#6d4af0"], Ember: ["#3a1410", "#f0722e"],
  Orchid: ["#2a1446", "#b04ee8"], Mint: ["#0d2b24", "#34d399"], Slate: ["#171c28", "#4b5568"], Candy: ["#5b2a6e", "#e9b27a"],
};

let S = { ...DEFAULTS };
try { Object.assign(S, JSON.parse(localStorage.getItem("prism.settings") || "{}")); } catch {}
let artAccent = null;
// Settings saved before Discord support existed: switch it on with Aura's Discord app.
if (!S.discordId) { S.discordId = DEFAULTS.discordId; S.discord = true; }

function save() { try { localStorage.setItem("prism.settings", JSON.stringify(S)); } catch {} }

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function applySettings() {
  const r = document.documentElement.style;
  const accent = S.accentMatch && artAccent ? artAccent : S.accent;
  r.setProperty("--accent", accent);
  r.setProperty("--accent2", S.accent2);
  r.setProperty("--fill", S.gradientOn ? `linear-gradient(135deg, ${accent}, ${S.accent2})` : accent);
  r.setProperty("--on-accent", luminance(accent) > 0.55 ? "#111" : "#fff");
  r.setProperty("--g1", S.g1);
  r.setProperty("--g2", S.g2);
  r.setProperty("--angle", `${S.angle}deg`);
  r.setProperty("--spot-size", `${S.spotSize}px`);
  r.setProperty("--spot-a", (S.spotStrength / 100) * 0.18);
  r.setProperty("--blur", `${S.blur}px`);
  r.setProperty("--bg-blur", `${20 + S.blur * 2}px`); // album-art background blur follows "Glass blur"
  r.setProperty("--panel", `rgba(30, 34, 48, ${S.panelAlpha / 100})`);
  document.body.classList.toggle("grad", S.gradientOn);
  document.body.classList.toggle("material", S.material !== "solid");
  $("spot").classList.toggle("hidden", !S.spotlight);
  applyBackground();
  syncSettingsUI();
  $$("input[type=range]").forEach(paintRange);
}

function applyBackground() {
  const bg = $("bg");
  bg.className = "";
  bg.style.backgroundImage = "";
  if (S.bgMode === "art" && current.cover) {
    bg.className = "art";
    bg.style.backgroundImage = `url("${current.cover}")`;
  } else if (S.bgMode === "gradient") {
    bg.className = "gradient";
  }
}

function paintRange(el) {
  const p = ((el.value - el.min) / (el.max - el.min)) * 100;
  el.style.setProperty("--p", `${p}%`);
}

function syncSettingsUI() {
  $$("[data-set]").forEach((el) => el.classList.toggle("on", !!S[el.dataset.set]));
  $$("[data-color]").forEach((el) => (el.value = S[el.dataset.color]));
  $$("[data-hex]").forEach((el) => { if (document.activeElement !== el) el.value = S[el.dataset.hex].toUpperCase(); });
  $$("[data-seg]").forEach((seg) => seg.querySelectorAll("button").forEach((b) => b.classList.toggle("sel", b.dataset.v === S[seg.dataset.seg])));
  $$("[data-range]").forEach((el) => (el.value = S[el.dataset.range]));
  $$("[data-out]").forEach((el) => {
    const k = el.dataset.out, v = S[k];
    el.textContent = k === "angle" ? `${v}°` : k === "spotSize" || k === "blur" ? `${v}px`
      : k === "lyricsOffset" ? `${v > 0 ? "+" : ""}${(v / 1000).toFixed(1)} s` : `${v}%`;
  });
  $$("#swatches button").forEach((b) => b.classList.toggle("sel", b.dataset.c.toLowerCase() === S.accent.toLowerCase()));
}

function set(key, value) {
  S[key] = value;
  save();
  applySettings();
  if (key === "material") invoke("set_material", { kind: value }).catch(() => {});
  if (key === "autostart") invoke("set_autostart", { on: value }).catch((e) => toast(`Startup setting failed: ${e}`));
  if (key === "songWallpaper") {
    value ? updateWallpaper(true) : invoke("restore_wallpaper").catch((e) => toast(`Wallpaper: ${e}`));
    invoke("toggle_desk", { show: value }).then(() => value && setTimeout(sendWidget, 800)).catch((e) => toast(`Desktop layer: ${e}`));
  }
}

function buildSettings() {
  $("swatches").innerHTML = SWATCHES.map((c) => `<button data-c="${c}" style="background:${c}"></button>`).join("");
  $("swatches").onclick = (e) => { const c = e.target.dataset.c; if (c) { S.accentMatch = false; set("accent", c); } };
  $("presets").innerHTML = Object.entries(PRESETS)
    .map(([n, [a, b]]) => `<button data-p="${n}" style="background:linear-gradient(135deg,${a},${b})">${n}</button>`).join("");
  $("presets").onclick = (e) => {
    const p = PRESETS[e.target.dataset.p];
    if (p) { S.g1 = p[0]; S.g2 = p[1]; set("bgMode", "gradient"); }
  };
  $$("[data-set]").forEach((el) => {
    const target = el.closest(".switch-label") || el;
    target.onclick = () => set(el.dataset.set, !S[el.dataset.set]);
  });
  $$("[data-color]").forEach((el) => (el.oninput = () => {
    if (el.dataset.color === "accent") S.accentMatch = false;
    set(el.dataset.color, el.value);
  }));
  $$("[data-hex]").forEach((el) => (el.oninput = () => {
    const v = el.value.trim().replace(/^#?/, "#");
    if (/^#[0-9a-f]{6}$/i.test(v)) set(el.dataset.hex, v.toLowerCase());
  }));
  $$("[data-seg]").forEach((seg) => (seg.onclick = (e) => { const v = e.target.dataset.v; if (v) set(seg.dataset.seg, v); }));
  $$("[data-range]").forEach((el) => (el.oninput = () => set(el.dataset.range, +el.value)));

  $("btn-settings").onclick = () => $("settings-backdrop").classList.remove("hidden");
  $("settings-close").onclick = () => $("settings-backdrop").classList.add("hidden");
  $("settings-backdrop").onclick = (e) => { if (e.target.id === "settings-backdrop") e.target.classList.add("hidden"); };
}

/** Average a vivid color out of the album cover for "match album art". */
function extractAccent(url) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 24;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, 24, 24);
      const d = ctx.getImageData(0, 0, 24, 24).data;
      let best = null, bestScore = -1;
      for (let i = 0; i < d.length; i += 4) {
        const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const score = (max - min) * (max / 255);
        if (score > bestScore && max > 70) { bestScore = score; best = [r, g, b]; }
      }
      if (best) {
        artAccent = "#" + best.map((v) => Math.min(255, Math.round(v * 1.15)).toString(16).padStart(2, "0")).join("");
        if (S.accentMatch) applySettings();
      }
    } catch { /* canvas tainted: keep custom accent */ }
  };
  img.src = url;
}

/* ================= spotlight ================= */

document.addEventListener("pointermove", (e) => {
  const r = document.documentElement.style;
  r.setProperty("--mx", `${e.clientX}px`);
  r.setProperty("--my", `${e.clientY}px`);
});

/* ================= window chrome ================= */

$$("[data-win]").forEach((b) => (b.onclick = () => {
  const a = b.dataset.win;
  if (a === "min") win.minimize();
  if (a === "max") win.toggleMaximize();
  if (a === "close") win.close();
}));
$("btn-full").onclick = async () => win.setFullscreen(!(await win.isFullscreen()));
$("toggle-panel").onclick = () => $("app").classList.toggle("no-panel");

let pinned = false;
$("btn-mini").onclick = async () => {
  $("app").classList.add("hidden");
  $("mini").classList.remove("hidden");
  // leave fullscreen/maximized first, otherwise the resize is ignored
  await win.setFullscreen(false).catch(() => {});
  if (await win.isMaximized().catch(() => false)) await win.toggleMaximize();
  await win.setSize(new LogicalSize(320, 460));
};
$("mini-exit").onclick = async () => {
  $("mini").classList.add("hidden");
  $("app").classList.remove("hidden");
  pinned = false;
  $("mini-pin").classList.remove("on");
  await win.setAlwaysOnTop(false);
  await win.setSize(new LogicalSize(1420, 890));
};
$("mini-pin").onclick = async () => {
  pinned = !pinned;
  $("mini-pin").classList.toggle("on", pinned);
  await win.setAlwaysOnTop(pinned);
};

function toast(msg) {
  if (!msg) return;
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), 3500);
}

// Spotify's servers sometimes answer 500/502/503/504 for a moment; trying again almost always works.
const isServerHiccup = (e) => /\b50[0234]\b|Bad Gateway|Service Unavailable|Gateway Timeout/i.test(String(e));
const SERVER_HICCUP = "Spotify's servers didn't answer. Try again in a moment.";

async function call(cmd, args) {
  lastAction = Date.now();
  try {
    return await invoke(cmd, args).catch(async (e) => {
      if (!isServerHiccup(e)) throw e;
      await new Promise((r) => setTimeout(r, 800));
      return invoke(cmd, args);
    });
  } catch (e) {
    const s = String(e);
    toast(/NO_ACTIVE_DEVICE|404|No active device/i.test(s)
      ? "Nothing is playing yet. Press play or pick a song to start."
      : /403/.test(s) ? (reportLog(`spotify refused: ${s}`), "")
      : isServerHiccup(s) ? SERVER_HICCUP : s);
    throw e;
  }
}

/* ================= views ================= */

const navHist = { stack: [], idx: -1 };
let viewTracks = [];

function go(view, push = true) {
  if (!$("lyrics-view").classList.contains("hidden")) showLyrics(false);
  if (push) {
    navHist.stack = navHist.stack.slice(0, navHist.idx + 1);
    navHist.stack.push(view);
    navHist.idx = navHist.stack.length - 1;
  }
  $$("nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === view.kind));
  $$(".pl").forEach((p) => p.classList.toggle("active", view.kind === "playlist" && p.dataset.id === view.id));
  render(view);
  syncNavButtons();
}
function goBack() { if (navHist.idx > 0) go(navHist.stack[--navHist.idx], false); }
function goForward() { if (navHist.idx < navHist.stack.length - 1) go(navHist.stack[++navHist.idx], false); }
function syncNavButtons() {
  $("nav-back").classList.toggle("disabled", navHist.idx <= 0);
  $("nav-fwd").classList.toggle("disabled", navHist.idx >= navHist.stack.length - 1);
}
// Bind on pointerdown as well as click: the title bar is a window-drag region, and on some
// setups the click never arrives for buttons inside it.
for (const [id, fn] of [["nav-back", goBack], ["nav-fwd", goForward], ["toggle-side", () => $("app").classList.toggle("no-side")]]) {
  const b = $(id);
  b.onclick = null;
  b.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    invoke("report", { msg: `ui: ${id} pressed` }).catch(() => {});
    fn();
  });
}
// Mouse side buttons and Alt+arrows navigate too.
document.addEventListener("mouseup", (e) => { if (e.button === 3) goBack(); if (e.button === 4) goForward(); });
document.addEventListener("keydown", (e) => {
  if (e.altKey && e.key === "ArrowLeft") goBack();
  if (e.altKey && e.key === "ArrowRight") goForward();
});
$$("nav a").forEach((a) => (a.onclick = () => go({ kind: a.dataset.view })));
$$("[data-view-btn]").forEach((b) => (b.onclick = () => go({ kind: b.dataset.viewBtn })));

const trackCache = new Map(); // uri -> track, so Up next can show songs added from any list
const normalize = (items) => items.map((i) => i.track ?? i.item ?? i)
  .filter((t) => t && t.name && t.type !== "episode")
  .map((t) => (trackCache.set(trackUri(t), t), t));

async function render(view) {
  const el = $("view");
  el.onclick = null; // a page's own click handler shouldn't leak into the next page
  el.innerHTML = `<div class="empty">Loading…</div>`;
  el.scrollTop = 0;
  try {
    if (view.kind === "home") return renderHome(el);
    if (view.kind === "queue") return renderQueue(el);
    if (view.kind === "stats") return renderStats(el, view.range ?? "short_term");
    if (view.kind === "history") return renderHistory(el);
    if (view.kind === "wrapped") return renderWrapped(el, view.range ?? "week");
    if (view.kind === "artist") return renderArtist(el, view.id);
    if (view.kind === "album") return renderAlbum(el, view.id);
    if (view.kind === "search") {
      const r = await invoke("search", { query: view.q });
      trackView(el, "SEARCH", `“${view.q}”`, normalize(r.tracks?.items || []));
      insertArtistsAlbums(el, r);
      return appendLyricHits(el, view.q);
    }
    const titles = { liked: ["LIBRARY", "Liked Songs"], recent: ["HISTORY", "Recently Played"], top: ["MADE FOR YOU", "Your Top Tracks"] };
    const [eyebrow, title] = view.kind === "playlist" ? ["PLAYLIST", view.name] : titles[view.kind];
    const page = await invoke("library", { kind: view.kind, id: view.id ?? null });
    let tracks = normalize(page.items || []);
    if (view.kind === "recent") {
      const seen = new Set();
      tracks = tracks.filter((t) => !seen.has(t.id) && seen.add(t.id));
    }
    trackView(el, eyebrow, title, tracks);
  } catch (e) {
    if (String(e).includes("NOT_OWNER")) return followedPlaylistView(el, view);
    el.innerHTML = `<div class="empty">${esc(e)}</div>`;
  }
}

/** Followed playlists can be played but Spotify won't let apps list their songs. */
function followedPlaylistView(el, view) {
  viewTracks = [];
  const p = playlistCache.find((x) => x.id === view.id);
  el.innerHTML = `
    <div class="view-head">
      <div class="eyebrow">PLAYLIST · ${esc(p?.owner?.display_name ?? "")}</div><h1>${esc(view.name)}</h1>
      <div class="view-actions"><button class="big-play" id="play-all">${icon("play")}</button></div>
    </div>
    <div class="followed">
      ${p?.images?.[0]?.url ? `<img src="${esc(p.images[0].url)}" alt="">` : ""}
      <p>Spotify only lets apps show the songs in playlists you own. You can still play this one: press play and the songs will show up in the player and the queue.</p>
    </div>`;
  $("play-all").onclick = () => withDevice(() => invoke("play_playlist", { id: view.id })).then(() => setTimeout(refresh, 600));
}

async function renderHome(el) {
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const [recent, top] = await Promise.all([
    invoke("library", { kind: "recent" }).catch(() => ({ items: [] })),
    invoke("library", { kind: "top" }).catch(() => ({ items: [] })),
  ]);
  const tile = (t) => `<div class="tile" data-uri="${esc(trackUri(t))}">
      <img src="${esc(t.album?.images?.[1]?.url ?? t.album?.images?.[0]?.url ?? "")}">
      <b>${esc(t.name)}</b><span>${esc(artists(t))}</span></div>`;
  const dedupe = (list) => { const s = new Set(); return list.filter((t) => !s.has(t.id) && s.add(t.id)); };
  const r = dedupe(normalize(recent.items || [])).slice(0, 12);
  const tp = normalize(top.items || []).slice(0, 12);
  el.innerHTML = `
    <div class="view-head"><div class="eyebrow">HOME</div><h1>${greet}${me?.display_name ? ", " + esc(me.display_name) : ""}</h1></div>
    <h3 class="sub-head">Jump back in</h3><div class="grid" data-list="r">${r.map(tile).join("")}</div>
    <h3 class="sub-head">On repeat</h3><div class="grid" data-list="t">${tp.map(tile).join("")}</div>
    <h3 class="sub-head">Your playlists</h3><div class="grid" id="home-pl">${playlistCache.map((p) =>
      `<div class="tile" data-pl="${esc(p.id)}"><img src="${esc(p.images?.[0]?.url ?? "")}"><b>${esc(p.name)}</b><span>${esc(p.owner?.display_name ?? "")}</span></div>`).join("")}</div>`;
  el.querySelectorAll("[data-list]").forEach((g) => {
    const list = g.dataset.list === "r" ? r : tp;
    g.onclick = (e) => {
      const tile = e.target.closest("[data-uri]");
      if (tile) playList(list, tile.dataset.uri);
    };
  });
  $("home-pl").onclick = (e) => {
    const t = e.target.closest("[data-pl]");
    const p = t && playlistCache.find((x) => x.id === t.dataset.pl);
    if (p) go({ kind: "playlist", id: p.id, name: p.name });
  };
}

let viewIsSearch = false;
function trackView(el, eyebrow, title, tracks) {
  viewTracks = tracks;
  viewIsSearch = eyebrow === "SEARCH";
  el.innerHTML = `
    <div class="view-head">
      <div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1>
      <div class="view-actions">
        <button class="big-play" id="play-all">${icon("play")}</button>
        <label class="filter">${icon("search")}<input id="filter" placeholder="Filter" /></label>
      </div>
    </div>
    ${tracks.length ? `<table class="tracks">
      <thead><tr><th>#</th><th>TITLE</th><th>ALBUM</th><th class="plays-col">PLAYS</th><th>${icon("clock").replace("<svg>", '<svg style="width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2">')}</th></tr></thead>
      <tbody>${tracks.map((t, i) => `
        <tr class="trow" data-uri="${esc(trackUri(t))}" data-name="${esc((t.name + " " + artists(t) + " " + (t.album?.name ?? "")).toLowerCase())}">
          <td class="num"><span>${i + 1}</span></td>
          <td class="title"><div class="t-cell"><img src="${esc(t.album?.images?.at(-1)?.url ?? "")}"><div>
            <b>${t.explicit ? '<span class="explicit">E</span>' : ""}${esc(t.name)}</b><span>${esc(artists(t))}</span></div></div></td>
          <td class="album-cell">${esc(t.album?.name ?? "")}</td>
          <td class="plays-col muted">${playsOf(trackUri(t)) || ""}</td>
          <td class="muted">${fmt(durOf(t))}</td>
        </tr>`).join("")}</tbody></table>` : `<div class="empty">Nothing here yet.</div>`}`;
  $("play-all").onclick = () => tracks.length && playList(tracks, null);
  el.querySelector("tbody")?.addEventListener("click", (e) => {
    const row = e.target.closest("tr.trow");
    // Search results aren't a playlist: play only the clicked song.
    if (row) playList(eyebrow === "SEARCH" ? [{ uri: row.dataset.uri }] : viewTracks, row.dataset.uri);
  });
  $("filter").oninput = (e) => {
    const q = e.target.value.toLowerCase();
    el.querySelectorAll("tr.trow").forEach((r) => r.classList.toggle("hidden", !r.dataset.name.includes(q)));
  };
  markPlaying();
}

function markPlaying() {
  $$("tr.trow").forEach((r) => {
    const on = r.dataset.uri === current.uri;
    r.classList.toggle("playing", on);
    r.classList.toggle("paused", on && !current.playing);
    const num = r.querySelector(".num");
    if (on && !num.querySelector(".eq")) num.innerHTML = `<span><span class="eq"><i></i><i></i><i></i></span></span>`;
    if (!on && num.querySelector(".eq")) num.innerHTML = `<span>${[...r.parentNode.children].indexOf(r) + 1}</span>`;
  });
}

const lastPlay = { uris: [] };
async function playList(tracks, startUri) {
  // Spotify takes a limited list per play request: send the 100 songs starting at the clicked one
  const all = tracks.map(trackUri);
  const from = Math.max(0, startUri ? all.indexOf(startUri) : 0);
  const uris = all.slice(from, from + 100);
  if (startUri && !uris.includes(startUri)) uris.unshift(startUri);
  lastPlay.uris = uris;
  await pickDeviceFor(startUri ?? uris[0]);
  await withFade(() => withDevice(() => invoke("play_uris", { uris, start: startUri })));
  setTimeout(refresh, 500);
}

/* Songs the Edge player has failed on are remembered, so they go straight to the Spotify app
   next time. Everything else goes back to Aura's own player, even after an earlier failure. */
let edgeBad = new Set();
try { edgeBad = new Set(JSON.parse(localStorage.getItem("aura.edgeBad") || "[]")); } catch {}
function markEdgeBad(uri) {
  edgeBad.add(uri);
  try { localStorage.setItem("aura.edgeBad", JSON.stringify([...edgeBad].slice(-2000))); } catch {}
}

/** Before playing: choose Aura's player or the Spotify app for this song. */
async function pickDeviceFor(uri) {
  if (!S.edgePlayer || !uri) return;
  const list = await invoke("devices").catch(() => []);
  const aura = ownDevice(list);
  const app = list.find((d) => d.name !== "Aura");
  const active = list.find((d) => d.is_active);
  if (edgeBad.has(uri)) {
    edgeHandedOff = true; // this song can't play in Aura's player
    if (app && active?.id !== app.id) await invoke("transfer", { deviceId: app.id, play: false }).catch(() => {});
    return;
  }
  edgeHandedOff = false;
  if (aura && active?.id !== aura.id) await invoke("transfer", { deviceId: aura.id, play: false }).catch(() => {});
}

const isNoDevice = (e) => /no active device|NO_ACTIVE_DEVICE|404/i.test(String(e));

/** Runs a playback action; if no device exists, opens the Spotify app and retries on it. */
let lastAction = 0; // when you last did something; Aura checks Spotify more often right after
function pollDelay() {
  // Aura's own player reports changes itself: only check with Spotify now and then
  if (Date.now() - edgeLiveAt < 120000) return 60000;
  if (Date.now() - lastAction < 8000) return 2000;
  if (document.hidden) return 60000;
  if (!current.playing) return 30000;
  const pos = current.pos + (performance.now() - current.at);
  const left = current.dur - pos;
  if (left < 8000) return 2000; // catch the next song starting
  return Math.min(15000, Math.max(2000, left - 6000));
}

async function withDevice(action) {
  lastAction = Date.now();
  try { return await action(); } catch (e) {
    if (isServerHiccup(e)) {
      await new Promise((r) => setTimeout(r, 800));
      try { return await action(); } catch (e2) { if (!isNoDevice(e2)) { playbackError(e2); return; } }
    } else if (!isNoDevice(e)) { playbackError(e); return; }
  }
  // Prefer Aura's own player; only fall back to the Spotify app when it isn't available.
  const own = edgeHandedOff ? null : web.ready ? web.deviceId : ownDevice(await invoke("devices").catch(() => []))?.id;
  if (own) {
    await invoke("transfer", { deviceId: own }).catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    try { return await action(); } catch (e) { if (!isNoDevice(e)) { playbackError(e); return; } }
  }
  toast("Opening Spotify in the background…");
  await invoke("open_spotify").catch(() => {});
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const list = await invoke("devices").catch(() => []);
    const dev = list.find((d) => d.name !== "Aura") ?? ownDevice(list);
    if (!dev) continue;
    await invoke("transfer", { deviceId: dev.id }).catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
    try { await action(); $("toast").classList.add("hidden"); return; } catch (e) { if (!isNoDevice(e)) { playbackError(e); return; } }
  }
  toast("Couldn't find a Spotify device. Open the Spotify app and try again.");
}

/* search: Ctrl K */
let searchTimer;
$("search").oninput = (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q) searchTimer = setTimeout(() => go({ kind: "search", q }), 350);
};
$("search").onkeydown = (e) => {
  const q = e.target.value.trim();
  if (e.key === "Enter" && q) { clearTimeout(searchTimer); go({ kind: "search", q }); }
};
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === "k") { e.preventDefault(); $("search").focus(); $("search").select(); }
  if (e.key === "Escape") { $("settings-backdrop").classList.add("hidden"); showLyrics(false); hideCtx(); }
  shortcuts(e);
  if (e.code === "Space" && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); togglePlay(); }
});

/* ================= sidebar data ================= */

let me = null;
let playlistCache = [];

async function loadSidebar() {
  me = await invoke("me").catch(() => null);
  if (me) {
    $("username").textContent = me.display_name ?? me.id;
    $("avatar").src = me.images?.[0]?.url ?? "";
    // `product` is no longer returned for new development-mode apps (Feb 2026)
    $("acct-info").textContent = [me.display_name ?? me.id, me.product].filter(Boolean).join(" · ");
  }
  const page = await invoke("playlists").catch(() => ({ items: [] }));
  playlistCache = page.items || [];
  $("pl-count").textContent = playlistCache.length;
  $("playlists").innerHTML = playlistCache.map((p) => `
    <div class="pl" data-id="${esc(p.id)}">
      ${p.images?.length ? `<img src="${esc(p.images.at(-1).url)}">` : `<div class="ph"></div>`}
      <div><b>${esc(p.name)}</b><span>${esc(p.owner?.display_name ?? "")}</span></div>
    </div>`).join("");
  $$(".pl").forEach((el) => (el.onclick = () => {
    const p = playlistCache.find((x) => x.id === el.dataset.id);
    go({ kind: "playlist", id: p.id, name: p.name });
  }));
}

$("signout").onclick = async () => {
  await invoke("sign_out").catch(() => {});
  location.reload(); // back to the Connect Spotify screen with a clean state
};
$("logout").onclick = () => $("settings-backdrop").classList.remove("hidden");

/* ================= playback ================= */

const current = { uri: null, id: null, playing: false, pos: 0, dur: 0, cover: null, shuffle: false, repeat: "off", liked: false, at: 0 };
let lyricLines = [];

/*
 * Development-mode apps share one request quota per developer account (July 2026), so poll
 * gently, slow down while the window is hidden, and pause when Spotify says "too many requests".
 */
let pauseUntil = 0;
function backOff(e) {
  const m = String(e).match(/RATE_LIMITED (\d+)/);
  if (!m) return;
  pauseUntil = Date.now() + Math.max(5, +m[1]) * 1000;
  reportLog(`rate limited, pausing ${m[1]}s`);
  showRateLimit(+m[1]);
}

/** A long block (the daily quota ran out) gets a banner saying how long, instead of silence. */
function showRateLimit(secs) {
  if (secs < 120 || $("ratelimit-bar")) return;
  const until = new Date(Date.now() + secs * 1000);
  const bar = document.createElement("div");
  bar.className = "resume-bar";
  bar.id = "ratelimit-bar";
  bar.innerHTML = `<span>⏳ Spotify has paused Aura's requests until <b>${until.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</b>
    (too many requests today). Music already playing keeps going.</span><button class="ic" id="ratelimit-x">${icon("x")}</button>`;
  $("app").append(bar);
  $("ratelimit-x").onclick = () => bar.remove();
  setTimeout(() => bar.remove(), secs * 1000);
}

async function refresh() {
  let ctx;
  if (Date.now() < pauseUntil) return;
  try { ctx = await invoke("now_playing"); } catch (e) { backOff(e); return; }
  if (!ctx || !ctx.item) return;
  const t = ctx.item;
  const uri = trackUri(t);
  current.playing = ctx.is_playing;
  current.pos = ctx.progress_ms ?? ctx.progress ?? 0;
  current.dur = durOf(t);
  current.at = performance.now();
  current.shuffle = ctx.shuffle_state;
  current.repeat = ctx.repeat_state ?? "off";

  if (uri !== current.uri) {
    current.uri = uri;
    current.id = t.id;
    current.cover = t.album?.images?.[0]?.url ?? null;
    onTrackChange(t);
  }
  $$("[data-toggle]").forEach((b) => (b.innerHTML = icon(current.playing ? "pause" : "play")));
  $("shuffle").classList.toggle("on", !!current.shuffle);
  $("repeat").classList.toggle("on", current.repeat !== "off");
  $("repeat").querySelector("i").textContent = current.repeat === "track" ? "1" : "";
  if (ctx.device && document.activeElement !== $("volume")) {
    $("volume").value = ctx.device.volume_percent ?? 50;
    paintRange($("volume"));
  }
  markPlaying();
}

function onTrackChange(t) {
  onTrackChangeExtras(t);
  const sub = `${artists(t)} — ${t.album?.name ?? ""}`;
  $("np-title").textContent = $("pb-title").textContent = $("mini-title").textContent = t.name;
  $("np-sub").textContent = sub;
  $("pb-artist").textContent = $("mini-artist").textContent = artists(t);
  $("lv-title").textContent = t.name;
  $("lv-artist").textContent = artists(t);
  $("lv-bg").style.backgroundImage = current.cover ? `url("${current.cover}")` : "";
  for (const id of ["np-cover", "pb-cover", "mini-cover", "lv-cover"]) $(id).src = current.cover ?? "";
  if (current.cover) extractAccent(current.cover);
  applyBackground();
  invoke("is_liked", { id: String(t.id) }).then((v) => { current.liked = v; $("like").classList.toggle("liked", v); }).catch(() => {});
  loadLyrics(t);
}

/** Smooth progress between polls. */
function tick() {
  const pos = Math.min(current.dur, current.pos + (current.playing ? performance.now() - current.at : 0));
  const pct = current.dur ? (pos / current.dur) * 100 : 0;
  $$("[data-bar]").forEach((b) => (b.style.width = `${pct}%`));
  $$("[data-pos]").forEach((s) => (s.textContent = fmt(pos)));
  $$("[data-dur]").forEach((s) => (s.textContent = fmt(current.dur)));
  // Aura's position estimate trails the audio a little (network delay), so lyrics run early.
  syncLyrics(pos + (S.lyricsOffset ?? 400));
  tickExtras(pos);
  requestAnimationFrame(tick);
}

function togglePlay() {
  current.playing = !current.playing;
  current.pos += 0; current.at = performance.now();
  const action = current.playing ? "play" : "pause";
  withDevice(() => invoke("control", { action })).then(() => setTimeout(refresh, 300));
}
$$("[data-toggle]").forEach((b) => (b.onclick = togglePlay));
$$("[data-act]").forEach((b) => (b.onclick = () => skip(b.dataset.act)));
$$("[data-seek]").forEach((bar) => (bar.onclick = (e) => {
  const r = bar.getBoundingClientRect();
  const ms = Math.round(((e.clientX - r.left) / r.width) * current.dur);
  current.pos = ms; current.at = performance.now();
  call("seek", { ms }).catch(() => {});
}));
$("shuffle").onclick = () => call("shuffle", { on: !current.shuffle }).then(refresh).catch(() => {});
$("repeat").onclick = () => {
  const next = { off: "context", context: "track", track: "off" }[current.repeat] ?? "off";
  call("repeat", { mode: next }).then(refresh).catch(() => {});
};
$("like").onclick = () => {
  if (!current.id) return;
  const on = !current.liked;
  call("set_liked", { id: String(current.id), on }).then(() => { current.liked = on; $("like").classList.toggle("liked", on); }).catch(() => {});
};

let volTimer;
$("volume").oninput = (e) => {
  paintRange(e.target);
  clearTimeout(volTimer);
  volTimer = setTimeout(() => call("set_volume", { percent: +e.target.value }).catch(() => {}), 200);
};

/* devices popover */
$("btn-devices").onclick = async (e) => {
  e.stopPropagation();
  const pop = $("devices");
  if (!pop.classList.toggle("hidden")) {
    pop.innerHTML = `<h4>CONNECT TO A DEVICE</h4><div class="dev"><small>Loading…</small></div>`;
    const all = await invoke("devices").catch(() => []);
    const mine = ownDevice(all);
    // only the live Aura player; older ones linger in Spotify's list for a while after restarts
    const list = all.filter((d) => d.name !== "Aura" || d === mine);
    pop.innerHTML = `<h4>CONNECT TO A DEVICE</h4>` + (list.length
      ? list.map((d) => `<div class="dev ${d.is_active ? "active" : ""}" data-id="${esc(d.id)}">${esc(d === mine ? "Aura (this PC)" : d.name)}<small>${esc(d._type ?? d.type ?? "")}</small></div>`).join("")
      : `<div class="dev"><small>No devices. Open Spotify on your PC or phone.</small></div>`);
    pop.querySelectorAll("[data-id]").forEach((d) => (d.onclick = () =>
      call("transfer", { deviceId: d.dataset.id }).then(() => { pop.classList.add("hidden"); setTimeout(refresh, 600); }).catch(() => {})));
  }
};
document.addEventListener("click", (e) => { if (!e.target.closest(".pop-wrap")) $("devices").classList.add("hidden"); });

/* ================= lyrics ================= */

async function loadLyrics(t) {
  lyricLines = [];
  const boxes = [$("lyrics"), $("mini-lyrics"), $("lv-lyrics")];
  boxes.forEach((b) => (b.innerHTML = ""));
  const uri = current.uri;
  const res = await invoke("lyrics", {
    artist: t.artists?.[0]?.name ?? "", title: t.name, album: t.album?.name ?? "", duration: Math.round(durOf(t) / 1000),
    uri: trackUri(t), image: t.album?.images?.at(-1)?.url ?? "",
  }).catch(() => null);
  if (uri !== current.uri) return;

  if (res?.syncedLyrics) {
    lyricLines = res.syncedLyrics.split("\n").map((l) => {
      const m = l.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/);
      return m && { t: (+m[1] * 60 + +m[2]) * 1000, text: m[3] || "♪" };
    }).filter(Boolean);
  }
  const html = lyricLines.length
    ? lyricLines.map((l, i) => `<p data-i="${i}">${esc(l.text)}</p>`).join("")
    : res?.plainLyrics
      ? res.plainLyrics.split("\n").map((l) => `<p class="past">${esc(l) || "&nbsp;"}</p>`).join("")
      : `<p class="none">${res?.instrumental ? "♪ Instrumental" : "No lyrics found for this track."}</p>`;
  boxes.forEach((b) => {
    b.innerHTML = html;
    b.style.paddingTop = lyricLines.length ? "" : "8px";
    b.onclick = (e) => {
      const i = e.target.dataset?.i;
      if (i != null) { const ms = Math.round(lyricLines[i].t); current.pos = ms; current.at = performance.now(); call("seek", { ms }).catch(() => {}); }
    };
  });
  lastLine = -1;
}

let lastLine = -1;
function syncLyrics(pos) {
  if (!lyricLines.length) return;
  let i = lyricLines.findIndex((l) => l.t > pos + 250) - 1;
  if (i === -2) i = lyricLines.length - 1;
  if (i === lastLine) return;
  lastLine = i;
  for (const box of [$("lyrics"), $("mini-lyrics"), $("lv-lyrics")]) {
    box.querySelectorAll("p").forEach((p, j) => {
      p.classList.toggle("active", j === i);
      p.classList.toggle("past", j < i);
    });
    const el = box.querySelector(`p[data-i="${i}"]`);
    if (el && box.offsetParent) box.scrollTop = el.offsetTop - box.clientHeight * 0.38;
  }
}

/* ================= boot ================= */

function enterApp() {
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  loadSidebar().then(() => go({ kind: "home" }));
  refresh();
  // Ask Spotify what's playing only when something can have changed: the progress bar runs on
  // its own in between. Often right after you act or near a song's end, rarely otherwise.
  let lastPoll = 0;
  setInterval(() => {
    if (Date.now() - lastPoll >= pollDelay()) { lastPoll = Date.now(); refresh(); }
  }, 1000);
  // On the website the browser plays Spotify itself; the desktop app uses a hidden Edge window.
  if (window.AURA_WEB) startWebPlayer();
  else if (S.edgePlayer) startEdgePlayer();
  requestAnimationFrame(tick);
}

$("connect").onclick = async () => {
  $("login-msg").textContent = "Finish signing in in your browser…";
  try {
    const m = await invoke("login");
    if (m.product && m.product !== "premium") toast("Heads up: playback control needs Spotify Premium.");
    enterApp();
  } catch (e) {
    $("login-msg").textContent = String(e);
  }
};

buildSettings();
applySettings();
invoke("set_material", { kind: S.material }).catch(() => {});
invoke("set_autostart", { on: S.autostart }).catch(() => {});
invoke("restore_session").then((ok) => ok && enterApp()).catch(() => {});

/* ================= extras: lyrics view, mute, menu, shortcuts ================= */

function showLyrics(on = $("lyrics-view").classList.contains("hidden")) {
  $("lyrics-view").classList.toggle("hidden", !on);
  $("btn-lyrics").classList.toggle("on", on);
  lastLine = -1; // force a scroll to the current line
}
$("btn-lyrics").onclick = () => showLyrics();
$("lv-close").onclick = () => showLyrics(false);

let volBeforeMute = null;
function toggleMute() {
  const v = $("volume");
  if (volBeforeMute == null) { volBeforeMute = +v.value || 50; v.value = 0; }
  else { v.value = volBeforeMute; volBeforeMute = null; }
  paintRange(v);
  $("btn-mute").classList.toggle("on", volBeforeMute != null);
  $("btn-mute").innerHTML = icon(volBeforeMute != null ? "mute" : "vol");
  call("set_volume", { percent: +v.value }).catch(() => {});
}
$("btn-mute").onclick = toggleMute;

function nudgeVolume(delta) {
  const v = $("volume");
  v.value = Math.max(0, Math.min(100, +v.value + delta));
  v.oninput({ target: v });
}

function seekBy(ms) {
  const pos = Math.max(0, Math.min(current.dur, current.pos + (current.playing ? performance.now() - current.at : 0) + ms));
  current.pos = pos; current.at = performance.now();
  call("seek", { ms: Math.round(pos) }).catch(() => {});
}

function shortcuts(e) {
  if (/INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === "l") showLyrics();
  else if (k === "m") toggleMute();
  else if (k === "s") $("shuffle").click();
  else if (k === "r") $("repeat").click();
  else if (e.key === "ArrowRight") e.ctrlKey ? $$("[data-act=next]")[0].click() : seekBy(5000);
  else if (e.key === "ArrowLeft") e.ctrlKey ? $$("[data-act=prev]")[0].click() : seekBy(-5000);
  else if (e.key === "ArrowUp") { e.preventDefault(); nudgeVolume(5); }
  else if (e.key === "ArrowDown") { e.preventDefault(); nudgeVolume(-5); }
}

/* right-click menu on any track row or tile */
let ctxUri = null;
function hideCtx() { $("ctx").classList.add("hidden"); }
document.addEventListener("contextmenu", (e) => {
  const el = e.target.closest("[data-uri]");
  e.preventDefault();
  if (!el) return hideCtx();
  ctxUri = el.dataset.uri;
  const m = $("ctx");
  m.classList.remove("hidden");
  m.style.left = `${Math.min(e.clientX, innerWidth - m.offsetWidth - 8)}px`;
  m.style.top = `${Math.min(e.clientY, innerHeight - m.offsetHeight - 8)}px`;
});
document.addEventListener("click", (e) => { if (!e.target.closest("#ctx")) hideCtx(); });
$("ctx").onclick = async (e) => {
  const a = e.target.dataset.ctx;
  if (!a || !ctxUri) return;
  hideCtx();
  if (a === "play") playList(viewIsSearch || !viewTracks.length ? [{ uri: ctxUri }] : viewTracks, ctxUri);
  if (a === "queue") call("add_queue", { uri: ctxUri }).then(() => toast("Added to Spotify queue")).catch(() => {});
  if (a === "upnext") addUpNext(ctxUri);
  if (a === "like") call("set_liked", { id: ctxUri, on: true }).then(() => toast("Saved to Liked Songs")).catch(() => {});
  if (a === "copy") {
    const url = `https://open.spotify.com/track/${ctxUri.split(":").pop()}`;
    navigator.clipboard.writeText(url).then(() => toast("Link copied")).catch(() => toast(url));
  }
};

/* Clicking a button leaves it focused, so Space would also "click" it and toggle twice. */
document.addEventListener("mouseup", (e) => { if (e.target.closest("button")) document.activeElement?.blur?.(); });

/* ================= built-in player: Spotify Web Playback SDK ================= */
// Spotify's official in-browser player. It plays audio inside Aura (Widevine DRM in WebView2),
// so the Spotify desktop app is only needed as a fallback.

const web = { player: null, deviceId: null, ready: false };
const reportLog = (m) => invoke("report", { msg: `webplayer: ${m}` }).catch(() => {});

function startWebPlayer() {
  if (web.player) return;
  window.onSpotifyWebPlaybackSDKReady = () => {
    const player = new Spotify.Player({
      name: "Aura",
      getOAuthToken: (cb) => invoke("web_token").then(cb).catch((e) => reportLog(`token error ${e}`)),
      volume: 0.7,
    });
    for (const ev of ["initialization_error", "authentication_error", "account_error"]) {
      player.addListener(ev, ({ message }) => {
        reportLog(`${ev}: ${message}`);
        web.ready = false;
        toast(`Built-in player: ${message}`);
      });
    }
    player.addListener("playback_error", (e) => {
      reportLog(`playback_error on ${web.lastTrack ?? "?"}: ${JSON.stringify(e)}`);
      const now = Date.now();
      web.errors = (web.errors ?? []).filter((t) => now - t < 10000).concat(now);
      if (web.errors.length >= 3) giveUpOnWebPlayer();
      else retryFailedTrack();
    });
    player.addListener("player_state_changed", (st) => {
      const t = st?.track_window?.current_track;
      if (!t) return;
      if (t.uri !== web.lastTrack) reportLog(`now ${t.name} (${t.uri}) paused=${st.paused}`);
      web.lastTrack = t.uri;
    });
    player.addListener("ready", async ({ device_id }) => {
      web.deviceId = device_id; web.ready = true;
      reportLog(`ready ${device_id}`);
      // Become the player if nothing else is playing right now.
      const list = await invoke("devices").catch(() => []);
      if (!list.some((d) => d.is_active)) await invoke("transfer", { deviceId: device_id, play: false }).catch(() => {});
    });
    player.addListener("not_ready", () => { web.ready = false; reportLog("not_ready"); });
    player.connect();
    web.player = player;
  };
  const s = document.createElement("script");
  s.src = "https://sdk.scdn.co/spotify-player.js";
  s.onerror = () => reportLog("sdk script failed to load");
  document.head.append(s);
}

/** Too many failures: drop the web player and hand the same song over to the Spotify app. */
async function giveUpOnWebPlayer() {
  if (!web.player) return;
  const uri = web.firstFailed ?? web.lastTrack;
  reportLog("too many playback errors, switching to the Spotify app");
  clearTimeout(retryTimer);
  web.ready = false;
  web.player.disconnect();
  web.player = null;
  toast("The built-in player can't play right now. Switching to the Spotify app…");
  const uris = lastPlay.uris.length ? lastPlay.uris : uri ? [uri] : [];
  if (uris.length) await withDevice(() => invoke("play_uris", { uris, start: uri && uris.includes(uri) ? uri : null }));
  else await withDevice(() => invoke("control", { action: "play" }));
}

/**
 * When a song fails, Spotify jumps to the next one. Failures come in bursts while the DRM
 * module warms up, so instead go back and replay the failed song (a few tries per song).
 */
const retries = new Map();
let retryTimer = null;
function retryFailedTrack() {
  const uri = web.lastTrack;
  if (!uri) return;
  const n = (retries.get(uri) ?? 0) + 1;
  retries.set(uri, n);
  if (n > 3) { reportLog(`giving up on ${uri}`); return; }
  clearTimeout(retryTimer);
  retryTimer = setTimeout(async () => {
    if (!lastPlay.uris.includes(uri)) return;
    reportLog(`retry ${n} for ${uri}`);
    await invoke("play_uris", { uris: lastPlay.uris, start: uri }).catch(() => {});
  }, 400 * n);
}

// Browsers only let audio start after a user gesture; unlock the SDK on the first click/key.
const unlockAudio = () => web.player?.activateElement?.();
document.addEventListener("pointerdown", unlockAudio);
document.addEventListener("keydown", unlockAudio);

/* ================= built-in player via hidden Edge window ================= */

/** Starts the off-screen Edge player and makes it the active device if nothing else plays. */
async function startEdgePlayer() {
  try { await invoke("start_edge_player"); } catch (e) { reportLog(`edge start failed: ${e}`); toast(`Built-in player: ${e}`); return; }
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const list = await invoke("devices").catch(() => []);
    // Don't take over playback here: loading a song this early fails while Edge warms up.
    // Aura switches to the built-in player when you press play (see withDevice).
    if (list.some((d) => d.name === "Aura")) return;
  }
  reportLog("edge player never showed up as a device");
}

/* ================= play counts ================= */
// Spotify has no play-count API. Aura syncs "recently played" (last 50 plays, all devices)
// into its own tally, so counts start from when Aura was first used.

let playCounts = {};
const playsOf = (uri) => playCounts[uri]?.count ?? 0;

async function loadCounts() {
  await invoke("sync_plays").catch((e) => backOff(e));
  playCounts = (await invoke("play_counts").catch(() => null)) ?? playCounts;
  checkMilestones();
  if (current.uri) showPlays(current.uri);
  $$("tr.trow").forEach((r) => {
    const cell = r.querySelector(".plays-col");
    if (cell) cell.textContent = playsOf(r.dataset.uri) || "";
  });
}
function showPlays(uri) {
  const n = playsOf(uri);
  $("np-plays").textContent = n ? `Played ${n} ${n === 1 ? "time" : "times"}` : "";
}
setTimeout(loadCounts, 3000);
setInterval(loadCounts, 5 * 60 * 1000);

/* ================= stats ================= */

const RANGES = { short_term: "4 weeks", medium_term: "6 months", long_term: "All time" };

async function renderStats(el, range) {
  const [artistsRes, tracksRes] = await Promise.all([
    invoke("top_items", { kind: "artists", range }).catch(() => ({ items: [] })),
    invoke("top_items", { kind: "tracks", range }).catch(() => ({ items: [] })),
  ]);
  const topArtists = (artistsRes.items || []).slice(0, 12);
  const topTracks = normalize(tracksRes.items || []);
  const counted = Object.entries(playCounts).sort((a, b) => b[1].count - a[1].count).slice(0, 25);
  const total = Object.values(playCounts).reduce((s, t) => s + t.count, 0);

  el.innerHTML = `
    <div class="view-head">
      <div class="eyebrow">YOUR LISTENING</div><h1>Stats</h1>
      <div class="seg stats-tabs">${Object.entries(RANGES).map(([k, v]) =>
        `<button data-range="${k}" class="${k === range ? "sel" : ""}">${v}</button>`).join("")}</div>
    </div>
    <h3 class="sub-head">Top artists</h3>
    <div class="grid artists">${topArtists.map((a, i) => `
      <div class="tile artist"><img src="${esc(a.images?.[1]?.url ?? a.images?.[0]?.url ?? "")}">
        <b>${i + 1}. ${esc(a.name)}</b><span>${esc((a.genres || []).slice(0, 2).join(", "))}</span></div>`).join("") || `<div class="empty">No data yet.</div>`}
    </div>
    <h3 class="sub-head">Most played <small class="muted">· counted by Aura · ${total} plays</small></h3>
    <div class="counted">${counted.map(([uri, t], i) => `
      <div class="crow" data-uri="${esc(uri)}">
        <span class="rank">${i + 1}</span><img src="${esc(t.image)}">
        <div><b>${esc(t.name)}</b><span>${esc(t.artists)}</span></div>
        <span class="count">${t.count}×</span>
      </div>`).join("") || `<div class="empty">Aura starts counting from now. Listen for a while and your most played songs show up here.</div>`}
    </div>
    <div id="stats-songs"></div>`;
  el.querySelector(".stats-tabs").onclick = (e) => {
    const r = e.target.dataset.range;
    if (r) go({ kind: "stats", range: r });
  };
  el.querySelector(".counted").onclick = (e) => {
    const row = e.target.closest("[data-uri]");
    if (row) playList(counted.map(([uri]) => ({ uri })), row.dataset.uri);
  };
  trackView($("stats-songs"), `TOP SONGS · ${RANGES[range].toUpperCase()}`, "Top songs", topTracks);
}

/* ================= sleep timer ================= */

const sleep = { at: 0, endOfSong: false };
$("btn-sleep").onclick = (e) => { e.stopPropagation(); $("sleep-menu").classList.toggle("hidden"); };
$("sleep-menu").onclick = (e) => {
  const v = e.target.dataset.sleep;
  if (!v) return;
  $("sleep-menu").classList.add("hidden");
  sleep.at = 0; sleep.endOfSong = false;
  if (v === "end") sleep.endOfSong = true;
  else if (v !== "off") { sleep.at = Date.now() + +v * 60000; sleep.startVol = +$("volume").value || 50; }
  toast(v === "off" ? "Sleep timer off" : v === "end" ? "Pausing at the end of this song" : `Pausing in ${v} minutes`);
  updateSleepBadge();
};
document.addEventListener("click", (e) => { if (!e.target.closest("#btn-sleep, #sleep-menu")) $("sleep-menu").classList.add("hidden"); });
function updateSleepBadge() {
  const on = sleep.at || sleep.endOfSong;
  $("btn-sleep").classList.toggle("on", !!on);
  $("btn-sleep").querySelector(".sleep-left").textContent =
    sleep.endOfSong ? "1" : sleep.at ? Math.max(1, Math.ceil((sleep.at - Date.now()) / 60000)) : "";
}
async function sleepNow() {
  const vol = sleep.startVol || +$("volume").value || 50;
  sleep.at = 0; sleep.endOfSong = false; sleep.startVol = 0;
  updateSleepBadge();
  await fadeVolume(+$("volume").value, 0, 3000);
  // remember where you fell asleep, so you can pick up from there next time
  const pos = Math.max(0, current.pos + (performance.now() - current.at) - 15000);
  try {
    localStorage.setItem("aura.resume", JSON.stringify({
      uri: current.uri, pos, title: $("pb-title").textContent, artist: $("pb-artist").textContent,
      uris: lastPlay.uris.includes(current.uri) ? lastPlay.uris : [current.uri], at: Date.now(),
    }));
  } catch {}
  await invoke("control", { action: "pause" }).catch(() => {});
  await setVol(vol); // so tomorrow doesn't start silent
  $("volume").value = vol; paintRange($("volume"));
  toast("Sleep timer: paused. Good night");
}

/** Smart sleep: lower the volume gradually over the last 10 minutes of the timer. */
let lastSleepStep = 0;
function smartSleepFade() {
  const left = sleep.at - Date.now();
  const span = 10 * 60000;
  if (left > span || Date.now() - lastSleepStep < 20000) return;
  lastSleepStep = Date.now();
  const target = Math.max(3, Math.round((sleep.startVol || 50) * (left / span)));
  if (Math.abs(target - +$("volume").value) >= 2) {
    $("volume").value = target; paintRange($("volume"));
    setVol(target);
  }
}
setInterval(updateSleepBadge, 30000);

/* ================= fade between songs ================= */

let fading = false;
const setVol = (v) => invoke("set_volume", { percent: Math.round(v) }).catch(() => {});
async function fadeVolume(from, to, ms) {
  const steps = 3; // each step is a Spotify request
  for (let i = 1; i <= steps; i++) {
    await setVol(from + ((to - from) * i) / steps);
    await new Promise((r) => setTimeout(r, ms / steps));
  }
}
/** Fades out, runs the action (skip / play), then fades back in. */
async function withFade(action) {
  if (!S.fade || !current.playing || fading) return action();
  fading = true;
  const vol = +$("volume").value || 50;
  try {
    await fadeVolume(vol, 0, 700);
    await action();
    await new Promise((r) => setTimeout(r, 600));
    await fadeVolume(0, vol, 900);
  } finally { fading = false; }
}

/* ================= Up next (Aura's own queue) ================= */
// Spotify's API can only add to its queue, not remove or reorder. Aura keeps its own list and
// plays the next song from it when the current one ends (or when you press Next).

let upNext = [];
try { upNext = JSON.parse(localStorage.getItem("aura.upnext") || "[]"); } catch {}
const saveUpNext = () => { try { localStorage.setItem("aura.upnext", JSON.stringify(upNext)); } catch {} };
const onQueuePage = () => navHist.stack[navHist.idx]?.kind === "queue";

function addUpNext(uri) {
  const t = trackCache.get(uri);
  upNext.push({ uri, name: t?.name ?? "Song", artists: t ? artists(t) : "", image: t?.album?.images?.at(-1)?.url ?? "" });
  saveUpNext();
  toast(`Added to Up next (${upNext.length})`);
  if (onQueuePage()) renderQueue($("view"));
}

async function playNextFromUpNext() {
  const n = upNext.shift();
  saveUpNext();
  if (onQueuePage()) renderQueue($("view"));
  await pickDeviceFor(n.uri);
  await withFade(() => withDevice(() => invoke("play_uris", { uris: [n.uri], start: n.uri })));
  setTimeout(refresh, 500);
}

async function skip(action) {
  if (action === "next" && upNext.length) return playNextFromUpNext();
  await withFade(() => withDevice(() => invoke("control", { action })));
  setTimeout(refresh, 400);
}

async function renderQueue(el) {
  const q = await invoke("queue").catch(() => ({ queue: [] }));
  const spotifyNext = normalize(q.queue || []).slice(0, 30);
  const row = (t, i, own) => `
    <div class="qrow" data-uri="${esc(t.uri ?? trackUri(t))}" data-i="${i}">
      <img src="${esc(own ? t.image : t.album?.images?.at(-1)?.url ?? "")}">
      <div><b>${esc(t.name)}</b><span>${esc(own ? t.artists : artists(t))}</span></div>
      ${own ? `<span class="qbtns">
        <button class="ic" data-q="up" title="Move up">${icon("up")}</button>
        <button class="ic" data-q="down" title="Move down">${icon("down")}</button>
        <button class="ic" data-q="remove" title="Remove">${icon("x")}</button></span>` : ""}
    </div>`;
  el.innerHTML = `
    <div class="view-head"><div class="eyebrow">PLAYING NEXT</div><h1>Queue</h1></div>
    <h3 class="sub-head">Up next <small class="muted">· ${upNext.length} songs · drag or use the arrows to reorder</small></h3>
    <div class="qlist" id="upnext-list">${upNext.map((t, i) => row(t, i, true)).join("") ||
      `<div class="empty">Right-click any song and choose <b>Add to Up next</b>.</div>`}</div>
    ${upNext.length ? `<div class="qactions"><button class="pill" id="upnext-clear">Clear Up next</button></div>` : ""}
    <h3 class="sub-head">Then from Spotify</h3>
    <div class="qlist" id="spotify-next">${spotifyNext.map((t, i) => row(t, i, false)).join("") || `<div class="empty">Nothing queued in Spotify.</div>`}</div>`;

  const list = $("upnext-list");
  list.onclick = (e) => {
    const r = e.target.closest(".qrow");
    if (!r) return;
    const i = +r.dataset.i, act = e.target.closest("[data-q]")?.dataset.q;
    if (act === "remove") upNext.splice(i, 1);
    else if (act === "up" && i > 0) [upNext[i - 1], upNext[i]] = [upNext[i], upNext[i - 1]];
    else if (act === "down" && i < upNext.length - 1) [upNext[i + 1], upNext[i]] = [upNext[i], upNext[i + 1]];
    else if (!act) { upNext.unshift(...upNext.splice(i, 1)); return playNextFromUpNext(); }
    saveUpNext();
    renderQueue(el);
  };
  // drag to reorder
  list.querySelectorAll(".qrow").forEach((r) => {
    r.draggable = true;
    r.ondragstart = (e) => { e.dataTransfer.setData("text/plain", r.dataset.i); r.classList.add("dragging"); };
    r.ondragend = () => r.classList.remove("dragging");
    r.ondragover = (e) => e.preventDefault();
    r.ondrop = (e) => {
      e.preventDefault();
      const from = +e.dataTransfer.getData("text/plain"), to = +r.dataset.i;
      if (from === to) return;
      upNext.splice(to, 0, ...upNext.splice(from, 1));
      saveUpNext();
      renderQueue(el);
    };
  });
  $("upnext-clear")?.addEventListener("click", () => { upNext = []; saveUpNext(); renderQueue(el); });
  $("spotify-next").querySelectorAll(".qrow").forEach((r) => (r.onclick = () => playList(spotifyNext, r.dataset.uri)));
}

/* ================= Discord status ================= */

$("discord-id").value = S.discordId;
$("discord-id").oninput = (e) => { S.discordId = e.target.value.trim(); save(); updateDiscord(); };
let discordWasPlaying = null, discordError = "";
function updateDiscord() {
  if (!S.discord || !S.discordId || !current.uri || !current.playing) { invoke("discord_clear").catch(() => {}); return; }
  const start = Date.now() - current.pos - (performance.now() - current.at);
  invoke("discord_set", {
    appId: S.discordId,
    title: $("pb-title").textContent, artist: $("pb-artist").textContent,
    album: $("np-sub").textContent.split(" — ")[1] ?? "", image: current.cover ?? "aura",
    startMs: Math.round(start), endMs: Math.round(start + current.dur),
  }).then(() => { discordError = ""; }).catch((e) => {
    if (String(e) !== discordError) { discordError = String(e); toast(`Discord: ${e}`); }
  });
}

/* ================= hooks called from the player ================= */

const ends = { fadedFor: null, advancedFor: null, restoreVol: null };

function onTrackChangeExtras(t) {
  showPlays(trackUri(t));
  setTimeout(updateDiscord, 300);
  // the song that just finished shows up in "recently played"; at most every 2 minutes
  if (Date.now() - (onTrackChangeExtras.lastSync ?? 0) > 120000) {
    onTrackChangeExtras.lastSync = Date.now();
    setTimeout(loadCounts, 8000);
  }
  if (ends.restoreVol != null) {
    const v = ends.restoreVol;
    ends.restoreVol = null;
    setTimeout(() => fadeVolume(0, v, 1200), 400);
  }
}

function tickExtras(pos) {
  const left = current.dur - pos;
  if (current.playing !== discordWasPlaying) { discordWasPlaying = current.playing; updateDiscord(); }
  if (!current.playing || !current.dur) return;

  if (sleep.at && Date.now() >= sleep.at) { sleepNow(); return; }
  if (sleep.at) smartSleepFade();
  if (sleep.endOfSong && left < 1200 && ends.advancedFor !== current.uri) {
    ends.advancedFor = current.uri;
    sleep.endOfSong = false; updateSleepBadge();
    invoke("control", { action: "pause" }).then(() => toast("Sleep timer: paused. Good night")).catch(() => {});
    return;
  }
  // fade out the last seconds of a song; onTrackChangeExtras fades the next one in
  if (S.fade && !fading && current.dur > 15000 && left < 2600 && left > 300 && ends.fadedFor !== current.uri) {
    ends.fadedFor = current.uri;
    ends.restoreVol = +$("volume").value || 50;
    fadeVolume(ends.restoreVol, 0, 2200);
  }
  // play from Up next instead of letting Spotify continue
  if (upNext.length && left < 1200 && ends.advancedFor !== current.uri) {
    ends.advancedFor = current.uri;
    const n = upNext.shift();
    saveUpNext();
    withDevice(() => invoke("play_uris", { uris: [n.uri], start: n.uri })).then(() => setTimeout(refresh, 500));
  }
}

/* Title-bar buttons react on press: the bar is a window-drag region, and on some setups a
   plain click never reaches buttons inside it. */
for (const b of $$("header.titlebar button")) {
  const handler = b.onclick;
  if (!handler) continue;
  b.onclick = null;
  b.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; e.stopPropagation(); handler.call(b, e); });
}

/* ================= history: timeline, streaks, this day last year ================= */

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayLabel = (key) => {
  const today = dayKey(new Date()), y = new Date(); y.setDate(y.getDate() - 1);
  if (key === today) return "Today";
  if (key === dayKey(y)) return "Yesterday";
  return new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
};

/** Current and longest run of consecutive days with at least one play. */
function streaks(days) {
  const set = new Set(days);
  let longest = 0, run = 0, prev = null;
  for (const k of [...set].sort()) {
    const d = new Date(`${k}T12:00:00`);
    run = prev && (d - prev) / 86400000 === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  let current = 0;
  const d = new Date();
  if (!set.has(dayKey(d))) d.setDate(d.getDate() - 1); // today not started yet still counts
  while (set.has(dayKey(d))) { current++; d.setDate(d.getDate() - 1); }
  return { current, longest };
}

async function renderHistory(el) {
  await loadCounts();
  const { history = [], tracks = {} } = (await invoke("play_history").catch(() => null)) ?? {};
  const plays = history.map((p) => ({ ...p, date: new Date(p.at), t: tracks[p.uri] ?? { name: "Unknown", artists: "", image: "" } }))
    .sort((a, b) => b.date - a.date);
  const byDay = new Map();
  for (const p of plays) {
    const k = dayKey(p.date);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(p);
  }
  const s = streaks([...byDay.keys()]);
  const now = new Date();
  const lastYears = plays.filter((p) => p.date.getMonth() === now.getMonth() && p.date.getDate() === now.getDate() && p.date.getFullYear() < now.getFullYear());
  const first = plays.at(-1)?.date;
  const nextYear = new Date(now); nextYear.setFullYear(now.getFullYear() + 1);

  const row = (p) => `
    <div class="crow" data-uri="${esc(p.uri)}">
      <span class="time">${p.date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
      <img src="${esc(p.t.image)}"><div><b>${esc(p.t.name)}</b><span>${esc(p.t.artists)}</span></div>
      <span class="count muted">${playsOf(p.uri)}×</span>
    </div>`;

  el.innerHTML = `
    <div class="view-head"><div class="eyebrow">YOUR LISTENING</div><h1>History</h1></div>
    <div class="stat-cards">
      <div class="stat"><b>${plays.length}</b><span>plays recorded</span></div>
      <div class="stat"><b>${byDay.size}</b><span>days listened</span></div>
      <div class="stat"><b>${s.current}🔥</b><span>day streak</span></div>
      <div class="stat"><b>${s.longest}</b><span>longest streak</span></div>
    </div>
    <h3 class="sub-head">This day last year</h3>
    <div class="counted">${lastYears.length ? lastYears.map(row).join("") :
      `<div class="empty">Nothing yet. Aura started recording ${first ? `on ${first.toLocaleDateString()}` : "today"}, so check back on ${nextYear.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}.</div>`}</div>
    ${[...byDay.entries()].map(([k, list]) => `
      <h3 class="sub-head">${dayLabel(k)} <small class="muted">· ${list.length} plays</small></h3>
      <div class="counted">${list.map(row).join("")}</div>`).join("") ||
      `<div class="empty">No plays recorded yet. Aura syncs your listening every few minutes.</div>`}`;
  el.onclick = (e) => {
    const r = e.target.closest(".crow[data-uri]");
    if (r) playList([{ uri: r.dataset.uri }], r.dataset.uri);
  };
}

/* ================= lyrics: karaoke, translation, search ================= */

S.karaoke ??= false;
S.translateTo ??= "";
function syncLangMenu() {
  const sel = $("lv-lang-menu").querySelector(`[data-lang="${S.translateTo}"]`);
  $("lv-lang-label").textContent = S.translateTo ? sel?.firstChild.textContent.trim() ?? S.translateTo : "Translate";
  $("lv-lang").classList.toggle("accent", !!S.translateTo);
  $("lv-lang-menu").querySelectorAll("[data-lang]").forEach((d) => d.classList.toggle("active", d.dataset.lang === S.translateTo));
}
syncLangMenu();
$("lv-lang").onclick = (e) => { e.stopPropagation(); $("lv-lang-menu").classList.toggle("hidden"); };
document.addEventListener("click", (e) => { if (!e.target.closest(".lang-wrap")) $("lv-lang-menu").classList.add("hidden"); });
function applyLyricsPrefs() {
  document.body.classList.toggle("karaoke", !!S.karaoke);
  $("lv-karaoke").classList.toggle("accent", !!S.karaoke);
}
applyLyricsPrefs();
$("lv-karaoke").onclick = () => { S.karaoke = !S.karaoke; save(); applyLyricsPrefs(); };
$("lv-lang-menu").onclick = (e) => {
  const item = e.target.closest("[data-lang]");
  if (!item) return;
  $("lv-lang-menu").classList.add("hidden");
  S.translateTo = item.dataset.lang; save();
  syncLangMenu();
  translatedFor = null;
  $$(".tr").forEach((x) => x.remove());
  if (S.translateTo) translateLyrics();
};

/** Karaoke: fill the active line from left to right as it's sung. */
function karaokeTick(pos) {
  if (!S.karaoke || !lyricLines.length || lastLine < 0) return;
  const line = lyricLines[lastLine], next = lyricLines[lastLine + 1];
  const end = next ? next.t : line.t + 4000;
  const k = Math.max(0, Math.min(1, (pos - line.t) / Math.max(400, end - line.t)));
  for (const box of [$("lyrics"), $("mini-lyrics"), $("lv-lyrics")]) {
    box.querySelector(`p[data-i="${lastLine}"]`)?.style.setProperty("--k", `${(k * 100).toFixed(1)}%`);
  }
}

/** Shows a translation under each lyric line. */
let translatedFor = null;
async function translateLyrics() {
  const uri = current.uri;
  const box = $("lv-lyrics");
  const ps = [...box.querySelectorAll("p")].filter((p) => !p.classList.contains("none"));
  const lines = ps.map((p) => p.firstChild?.textContent?.trim() ?? "").filter(Boolean);
  if (!lines.length) return;
  translatedFor = uri;
  const target = S.translateTo;
  const unique = [...new Set(lines)];
  const out = await invoke("translate", { lines: unique, target }).catch((e) => { toast(`Translation failed: ${e}`); return null; });
  // the song or the language may have changed (or translation been switched off) meanwhile
  if (!out || uri !== current.uri || translatedFor !== uri || S.translateTo !== target) return;
  const map = new Map(unique.map((l, i) => [l, out[i]]));
  for (const b of [$("lyrics"), $("mini-lyrics"), $("lv-lyrics")]) {
    b.querySelectorAll(".tr").forEach((x) => x.remove());
    b.querySelectorAll("p").forEach((p) => {
      const src = p.firstChild?.textContent?.trim();
      const tr = src && map.get(src);
      if (tr && tr.toLowerCase() !== src.toLowerCase()) p.insertAdjacentHTML("beforeend", `<small class="tr">${esc(tr)}</small>`);
    });
  }
}
// translate after each song's lyrics load
const loadLyricsBase = loadLyrics;
loadLyrics = async (t) => {
  await loadLyricsBase(t);
  if (S.translateTo) translateLyrics();
  sendWidget();
};

/** "Found in lyrics" section under search results, from Aura's local lyrics index. */
async function appendLyricHits(el, q) {
  const r = await invoke("lyrics_search", { query: q }).catch(() => null);
  if (!r) return;
  const hits = r.hits || [];
  const html = `
    <h3 class="sub-head">Found in lyrics <small class="muted">· searched ${r.indexed} of your songs</small></h3>
    <div class="counted lyric-hits">${hits.map((h) => `
      <div class="crow" data-uri="${esc(h.uri)}"><img src="${esc(h.image)}">
        <div><b>${esc(h.name)}</b><span>${esc(h.artists)}</span><span class="hit">“${esc(h.line)}”</span></div></div>`).join("") ||
      `<div class="empty">No lyric matches in your songs yet. Aura is still building its lyrics index in the background.</div>`}</div>`;
  el.insertAdjacentHTML("beforeend", html);
  el.querySelector(".lyric-hits").onclick = (e) => {
    const row = e.target.closest("[data-uri]");
    if (row) playList([{ uri: row.dataset.uri }], row.dataset.uri);
  };
}

/** Builds the lyrics index from your library in the background (once per start). */
async function indexLibrary() {
  const kinds = ["liked", "recent", "top"];
  const pages = await Promise.all(kinds.map((kind) => invoke("library", { kind }).catch(() => ({ items: [] }))));
  const seen = new Set();
  const songs = pages.flatMap((p) => normalize(p.items || [])).filter((t) => !seen.has(trackUri(t)) && seen.add(trackUri(t)))
    .map((t) => ({
      uri: trackUri(t), name: t.name, artist: t.artists?.[0]?.name ?? "", album: t.album?.name ?? "",
      duration: Math.round(durOf(t) / 1000), image: t.album?.images?.at(-1)?.url ?? "",
    }));
  const n = await invoke("index_lyrics", { songs }).catch(() => 0);
  reportLog(`lyrics index: fetching ${n} new songs`);
}
setTimeout(() => { if (!$("app").classList.contains("hidden")) indexLibrary(); }, 20000);

/* ================= smart sleep: resume where you fell asleep ================= */

function offerResume() {
  let r = null;
  try { r = JSON.parse(localStorage.getItem("aura.resume") || "null"); } catch {}
  if (!r || Date.now() - r.at > 7 * 86400000) return;
  const bar = document.createElement("div");
  bar.className = "resume-bar";
  bar.innerHTML = `<span>🌙 You fell asleep to <b>${esc(r.title)}</b> · ${esc(r.artist)} at ${fmt(r.pos)}</span>
    <button class="pill accent" id="resume-go">Resume</button><button class="ic" id="resume-x">${icon("x")}</button>`;
  $("app").append(bar);
  const done = () => { bar.remove(); try { localStorage.removeItem("aura.resume"); } catch {} };
  $("resume-x").onclick = done;
  $("resume-go").onclick = async () => {
    done();
    lastPlay.uris = r.uris;
    await withDevice(() => invoke("play_uris", { uris: r.uris, start: r.uri }));
    setTimeout(() => invoke("seek", { ms: Math.round(r.pos) }).catch(() => {}), 1200);
    setTimeout(refresh, 1800);
  };
}
setTimeout(() => { if (!$("app").classList.contains("hidden")) offerResume(); }, 4000);

/* ================= desktop widget ================= */

const { emit, listen } = window.__TAURI__.event;
S.widget ??= false;
function sendWidget() {
  if (!S.widget && !S.songWallpaper) return; // the widget and the desktop layer both listen
  const line = lastLine >= 0 ? lyricLines[lastLine]?.text : "";
  emit("aura-np", {
    title: $("pb-title").textContent, artist: $("pb-artist").textContent, cover: current.cover,
    playing: current.playing, line: line || "", next: lyricLines[lastLine + 1]?.text ?? "",
    accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
  }).catch(() => {});
}
async function setWidget(on) {
  S.widget = on; save();
  $("btn-widget").classList.toggle("on", on);
  await invoke("toggle_widget", { show: on }).catch((e) => toast(`Widget: ${e}`));
  if (on) setTimeout(sendWidget, 800);
}
$("btn-widget").addEventListener("pointerdown", (e) => { e.stopPropagation(); setWidget(!S.widget); });
listen("aura-widget-ready", () => sendWidget());
listen("aura-widget-action", (e) => {
  const a = e.payload;
  if (a === "toggle") togglePlay();
  else if (a === "next" || a === "prev") skip(a);
  else if (a === "close") setWidget(false);
});
if (S.widget) setTimeout(() => setWidget(true), 3000);
if (S.songWallpaper) setTimeout(() => invoke("toggle_desk", { show: true }).catch(() => {}), 3000);

// keep the widget in step with lyrics and play/pause
let widgetLine = -2, widgetPlaying = null;
const tickExtrasBase = tickExtras;
tickExtras = (pos) => {
  tickExtrasBase(pos);
  karaokeTick(pos + (S.lyricsOffset ?? 400));
  if ((S.widget || S.songWallpaper) && (lastLine !== widgetLine || current.playing !== widgetPlaying)) {
    widgetLine = lastLine; widgetPlaying = current.playing;
    sendWidget();
  }
};

/* ================= quieter playback errors ================= */

/** Spotify answers 403 "restriction violated" for harmless things (play while already playing,
 *  previous on the first song). Log those; only show real problems. */
function playbackError(e) {
  const s = String(e);
  if (/403/.test(s)) { reportLog(`spotify refused: ${s}`); return; }
  if (isServerHiccup(s)) { reportLog(`spotify server error: ${s}`); toast(SERVER_HICCUP); return; }
  toast(s);
}

// When the Edge player can't play a song, continue that song in the Spotify app (opened in the
// background if needed) and stay there for this session, instead of skipping through songs.
// The first failure of a song gets one retry on the built-in player (failures are often
// temporary while Edge's DRM warms up); a second failure moves playback to the Spotify app.
let edgeHandedOff = false, edgeRetry = { uri: null, at: 0 }, edgeBusy = false;
listen("edge-player", async ({ payload }) => {
  const m = String(payload).match(/^failed (spotify:track:\w+)/);
  if (!m || edgeHandedOff || edgeBusy) return;
  edgeBusy = true;
  try {
    const uri = m[1];
    const uris = lastPlay.uris.includes(uri) ? lastPlay.uris : [uri];
    // known-bad songs don't get a retry; first-time failures do (they're often temporary)
    const retrying = !edgeBad.has(uri) && !(edgeRetry.uri === uri && Date.now() - edgeRetry.at < 60000);
    if (retrying) {
      edgeRetry = { uri, at: Date.now() };
      reportLog(`retrying ${uri} on the built-in player`);
      await new Promise((r) => setTimeout(r, 3000));
      const aura = ownDevice(await invoke("devices").catch(() => []));
      if (aura) { await invoke("transfer", { deviceId: aura.id, play: false }).catch(() => {}); }
      await invoke("play_uris", { uris, start: uri }).catch(() => {});
      return;
    }
    edgeHandedOff = true;
    markEdgeBad(uri);
    toast("The built-in player couldn't play this song. Continuing in the Spotify app…");
    const app = (await invoke("devices").catch(() => [])).find((d) => d.name !== "Aura");
    if (app) await invoke("transfer", { deviceId: app.id, play: false }).catch(() => {});
    await withDevice(() => invoke("play_uris", { uris, start: uri }));
    setTimeout(refresh, 800);
  } finally {
    setTimeout(() => { edgeBusy = false; }, 4000);
  }
});

/* ================= artists and albums ================= */

const imgOf = (images, i = 1) => images?.[i]?.url ?? images?.[0]?.url ?? "";
const yearOf = (a) => (a.release_date || "").slice(0, 4);

function artistTile(a) {
  return `<div class="tile artist" data-artist="${esc(a.id)}"><img src="${esc(imgOf(a.images))}">
    <b>${esc(a.name)}</b><span>Artist</span></div>`;
}
function albumTile(a) {
  return `<div class="tile" data-album="${esc(a.id)}"><img src="${esc(imgOf(a.images))}">
    <b>${esc(a.name)}</b><span>${esc(yearOf(a))}${a.album_type && a.album_type !== "album" ? ` · ${esc(a.album_type)}` : ""} · ${esc((a.artists || []).map((x) => x.name).join(", "))}</span></div>`;
}

// clicking an artist or album tile anywhere opens its page
$("view").addEventListener("click", (e) => {
  const ar = e.target.closest("[data-artist]");
  if (ar) return go({ kind: "artist", id: ar.dataset.artist });
  const al = e.target.closest("[data-album]");
  if (al) return go({ kind: "album", id: al.dataset.album });
});

/** Artists and Albums rows at the top of search results. */
function insertArtistsAlbums(el, r) {
  const artistsList = (r.artists || []).filter((a) => a?.id).slice(0, 6);
  const albumsList = (r.albums || []).filter((a) => a?.id).slice(0, 6);
  if (!artistsList.length && !albumsList.length) return;
  const html = `
    ${artistsList.length ? `<h3 class="sub-head">Artists</h3><div class="grid artists row-grid">${artistsList.map(artistTile).join("")}</div>` : ""}
    ${albumsList.length ? `<h3 class="sub-head">Albums</h3><div class="grid row-grid">${albumsList.map(albumTile).join("")}</div>` : ""}
    <h3 class="sub-head">Songs</h3>`;
  el.querySelector(".view-head")?.insertAdjacentHTML("afterend", html);
}

async function renderArtist(el, id) {
  const r = await invoke("artist", { id });
  const a = r.artist;
  const albumsList = (r.albums || []).filter(Boolean);
  const full = albumsList.filter((x) => x.album_type === "album");
  const singles = albumsList.filter((x) => x.album_type !== "album");
  el.innerHTML = `
    <div class="hero">
      <img class="hero-img round" src="${esc(imgOf(a.images, 0))}">
      <div>
        <div class="eyebrow">ARTIST</div><h1>${esc(a.name)}</h1>
        <p class="muted">${esc((a.genres || []).slice(0, 3).join(" · "))}</p>
        <div class="view-actions"><button class="big-play" id="play-artist">${icon("play")}</button></div>
      </div>
    </div>
    ${full.length ? `<h3 class="sub-head">Albums</h3><div class="grid">${full.map(albumTile).join("")}</div>` : ""}
    ${singles.length ? `<h3 class="sub-head">Singles and EPs</h3><div class="grid">${singles.map(albumTile).join("")}</div>` : ""}`;
  $("play-artist").onclick = () => withFade(() => withDevice(() => invoke("play_context", { uri: a.uri }))).then(() => setTimeout(refresh, 600));
}

async function renderAlbum(el, id) {
  const a = await invoke("album", { id });
  // album tracks come without album info; add it so covers and titles show in the list
  const tracks = (a.tracks?.items || []).map((t) => ({ ...t, album: { name: a.name, images: a.images, id: a.id } }));
  normalize(tracks);
  const total = tracks.reduce((s, t) => s + durOf(t), 0);
  el.innerHTML = `
    <div class="hero">
      <img class="hero-img" src="${esc(imgOf(a.images, 0))}">
      <div>
        <div class="eyebrow">${esc((a.album_type || "album").toUpperCase())}</div><h1>${esc(a.name)}</h1>
        <p class="muted">${(a.artists || []).map((x) => `<a class="link" data-artist="${esc(x.id)}">${esc(x.name)}</a>`).join(", ")}
          · ${esc(yearOf(a))} · ${tracks.length} songs · ${Math.round(total / 60000)} min</p>
      </div>
    </div>
    <div id="album-tracks"></div>`;
  trackView($("album-tracks"), "ALBUM", "Songs", tracks);
  // play the album itself, so Spotify continues through it in order
  $("play-all").onclick = () => withFade(() => withDevice(() => invoke("play_context", { uri: a.uri }))).then(() => setTimeout(refresh, 600));
}

/* ================= global hotkeys + overlay ================= */

const HOTKEY_LABEL = { toggle: "", next: "Next", prev: "Previous", volup: "Volume", voldown: "Volume", like: "" };

listen("aura-hotkey", async ({ payload: action }) => {
  reportLog(`hotkey received: ${action}`);
  if (action === "toggle") togglePlay();
  else if (action === "next" || action === "prev") skip(action);
  else if (action === "volup") nudgeVolume(10);
  else if (action === "voldown") nudgeVolume(-10);
  else if (action === "like") $("like").click();
  // let the action land, then show the result
  setTimeout(() => showOverlay(action), action === "next" || action === "prev" ? 1400 : 350);
});

function showOverlay(action) {
  let label = HOTKEY_LABEL[action] ?? "";
  if (action === "toggle") label = current.playing ? "Playing" : "Paused";
  if (action === "like") label = current.liked ? "Saved to Liked Songs" : "Removed from Liked Songs";
  invoke("show_overlay", {
    payload: {
      title: $("pb-title").textContent, artist: $("pb-artist").textContent, cover: current.cover,
      label, action, volume: +$("volume").value, playing: current.playing, liked: current.liked,
      accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
    },
  }).catch((e) => reportLog(`overlay: ${e}`));
}

/* ================= auto-update ================= */
// Checks GitHub for a newer signed release; installing downloads it, verifies the signature,
// installs it and restarts Aura.

async function checkForUpdates(manual = false) {
  const info = $("update-info");
  if (manual) info.textContent = "Checking…";
  let r;
  try { r = await invoke("check_update"); } catch (e) {
    reportLog(`update check failed: ${e}`);
    if (manual) info.textContent = `Couldn't check for updates: ${e}`;
    return;
  }
  if (!r.version) {
    info.textContent = `You're on the newest version (${r.current})`;
    if (manual) toast("Aura is up to date");
    return;
  }
  info.textContent = `Version ${r.version} is available (you have ${r.current})`;
  // the Settings button installs it too, so you don't have to close Settings to find the bar
  const btn = $("check-updates");
  btn.textContent = `Update to ${r.version}`;
  btn.classList.add("accent");
  btn.onclick = () => installUpdate(btn);
  showUpdateBar(r);
}

async function installUpdate(btn) {
  btn.textContent = "Updating…";
  btn.disabled = true;
  try { await invoke("install_update"); } // Aura restarts when it's done
  catch (e) { toast(`Update failed: ${e}`); btn.disabled = false; btn.textContent = "Try again"; }
}

function showUpdateBar(r) {
  if ($("update-bar")) return;
  const bar = document.createElement("div");
  bar.className = "resume-bar";
  bar.id = "update-bar";
  bar.innerHTML = `<span>✨ <b>Aura ${esc(r.version)}</b> is available</span>
    <button class="pill accent" id="update-go">Update</button><button class="ic" id="update-x">${icon("x")}</button>`;
  // on the page itself (not inside the app view), so it also shows on the sign-in screen
  document.body.append(bar);
  $("update-x").onclick = () => bar.remove();
  $("update-go").onclick = () => installUpdate($("update-go"));
}

$("check-updates").onclick = () => checkForUpdates(true);
setTimeout(() => checkForUpdates(false), 8000);

/* ================= the live Aura device ================= */
// Each time the Edge player starts it gets a new Spotify device id, and Spotify keeps old
// "Aura" entries listed for a while. The player reports its id when ready; use only that one.

let edgeDeviceId = null;
listen("edge-player", ({ payload }) => {
  const m = String(payload).match(/^ready (\w+)/);
  if (m) edgeDeviceId = m[1];
});

/** Aura's own, live player in a device list (null if it isn't running). */
function ownDevice(list) {
  if (web.ready && web.deviceId) return list.find((d) => d.id === web.deviceId) ?? null; // website: the tab's player
  if (edgeDeviceId) return list.find((d) => d.id === edgeDeviceId) ?? null;
  return null; // not started yet: don't guess, older "Aura" entries are dead
}

/* ================= song as desktop background ================= */
// Draws the current song at your screen's resolution: a blurred, darkened cover filling the
// screen, the sharp cover in the middle, title and artist under it. Windows shows it as
// the wallpaper; Aura restores yours when the setting is turned off or Aura closes.

let wallpaperFor = null;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // Spotify's image server allows it, so the canvas can be saved
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Shortens text with "…" so it fits the given width. */
function fit(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  while (text.length > 1 && ctx.measureText(text + "…").width > max) text = text.slice(0, -1);
  return text + "…";
}

async function updateWallpaper(force = false) {
  if (!S.songWallpaper || !current.cover) return;
  if (!force && wallpaperFor === current.uri) return;
  wallpaperFor = current.uri;
  const title = $("pb-title").textContent, artist = $("pb-artist").textContent;
  try {
    const img = await loadImage(current.cover);
    const scale = window.devicePixelRatio || 1;
    const W = Math.round(screen.width * scale), H = Math.round(screen.height * scale);
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");

    // background: the cover, blown up to fill, blurred and dimmed
    const bg = Math.max(W, H) * 1.15;
    ctx.filter = `blur(${Math.round(H / 18)}px) saturate(1.35) brightness(.5)`;
    ctx.drawImage(img, (W - bg) / 2, (H - bg) / 2, bg, bg);
    ctx.filter = "none";
    const vignette = ctx.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, Math.max(W, H) * 0.75);
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, "rgba(0,0,0,.55)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, W, H);

    // the cover, with rounded corners and a soft shadow
    const size = Math.round(H * 0.4);
    const x = (W - size) / 2, y = H * 0.42 - size / 2;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.55)";
    ctx.shadowBlur = H / 25;
    ctx.shadowOffsetY = H / 70;
    roundRect(ctx, x, y, size, size, size * 0.06);
    ctx.fillStyle = "#000";
    ctx.fill();
    ctx.restore();
    ctx.save();
    roundRect(ctx, x, y, size, size, size * 0.06);
    ctx.clip();
    ctx.drawImage(img, x, y, size, size);
    ctx.restore();

    // title and artist
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#fff";
    ctx.font = `800 ${Math.round(H * 0.042)}px "Segoe UI Variable Display", "Segoe UI", sans-serif`;
    ctx.fillText(fit(ctx, title, W * 0.7), W / 2, y + size + H * 0.045);
    ctx.fillStyle = "rgba(255,255,255,.7)";
    ctx.font = `500 ${Math.round(H * 0.024)}px "Segoe UI Variable Text", "Segoe UI", sans-serif`;
    ctx.fillText(fit(ctx, artist, W * 0.6), W / 2, y + size + H * 0.105);

    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    if (wallpaperFor !== current.uri && !force) return; // the song changed while drawing
    await invoke("set_song_wallpaper", { image: bytes });
  } catch (e) {
    wallpaperFor = null;
    reportLog(`wallpaper: ${e}`);
    if (force) toast(`Couldn't set the wallpaper: ${e}`);
  }
}

// redraw on every song change
const onTrackChangeExtrasForWallpaper = onTrackChangeExtras;
onTrackChangeExtras = (t) => {
  onTrackChangeExtrasForWallpaper(t);
  setTimeout(() => updateWallpaper(), 600); // after the new cover is known
};

/* ================= request meter (Settings) ================= */
// Spotify doesn't publish the daily limit, so this shows how many requests Aura made today,
// how many it answered from its own copies instead, and whether Spotify is pausing it now.

async function updateMeter() {
  const s = await invoke("request_stats").catch(() => null);
  if (!s) return;
  const level = s.blockedSecs > 0 ? "paused" : s.sent < 600 ? "light" : s.sent < 1500 ? "moderate" : "heavy";
  const pill = $("req-pill");
  pill.textContent = { paused: "Paused", light: "Light", moderate: "Moderate", heavy: "Heavy" }[level];
  pill.className = `meter-pill ${level}`;
  const until = s.blockedSecs > 0
    ? ` · Spotify is pausing Aura until ${new Date(Date.now() + s.blockedSecs * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    : "";
  $("req-meter").textContent = `${s.sent} sent · ${s.saved} answered from Aura's own copies${s.offlineItems ? ` · ${s.offlineItems} pages saved offline` : ""}${until}`;
}
$("btn-settings").addEventListener("pointerdown", () => setTimeout(updateMeter, 50));
setInterval(() => { if (!$("settings-backdrop").classList.contains("hidden")) updateMeter(); }, 15000);

/* ================= "What's new" after an update ================= */

async function showWhatsNew() {
  const version = await invoke("app_version").catch(() => null);
  if (!version || version === "web") return;
  let last = null;
  try { last = localStorage.getItem("aura.lastVersion"); localStorage.setItem("aura.lastVersion", version); } catch {}
  if (!last || last === version) return; // first run, or nothing new
  let notes = "";
  try {
    const r = await fetch(`https://api.github.com/repos/hejmedig1235432/aura/releases/tags/v${version}`);
    if (r.ok) notes = (await r.json()).body ?? "";
  } catch {}
  const box = document.createElement("div");
  box.id = "whatsnew";
  box.innerHTML = `<div class="whatsnew-card">
      <div class="eyebrow">UPDATED TO ${esc(version)}</div>
      <h2>What's new in Aura</h2>
      <p>${esc(notes || "Bug fixes and improvements.").replace(/\n/g, "<br>")}</p>
      <button class="pill accent" id="whatsnew-ok">Nice</button>
    </div>`;
  document.body.append(box);
  const close = () => box.remove();
  $("whatsnew-ok").onclick = close;
  box.onclick = (e) => { if (e.target === box) close(); };
}
setTimeout(showWhatsNew, 2500);

/* ================= Wrapped: weekly / monthly recap ================= */

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

async function renderWrapped(el, range) {
  await loadCounts();
  const { history = [], tracks = {} } = (await invoke("play_history").catch(() => null)) ?? {};
  const now = Date.now(), span = (range === "week" ? 7 : 30) * 86400000;
  const all = history.map((p) => ({ uri: p.uri, at: new Date(p.at) }));
  const inRange = all.filter((p) => now - p.at < span);
  const before = all.filter((p) => now - p.at >= span && now - p.at < 2 * span);
  const t = (uri) => tracks[uri] ?? { name: "Unknown", artists: "", image: "", duration_ms: 0 };

  const minutes = Math.round(inRange.reduce((s, p) => s + (t(p.uri).duration_ms || 0), 0) / 60000);
  const countBy = (keyOf) => {
    const m = new Map();
    for (const p of inRange) for (const k of [].concat(keyOf(p))) if (k) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const topSongs = countBy((p) => p.uri).slice(0, 5);
  const topArtists = countBy((p) => t(p.uri).artists.split(", ")).slice(0, 5);
  const days = countBy((p) => dayKey(p.at));
  const firstSeen = new Map();
  for (const p of [...all].sort((a, b) => a.at - b.at)) if (!firstSeen.has(p.uri)) firstSeen.set(p.uri, p.at);
  const newFinds = [...new Set(inRange.map((p) => p.uri))].filter((u) => now - firstSeen.get(u) < span);
  const change = before.length ? Math.round(((inRange.length - before.length) / before.length) * 100) : null;

  // listening clock: plays per weekday and hour
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const p of inRange) grid[(p.at.getDay() + 6) % 7][p.at.getHours()]++;
  const peak = Math.max(1, ...grid.flat());
  let best = [0, 0];
  grid.forEach((row, d) => row.forEach((n, h) => { if (n > grid[best[0]][best[1]]) best = [d, h]; }));

  // Rediscover: songs you played a lot, not heard for 30+ days
  const forgotten = Object.entries(tracks)
    .filter(([, x]) => x.count >= 3 && now - new Date(x.last_played) > 30 * 86400000)
    .sort((a, b) => b[1].count - a[1].count).slice(0, 10);

  const label = range === "week" ? "in the last 7 days" : "in the last 30 days";
  const songRow = ([uri, n], i) => `
    <div class="crow" data-uri="${esc(uri)}"><span class="rank">${i + 1}</span><img src="${esc(t(uri).image)}">
      <div><b>${esc(t(uri).name)}</b><span>${esc(t(uri).artists)}</span></div><span class="count">${n}×</span></div>`;

  el.innerHTML = `
    <div class="view-head">
      <div class="eyebrow">YOUR RECAP</div><h1>Wrapped</h1>
      <div class="seg wrapped-tabs">
        <button data-range="week" class="${range === "week" ? "sel" : ""}">Last 7 days</button>
        <button data-range="month" class="${range === "month" ? "sel" : ""}">Last 30 days</button>
      </div>
    </div>
    ${inRange.length ? `
    <div class="stat-cards">
      <div class="stat"><b>${inRange.length}</b><span>plays ${label}${change != null ? ` · ${change >= 0 ? "▲" : "▼"} ${Math.abs(change)}%` : ""}</span></div>
      <div class="stat"><b>${minutes}</b><span>minutes listened</span></div>
      <div class="stat"><b>${newFinds.length}</b><span>new songs found</span></div>
      <div class="stat"><b>${days[0] ? new Date(`${days[0][0]}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) : "–"}</b><span>busiest day${days[0] ? ` (${days[0][1]} plays)` : ""}</span></div>
    </div>
    <div class="wrapped-cols">
      <div><h3 class="sub-head">Top songs</h3><div class="counted">${topSongs.map(songRow).join("")}</div></div>
      <div><h3 class="sub-head">Top artists</h3><div class="counted">${topArtists.map(([a, n], i) => `
        <div class="crow"><span class="rank">${i + 1}</span><div><b>${esc(a)}</b></div><span class="count">${n}×</span></div>`).join("")}</div></div>
    </div>
    <h3 class="sub-head">Listening clock <small class="muted">· you listen most on ${DAYS[best[0]]}s around ${String(best[1]).padStart(2, "0")}:00</small></h3>
    <div class="clock">
      <div></div>${Array.from({ length: 24 }, (_, h) => `<span class="clock-h">${h % 3 ? "" : h}</span>`).join("")}
      ${grid.map((row, d) => `<span class="clock-d">${DAYS[d]}</span>${row.map((n, h) =>
        `<i style="--a:${n ? 0.15 + 0.85 * (n / peak) : 0}" title="${DAYS[d]} ${h}:00 · ${n} plays"></i>`).join("")}`).join("")}
    </div>
    ${newFinds.length ? `<h3 class="sub-head">New finds ${label}</h3>
      <div class="counted">${newFinds.slice(0, 8).map((u) => songRow([u, inRange.filter((p) => p.uri === u).length], newFinds.indexOf(u))).join("")}</div>` : ""}
    ` : `<div class="empty">No plays recorded ${label} yet. Aura records what you listen to (on any device) every few minutes.</div>`}
    <h3 class="sub-head">Rediscover <small class="muted">· songs you loved but haven't played in 30+ days</small></h3>
    <div class="counted">${forgotten.map(([uri, x], i) => `
      <div class="crow" data-uri="${esc(uri)}"><span class="rank">${i + 1}</span><img src="${esc(x.image)}">
        <div><b>${esc(x.name)}</b><span>${esc(x.artists)} · last played ${new Date(x.last_played).toLocaleDateString()}</span></div>
        <span class="count">${x.count}×</span></div>`).join("") ||
      `<div class="empty">Nothing forgotten yet. Songs show up here once you've played them a few times and then not for a month.</div>`}</div>`;

  el.querySelector(".wrapped-tabs").onclick = (e) => { const r = e.target.dataset.range; if (r) go({ kind: "wrapped", range: r }); };
  el.onclick = (e) => {
    const row = e.target.closest(".crow[data-uri]");
    if (row) playList([{ uri: row.dataset.uri }], row.dataset.uri);
  };
}

/* ================= milestones ================= */
// "🎉 25th play of Softcore" when a song reaches 10, 25, 50, 100, ... plays.

const MILESTONES = [10, 25, 50, 100, 250, 500, 1000];
const ordinal = (n) => n + (["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] ?? "th");
let milestonesSeen = null;
function checkMilestones() {
  const first = milestonesSeen === null;
  if (first) { try { milestonesSeen = new Set(JSON.parse(localStorage.getItem("aura.milestones") || "null") ?? []); } catch { milestonesSeen = new Set(); } }
  const quiet = first && !localStorage.getItem("aura.milestones"); // first time ever: don't flood with old milestones
  const fresh = [];
  for (const [uri, x] of Object.entries(playCounts)) {
    for (const m of MILESTONES) {
      const key = `${uri}:${m}`;
      if (x.count >= m && !milestonesSeen.has(key)) { milestonesSeen.add(key); if (!quiet) fresh.push([m, x.name]); }
    }
  }
  try { localStorage.setItem("aura.milestones", JSON.stringify([...milestonesSeen])); } catch {}
  fresh.sort((a, b) => b[0] - a[0]);
  if (fresh[0]) toast(`🎉 ${ordinal(fresh[0][0])} play of ${fresh[0][1]}!`);
}

/* ================= live state from Aura's own player ================= */
// The Edge player reports every change (song, pause, seek, shuffle, repeat). While those
// reports come in, Aura shows them directly and barely needs to ask Spotify (see pollDelay).

var edgeLiveAt = 0; // var: pollDelay (earlier in the file) reads it
const REPEAT = ["off", "context", "track"];

listen("edge-state", ({ payload: s }) => {
  if (!s || !s.track) { edgeLiveAt = 0; return; } // playing elsewhere now: back to asking Spotify
  edgeLiveAt = Date.now();
  const t = s.track;
  current.playing = !s.paused;
  current.pos = s.position + (s.paused ? 0 : Date.now() - s.at);
  current.at = performance.now();
  current.dur = t.duration_ms;
  current.shuffle = s.shuffle;
  current.repeat = REPEAT[s.repeat] ?? "off";
  if (t.uri !== current.uri) {
    current.uri = t.uri;
    current.id = t.id;
    const imgs = [...(t.album?.images ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
    current.cover = imgs[0]?.url ?? null;
    t.album.images = imgs;
    onTrackChange(t);
  }
  $$("[data-toggle]").forEach((b) => (b.innerHTML = icon(current.playing ? "pause" : "play")));
  $("shuffle").classList.toggle("on", !!current.shuffle);
  $("repeat").classList.toggle("on", current.repeat !== "off");
  $("repeat").querySelector("i").textContent = current.repeat === "track" ? "1" : "";
  markPlaying();
});

/* ================= visualizer ================= */
// Spotify's audio is copy-protected and its audio-analysis data isn't available to new apps,
// so these bars are an animation: they move while music plays, settle when paused, and take
// the song's colours.

function startViz(canvas, bars) {
  const ctx = canvas.getContext("2d");
  const h = new Float32Array(bars), target = new Float32Array(bars);
  let phase = Math.random() * 100, last = 0;
  function frame(ts) {
    requestAnimationFrame(frame);
    if (ts - last < 33 || !canvas.offsetParent) return; // ~30 fps, and only when visible
    last = ts;
    const w = (canvas.width = canvas.clientWidth * devicePixelRatio);
    const hh = (canvas.height = canvas.clientHeight * devicePixelRatio);
    const on = S.visualizer && current.playing;
    phase += 0.06;
    for (let i = 0; i < bars; i++) {
      if (on && Math.random() < 0.18) {
        // a slow wave across the bars plus random kicks feels like music without being audio
        const wave = 0.5 + 0.5 * Math.sin(phase + i * 0.35) * Math.sin(phase * 0.37 + i * 0.11);
        target[i] = 0.15 + 0.75 * wave * (0.55 + 0.45 * Math.random());
      } else if (!on) target[i] = 0.04;
      h[i] += (target[i] - h[i]) * (on ? 0.22 : 0.08);
    }
    ctx.clearRect(0, 0, w, hh);
    const styles = getComputedStyle(document.documentElement);
    const grad = ctx.createLinearGradient(0, hh, 0, 0);
    grad.addColorStop(0, (S.accentMatch && artAccent) || styles.getPropertyValue("--accent").trim() || "#fff");
    grad.addColorStop(1, styles.getPropertyValue("--accent2").trim() || "#fe9090");
    ctx.fillStyle = grad;
    const gap = w / bars, bw = Math.max(2, gap * 0.62), r = bw / 2;
    for (let i = 0; i < bars; i++) {
      const bh = Math.max(r * 2, h[i] * hh);
      const x = i * gap + (gap - bw) / 2, y = hh - bh;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x, y, bw, bh, r) : ctx.rect(x, y, bw, bh);
      ctx.fill();
    }
  }
  requestAnimationFrame(frame);
}
startViz($("viz"), 36);
startViz($("saver-viz"), 64);
function applyVizSetting() { $("viz").classList.toggle("hidden", !S.visualizer); }
applyVizSetting();
document.addEventListener("click", (e) => { if (e.target.closest('[data-set="visualizer"]')) setTimeout(applyVizSetting, 0); });

/* ================= screensaver ================= */
// After a few idle minutes while music plays: full-screen cover, lyrics, visualizer and clock.
// Any mouse or keyboard input closes it.

let saverOn = false;
let lastLocalInput = Date.now(); // the website can only see input in its own tab
for (const ev of ["pointermove", "pointerdown", "keydown", "wheel"]) addEventListener(ev, () => (lastLocalInput = Date.now()), { passive: true });

async function idleSeconds() {
  if (window.AURA_WEB) return (Date.now() - lastLocalInput) / 1000;
  return invoke("idle_secs").catch(() => 0);
}

function fillSaver() {
  $("saver-cover").src = current.cover ?? "";
  $("saver-bg").style.backgroundImage = current.cover ? `url("${current.cover}")` : "";
  $("saver-title").textContent = $("pb-title").textContent;
  $("saver-artist").textContent = $("pb-artist").textContent;
  const line = lastLine >= 0 ? lyricLines[lastLine]?.text : "";
  if ($("saver-line").textContent !== (line || "")) $("saver-line").textContent = line || "";
  $("saver-clock").textContent = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

async function enterSaver() {
  saverOn = true;
  fillSaver();
  $("saver").classList.remove("hidden");
  if (!window.AURA_WEB) {
    await win.setFullscreen(true).catch(() => {});
    await win.setAlwaysOnTop(true).catch(() => {});
  }
}

async function exitSaver() {
  saverOn = false;
  $("saver").classList.add("hidden");
  if (!window.AURA_WEB) {
    await win.setAlwaysOnTop(false).catch(() => {});
    await win.setFullscreen(false).catch(() => {});
  }
}

setInterval(async () => {
  const minutes = +S.saverMin || 0;
  if (saverOn) {
    fillSaver();
    if ((await idleSeconds()) < 2) exitSaver();
    return;
  }
  if (!minutes || !current.playing || $("app").classList.contains("hidden")) return;
  if ((await idleSeconds()) >= minutes * 60) enterSaver();
}, 1000);
$("saver").addEventListener("pointerdown", exitSaver);
