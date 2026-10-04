// Dropped files are copied into the app's inbox (%LOCALAPPDATA%\Nooky\inbox,
// ~/Library/Application Support/Nooky/inbox) so the original is never touched
// and the copy survives the drag source going away. The inbox is swept of
// anything older than a week. Adapted from Coucou by Louis Raillé (MIT License).

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::settings;

const KEEP_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}

pub fn inbox_dir() -> PathBuf {
    settings::local_dir().join("inbox")
}

pub fn ingest(source: &str) -> Result<DroppedFile, String> {
    let src = Path::new(source);
    let meta = std::fs::metadata(src).map_err(|e| format!("Je n'arrive pas à lire {source} : {e}"))?;
    if meta.is_dir() {
        return Err("Les dossiers ne passent pas encore : dépose un fichier.".into());
    }

    let dir = inbox_dir();
    crate::platform::ensure_private_dir(&settings::local_dir()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());

    let mut dest = dir.join(&name);
    if dest.exists() {
        let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let ext = src.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
        for i in 2..1000 {
            let candidate = dir.join(format!("{stem} ({i}){ext}"));
            if !candidate.exists() {
                dest = candidate;
                break;
            }
        }
    }

    std::fs::copy(src, &dest).map_err(|e| format!("Copie impossible : {e}"))?;
    // CopyFileEx carries the source's timestamps across, so a file last edited
    // three years ago would arrive already older than the sweep window and be
    // deleted on the spot. The inbox ages from when *we* copied it.
    if let Ok(file) = std::fs::File::options().write(true).open(&dest) {
        let _ = file.set_modified(SystemTime::now());
    }
    sweep(&dir);

    Ok(DroppedFile {
        name,
        path: dest.to_string_lossy().to_string(),
        size: meta.len(),
    })
}

/// Largest text file whose content may ride along with a question sent
/// through the free chat bridge (no API key).
pub const BRIDGE_TEXT_MAX: u64 = 20 * 1024;

/// The text of a file Nooky caught (it must be in the inbox), for the chat
/// bridge: only plain UTF-8 text of at most `max` bytes. The error says why not.
pub fn read_caught_text(path: &str, max: u64) -> Result<String, String> {
    let inbox = std::fs::canonicalize(inbox_dir()).map_err(|_| "Fichier introuvable.".to_string())?;
    let p = std::fs::canonicalize(path).map_err(|_| "Fichier introuvable.".to_string())?;
    if !p.starts_with(&inbox) {
        return Err("Ce fichier n'a pas été déposé sur Nooky.".into());
    }
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > max {
        return Err(format!("trop gros ({} Ko, {} Ko au plus)", meta.len().div_ceil(1024), max / 1024));
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    if bytes.contains(&0) {
        return Err("ce n'est pas un fichier texte".into());
    }
    String::from_utf8(bytes).map_err(|_| "ce n'est pas un fichier texte".into())
}

/// Drops anything copied here more than a week ago. `ingest` stamps every copy
/// with the time it landed, so this really is the age of the copy and not the
/// age of whatever the user happened to drag in.
fn sweep(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(copied) = meta.modified() else { continue };
        if now.duration_since(copied).map(|age| age > KEEP_FOR).unwrap_or(false) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ingest_copies_and_never_overwrites() {
        let tmp = std::env::temp_dir().join(format!("nooky-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let source = tmp.join("note.txt");
        std::fs::write(&source, b"hello").unwrap();

        let first = ingest(source.to_str().unwrap()).unwrap();
        assert_eq!(first.name, "note.txt");
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");

        // A second drop of the same name must not clobber the first copy.
        std::fs::write(&source, b"second").unwrap();
        let second = ingest(source.to_str().unwrap()).unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");
        assert_eq!(std::fs::read(&second.path).unwrap(), b"second");

        // Folders are refused rather than silently ignored.
        assert!(ingest(tmp.to_str().unwrap()).is_err());

        // An ancient source must not arrive already older than the sweep window.
        let old_source = tmp.join("ancient.txt");
        std::fs::write(&old_source, b"old").unwrap();
        let long_ago = SystemTime::now() - KEEP_FOR - Duration::from_secs(60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&old_source)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
        let aged = ingest(old_source.to_str().unwrap()).unwrap();
        assert!(
            Path::new(&aged.path).exists(),
            "a file copied just now was swept as if it were a week old"
        );
        let _ = std::fs::remove_file(&aged.path);

        let _ = std::fs::remove_file(&first.path);
        let _ = std::fs::remove_file(&second.path);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn caught_text_only_from_the_inbox_and_small() {
        let tmp = std::env::temp_dir().join(format!("nooky-text-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let small = tmp.join("petit.txt");
        std::fs::write(&small, "Bonjour l'équipe").unwrap();
        // Not in the inbox: refused, even though it is small text.
        assert!(read_caught_text(small.to_str().unwrap(), BRIDGE_TEXT_MAX).is_err());
        let caught = ingest(small.to_str().unwrap()).unwrap();
        assert_eq!(read_caught_text(&caught.path, BRIDGE_TEXT_MAX).unwrap(), "Bonjour l'équipe");

        let big = tmp.join("gros.txt");
        std::fs::write(&big, "x".repeat(BRIDGE_TEXT_MAX as usize + 1)).unwrap();
        let big_caught = ingest(big.to_str().unwrap()).unwrap();
        assert!(read_caught_text(&big_caught.path, BRIDGE_TEXT_MAX).unwrap_err().contains("trop gros"));

        let bin = tmp.join("image.bin");
        std::fs::write(&bin, [0u8, 159, 146, 150]).unwrap();
        let bin_caught = ingest(bin.to_str().unwrap()).unwrap();
        assert!(read_caught_text(&bin_caught.path, BRIDGE_TEXT_MAX).is_err());

        for p in [&caught.path, &big_caught.path, &bin_caught.path] {
            let _ = std::fs::remove_file(p);
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
