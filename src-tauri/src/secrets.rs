// The Claude API key lives in the OS keychain — the macOS login keychain or
// the Windows Credential Manager — never on disk and never in the front end:
// the island can only ask whether it is present.
// Adapted from Coucou by Louis Raillé (MIT License, see LICENSE-COUCOU-MIT).

use keyring::Entry;

const SERVICE: &str = "app.nooky.desktop";

/// Every key Nooky may store. Anything outside this list is refused.
pub const KNOWN_KEYS: &[&str] = &["anthropic-api-key"];

fn entry(key: &str) -> Option<Entry> {
    if !KNOWN_KEYS.contains(&key) {
        return None;
    }
    Entry::new(SERVICE, key).ok()
}

pub fn get(key: &str) -> Option<String> {
    entry(key)?.get_password().ok().filter(|v| !v.is_empty())
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("clé inconnue : {key}"))?;
    if value.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(value).map_err(|e| e.to_string())
}

pub fn clear(key: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("clé inconnue : {key}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn present(key: &str) -> bool {
    get(key).is_some()
}
