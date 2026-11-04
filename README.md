# Aura

Tauri 2 + rspotify Spotify client.

## Setup
1. Create an app at https://developer.spotify.com/dashboard
   - Redirect URI: `http://127.0.0.1:8888/callback`
   - APIs: Web API
2. Install Rust (https://rustup.rs) and the Tauri CLI: `cargo install tauri-cli --version "^2"`
3. Run:
   ```powershell
   $env:RSPOTIFY_CLIENT_ID = "your-client-id"
   cd src-tauri
   cargo tauri dev
   ```

Click **Connect Spotify**, sign in in the browser, and you're in. The token is cached in
`%APPDATA%\prism\token.json`, so later launches skip the login.

## How playback works
Aura is a Spotify Connect remote: it plays on any device running Spotify (desktop app, phone,
speaker). Pick the device in the dropdown. Playback control needs Spotify Premium.
