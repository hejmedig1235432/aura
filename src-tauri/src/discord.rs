//! Discord Rich Presence: shows "Listening to Aura" with the current song on your profile.
//! Talks to the Discord desktop app over its local IPC pipe; needs a Discord application id.

use discord_rich_presence::activity::{Activity, ActivityType, Assets, StatusDisplayType, Timestamps};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};

#[derive(Default)]
pub struct Presence {
    client: Option<(String, DiscordIpcClient)>,
}

impl Presence {
    fn client(&mut self, app_id: &str) -> Result<&mut DiscordIpcClient, String> {
        let stale = self.client.as_ref().map(|(id, _)| id != app_id).unwrap_or(true);
        if stale {
            if let Some((_, mut old)) = self.client.take() {
                let _ = old.close();
            }
            let mut c = DiscordIpcClient::new(app_id);
            c.connect().map_err(|e| format!("Discord isn't running or the id is wrong ({e})"))?;
            self.client = Some((app_id.to_string(), c));
        }
        Ok(&mut self.client.as_mut().unwrap().1)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn set(&mut self, app_id: &str, title: &str, artist: &str, album: &str, image: &str, start_ms: i64, end_ms: i64) -> Result<(), String> {
        let activity = Activity::new()
            .activity_type(ActivityType::Listening)
            .status_display_type(StatusDisplayType::Details)
            .details(title)
            .state(artist)
            .assets(Assets::new().large_image(image).large_text(album))
            .timestamps(Timestamps::new().start(start_ms).end(end_ms));
        let result = self.client(app_id)?.set_activity(activity);
        if result.is_err() {
            self.client = None; // reconnect next time (Discord may have restarted)
        }
        result.map_err(|e| e.to_string())
    }

    pub fn clear(&mut self) {
        if let Some((_, c)) = self.client.as_mut() {
            if c.clear_activity().is_err() {
                self.client = None;
            }
        }
    }
}
