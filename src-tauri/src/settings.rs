// Preferences, stored as plain JSON in settings.json under platform::config_dir().
// No secret ever lands here — the API key lives in the OS keychain (secrets.rs).
// Adapted from Coucou by Louis Raillé (MIT License, see LICENSE-COUCOU-MIT).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    /// "primary" = the main display (the notch screen on a Mac),
    /// "cursor" = whichever display the mouse is on.
    pub screen: String,
    pub autostart: bool,
    /// Claude model used by the chat.
    pub model: String,
    /// Sync folder chosen by hand; `None` = Google Drive, detected.
    pub sync_dir: Option<String>,
    /// "Ton prénom" — used in the greeting ("Bonjour <prénom> !") and the chat.
    pub first_name: String,
    /// "Ce que Nooky doit savoir sur toi" — appended to the chat's system prompt.
    pub about_me: String,
    /// "Lien de la maison" — opened by the overview button (hidden when empty).
    pub maison_url: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.5,
            auto_close_interval: 15.0,
            screen: "primary".into(),
            autostart: false,
            model: crate::claude::DEFAULT_MODEL.to_string(),
            sync_dir: None,
            first_name: String::new(),
            about_me: String::new(),
            maison_url: String::new(),
        }
    }
}

pub use crate::platform::{config_dir, local_dir};

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    crate::platform::ensure_private_dir(&dir)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    crate::sync::write_atomic(&settings_path(), &json)
}
