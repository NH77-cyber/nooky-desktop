// The sync folder: the shared state as an append-only operation log shared
// through Google Drive for desktop (or any folder the user picks), plus the
// briefs, the mail and the free chat bridge. Nooky Desktop — new code.
//
// Each device writes only its own file `ops-<deviceId>.json`, and reads every
// `ops-*.json` in the folder (the "maison" and the scheduled tasks write many
// `ops-maison-<ts>.json` / `ops-task-<name>-<ts>.json`); the state is the fold
// of all their operations (see SYNC-FORMAT.md, format v2, and
// src/tasks/oplog.ts for the fold itself). Nothing here ever writes another
// writer's file, so Drive never has two writers on one file. The only other
// files we create are our own `ask-<deviceId>-<ms>.json` (chat bridge), and
// the only files we delete are our own ask/answer files older than 7 days.

use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::platform;
use crate::settings::config_dir;

/// Past this many operations our own file is compacted.
pub const COMPACT_OVER: usize = 2000;
/// Anything larger is not a file we wrote: skipped rather than read.
const MAX_FILE: u64 = 32 * 1024 * 1024;

/// Serialises writes to our own file and to the local state file.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

// ── Where ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncInfo {
    /// The folder in use.
    pub dir: String,
    /// "drive" (Google Drive, detected), "custom" (picked by hand) or "local".
    pub mode: String,
    /// The Google Drive folder that was detected, even when another is in use.
    pub detected: Option<String>,
    pub device_id: String,
    pub device_name: String,
    /// Our own file name in that folder.
    pub own_file: String,
    /// Why the hand-picked folder could not be used, if it could not.
    pub custom_error: Option<String>,
}

/// `<Google Drive>/Nooky`, if Google Drive for desktop is installed.
pub fn detect_drive() -> Option<PathBuf> {
    const ROOTS: [&str; 2] = ["Mon Drive", "My Drive"];
    #[cfg(target_os = "macos")]
    {
        // Google Drive for desktop (File Provider): ~/Library/CloudStorage/GoogleDrive-<account>/
        let cloud = platform::home_dir().join("Library").join("CloudStorage");
        if let Ok(entries) = std::fs::read_dir(&cloud) {
            let mut accounts: Vec<PathBuf> = entries
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with("GoogleDrive-"))
                .map(|e| e.path())
                .collect();
            accounts.sort();
            for account in accounts {
                for root in ROOTS {
                    let p = account.join(root);
                    if p.is_dir() {
                        return Some(p.join("Nooky"));
                    }
                }
            }
        }
        // Older versions mounted a volume instead.
        for root in ROOTS {
            let p = Path::new("/Volumes/GoogleDrive").join(root);
            if p.is_dir() {
                return Some(p.join("Nooky"));
            }
        }
    }
    #[cfg(windows)]
    {
        // Google Drive for desktop mounts a virtual drive, G: by default.
        for letter in "GDEFHIJKLMNOPQRSTUVWXYZ".chars() {
            for root in ROOTS {
                let p = PathBuf::from(format!("{letter}:\\{root}"));
                if p.is_dir() {
                    return Some(p.join("Nooky"));
                }
            }
        }
    }
    let _ = ROOTS;
    None
}

/// The folder in use: the hand-picked one, else Google Drive, else a local
/// folder in the app data (everything still works, on this device only).
pub fn resolve(custom: Option<&str>) -> (PathBuf, &'static str, Option<PathBuf>, Option<String>) {
    let detected = detect_drive();
    let mut custom_error = None;
    if let Some(c) = custom.map(str::trim).filter(|c| !c.is_empty()) {
        let p = PathBuf::from(c);
        if !p.is_absolute() {
            custom_error = Some("Ce chemin n'est pas un chemin complet.".into());
        } else {
            match std::fs::create_dir_all(&p) {
                Ok(()) => return (p, "custom", detected, None),
                Err(e) => custom_error = Some(format!("Dossier inaccessible : {e}")),
            }
        }
    }
    if let Some(d) = &detected {
        if std::fs::create_dir_all(d).is_ok() {
            return (d.clone(), "drive", detected.clone(), custom_error);
        }
    }
    let local = config_dir().join("sync");
    let _ = std::fs::create_dir_all(&local);
    (local, "local", detected, custom_error)
}

pub fn info(custom: Option<&str>) -> SyncInfo {
    let (dir, mode, detected, custom_error) = resolve(custom);
    let (device_id, device_name) = device();
    SyncInfo {
        dir: dir.to_string_lossy().to_string(),
        mode: mode.into(),
        detected: detected.map(|d| d.to_string_lossy().to_string()),
        own_file: own_file_name(&device_id),
        device_id,
        device_name,
        custom_error,
    }
}

// ── This device ───────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct DeviceFile {
    id: String,
    name: String,
}

/// Stable id of this device (stored in the app data), and its readable name.
pub fn device() -> (String, String) {
    let path = config_dir().join("device.json");
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(d) = serde_json::from_slice::<DeviceFile>(&bytes) {
            if is_device_id(&d.id) {
                return (d.id, d.name);
            }
        }
    }
    let name = platform::hostname();
    let id = format!("{}-{}", slug(&name), random_suffix(8));
    let _ = platform::ensure_private_dir(&config_dir());
    if let Ok(json) = serde_json::to_vec_pretty(&DeviceFile { id: id.clone(), name: name.clone() }) {
        let _ = write_atomic(&path, &json);
    }
    (id, name)
}

fn is_device_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// "MacBook-Pro-de-Camille" → "macbook-pro-de-camille", at most 24 characters.
fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= 24 {
            break;
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() { "device".into() } else { out }
}

/// Random base-36 characters from the standard library's randomly keyed hasher.
fn random_suffix(len: usize) -> String {
    use std::hash::{BuildHasher, Hasher};
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let mut out = String::new();
    while out.len() < len {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(nanos);
        h.write_u32(std::process::id());
        let mut v = h.finish();
        for _ in 0..8 {
            out.push(ALPHABET[(v % 36) as usize] as char);
            v /= 36;
        }
    }
    out.truncate(len);
    out
}

pub fn own_file_name(device_id: &str) -> String {
    format!("ops-{device_id}.json")
}

/// `^ops-[A-Za-z0-9_-]+\.json$` — anything else in the folder (Drive conflict
/// copies such as "ops-x (1).json", temp files, notes) is ignored.
pub fn is_ops_name(name: &str) -> bool {
    name.strip_prefix("ops-")
        .and_then(|rest| rest.strip_suffix(".json"))
        .map(|mid| !mid.is_empty() && mid.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
        .unwrap_or(false)
}

/// v1 files, still read when present.
const LEGACY_FILES: [&str; 2] = ["brief.json", "mailbox.json"];

/// `<prefix><mid>.json` where mid is `[A-Za-z0-9_-]+`, optionally followed by a
/// Drive duplicate suffix " (n)". Briefs and mail are deduplicated by their
/// content (slot / id), so Drive's duplicates are safe to read.
fn is_content_name(name: &str, prefix: &str) -> bool {
    let Some(mid) = name.strip_prefix(prefix).and_then(|r| r.strip_suffix(".json")) else { return false };
    let base = match mid.rfind(" (") {
        Some(i) if mid.ends_with(')') && mid[i + 2..mid.len() - 1].chars().all(|c| c.is_ascii_digit()) && mid.len() > i + 3 => &mid[..i],
        _ => mid,
    };
    !base.is_empty() && base.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// `brief-<slot>.json` (and Drive duplicates of it).
pub fn is_brief_name(name: &str) -> bool {
    is_content_name(name, "brief-")
}

/// `mail-<id>.json` (and Drive duplicates of it).
pub fn is_mail_name(name: &str) -> bool {
    is_content_name(name, "mail-")
}

/// `<kind>-<deviceId>-<epochms>.json` for this device → the epoch ms.
fn bridge_ms(name: &str, kind: &str, device_id: &str) -> Option<u64> {
    let rest = name.strip_prefix(kind)?.strip_prefix('-')?.strip_prefix(device_id)?.strip_prefix('-')?;
    let digits = rest.strip_suffix(".json")?;
    if digits.is_empty() || digits.len() > 16 || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// Is this one of OUR ask / answer files?
pub fn is_own_bridge(name: &str, kind: &str, device_id: &str) -> bool {
    bridge_ms(name, kind, device_id).is_some()
}

/// Mail files kept in a snapshot at most (the newest by modification time).
const MAX_MAIL_FILES: usize = 300;
/// Briefs and mail are small; anything bigger is skipped.
const MAX_SMALL_FILE: u64 = 2 * 1024 * 1024;

// ── Reading ───────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct SyncFile {
    pub file: String,
    pub json: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub stamp: String,
    /// `ops-*.json`
    pub files: Vec<SyncFile>,
    /// `brief-*.json`
    pub briefs: Vec<SyncFile>,
    /// `mail-*.json` (the newest MAX_MAIL_FILES)
    pub mails: Vec<SyncFile>,
    /// `answer-<our deviceId>-*.json`
    pub answers: Vec<SyncFile>,
    /// Legacy v1 `brief.json` / `mailbox.json`.
    pub brief: Option<String>,
    pub mailbox: Option<String>,
}

fn mtime_ms(meta: &std::fs::Metadata) -> u128 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Cheap fingerprint of the folder: names, sizes and mtimes of the files we
/// read. The island polls it every few seconds and only reads when it changes.
pub fn stamp(dir: &Path) -> String {
    let Ok(entries) = std::fs::read_dir(dir) else { return "missing".into() };
    let (device_id, _) = device();
    let mut parts: Vec<String> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if !(is_ops_name(&name)
                || is_brief_name(&name)
                || is_mail_name(&name)
                || is_own_bridge(&name, "answer", &device_id)
                || LEGACY_FILES.contains(&name.as_str()))
            {
                return None;
            }
            let meta = e.metadata().ok()?;
            Some(format!("{name}:{}:{}", meta.len(), mtime_ms(&meta)))
        })
        .collect();
    parts.sort();
    format!("{}|{}", dir.to_string_lossy(), parts.join("|"))
}

fn read_text_max(path: &Path, max: u64) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > max {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    String::from_utf8(bytes).ok()
}

fn read_text(path: &Path) -> Option<String> {
    read_text_max(path, MAX_FILE)
}

/// Every op file, brief, mail and answer as raw text — the island parses
/// them, and skips any that does not parse yet (a file Drive is still
/// downloading) until next time.
pub fn read_all(dir: &Path) -> Snapshot {
    let stamp = stamp(dir);
    let (device_id, _) = device();
    let mut ops = Vec::new();
    let mut briefs = Vec::new();
    let mut mail_names: Vec<(u128, String)> = Vec::new();
    let mut answers = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        let mut names: Vec<(String, u128)> = entries
            .flatten()
            .map(|e| {
                let m = e.metadata().map(|m| mtime_ms(&m)).unwrap_or(0);
                (e.file_name().to_string_lossy().to_string(), m)
            })
            .collect();
        names.sort();
        for (name, mtime) in names {
            if is_ops_name(&name) {
                if let Some(text) = read_text(&dir.join(&name)) {
                    ops.push(SyncFile { file: name, json: text });
                }
            } else if is_brief_name(&name) {
                if let Some(text) = read_text_max(&dir.join(&name), MAX_SMALL_FILE) {
                    briefs.push(SyncFile { file: name, json: text });
                }
            } else if is_mail_name(&name) {
                mail_names.push((mtime, name));
            } else if is_own_bridge(&name, "answer", &device_id) {
                if let Some(text) = read_text_max(&dir.join(&name), MAX_SMALL_FILE) {
                    answers.push(SyncFile { file: name, json: text });
                }
            }
        }
    }
    // Newest mail first; the island keeps the last 30 days anyway.
    mail_names.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let mails = mail_names
        .into_iter()
        .take(MAX_MAIL_FILES)
        .filter_map(|(_, name)| read_text_max(&dir.join(&name), MAX_SMALL_FILE).map(|json| SyncFile { file: name, json }))
        .collect();
    Snapshot {
        stamp,
        files: ops,
        briefs,
        mails,
        answers,
        brief: read_text(&dir.join("brief.json")),
        mailbox: read_text(&dir.join("mailbox.json")),
    }
}

// ── Writing ───────────────────────────────────────────────────────────────────

/// Writes `bytes` to a temp file next to `path`, flushes it, then renames it
/// over `path`, so a reader (or Drive) never sees half a file. The temp name
/// starts with a dot and never matches the op file pattern.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.tmp-{}", std::process::id()));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    // Drive may hold the file for a moment while it uploads it (Windows): retry.
    let mut last = None;
    for attempt in 0..6 {
        match std::fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(Duration::from_millis(150 * (attempt + 1)));
            }
        }
    }
    let _ = std::fs::remove_file(&tmp);
    Err(last.unwrap_or_else(|| std::io::Error::other("rename failed")))
}

fn short_str(v: Option<&Value>, max: usize) -> bool {
    v.and_then(Value::as_str).is_some_and(|s| !s.is_empty() && s.len() <= max)
}

/// v2: `coll` (optional, default "tasks") + `key`; v1: `task`. One of `key`
/// and `task` must be there.
fn valid_op(op: &Value) -> bool {
    let Some(o) = op.as_object() else { return false };
    short_str(o.get("id"), 128)
        && o.get("ts").and_then(Value::as_f64).is_some_and(|t| t.is_finite() && t > 0.0)
        && (short_str(o.get("key"), 160) || short_str(o.get("task"), 160))
        && o.get("coll").is_none_or(|c| short_str(Some(c), 32))
        && o.get("set").is_some_and(Value::is_object)
}

/// (coll, key) of an op — v1 ops are ("tasks", task).
fn op_target(op: &Value) -> (String, String) {
    let coll = op.get("coll").and_then(Value::as_str).filter(|c| !c.is_empty()).unwrap_or("tasks");
    let key = op
        .get("key")
        .and_then(Value::as_str)
        .filter(|k| !k.is_empty())
        .or_else(|| op.get("task").and_then(Value::as_str))
        .unwrap_or("");
    (coll.to_string(), key.to_string())
}

fn op_key(op: &Value) -> (f64, String) {
    (
        op.get("ts").and_then(Value::as_f64).unwrap_or(0.0),
        op.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
    )
}

/// Keeps only the latest operation per (coll, key, field). An operation that still
/// wins at least one field keeps its id and timestamp, with only those fields,
/// so the fold gives exactly the same state. Safe because other devices only
/// ever read this file.
pub fn compact(ops: &[Value]) -> Vec<Value> {
    let mut sorted: Vec<&Value> = ops.iter().filter(|o| valid_op(o)).collect();
    sorted.sort_by(|a, b| {
        let (ta, ia) = op_key(a);
        let (tb, ib) = op_key(b);
        ta.partial_cmp(&tb).unwrap_or(std::cmp::Ordering::Equal).then(ia.cmp(&ib))
    });
    let mut winner: HashMap<(String, String, String), usize> = HashMap::new();
    for (i, op) in sorted.iter().enumerate() {
        let (coll, key) = op_target(op);
        if let Some(set) = op["set"].as_object() {
            for field in set.keys() {
                winner.insert((coll.clone(), key.clone(), field.clone()), i);
            }
        }
    }
    let mut kept: BTreeMap<usize, Map<String, Value>> = BTreeMap::new();
    for ((_, _, field), i) in winner {
        let value = sorted[i]["set"][&field].clone();
        kept.entry(i).or_default().insert(field, value);
    }
    kept.into_iter()
        .map(|(i, set)| {
            let op = sorted[i];
            // Fields in their original order, for a stable file.
            let mut ordered = Map::new();
            if let Some(orig) = op["set"].as_object() {
                for (k, _) in orig {
                    if let Some(v) = set.get(k) {
                        ordered.insert(k.clone(), v.clone());
                    }
                }
            }
            let mut out = Map::new();
            out.insert("id".into(), op["id"].clone());
            out.insert("ts".into(), op["ts"].clone());
            for k in ["coll", "key", "task"] {
                if let Some(v) = op.get(k) {
                    out.insert(k.into(), v.clone());
                }
            }
            out.insert("set".into(), Value::Object(ordered));
            Value::Object(out)
        })
        .collect()
}

/// Appends operations to our own file (creating it if needed), compacting it
/// past COMPACT_OVER. Returns how many operations the file now holds.
pub fn append(dir: &Path, ops: Vec<Value>) -> Result<usize, String> {
    if let Some(bad) = ops.iter().find(|o| !valid_op(o)) {
        return Err(format!("opération invalide : {bad}"));
    }
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (device_id, device_name) = device();
    std::fs::create_dir_all(dir).map_err(|e| format!("dossier de synchronisation inaccessible : {e}"))?;
    let path = dir.join(own_file_name(&device_id));

    let mut existing: Vec<Value> = Vec::new();
    if path.exists() {
        let parsed = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v.get("ops").and_then(Value::as_array).cloned());
        match parsed {
            Some(list) => existing = list,
            None => {
                // Only we write this file, atomically, so this should never
                // happen; if it does, keep the damaged copy aside (its name no
                // longer matches the pattern, so nobody reads it) and go on.
                let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                let aside = path.with_file_name(format!("{}.corrupt-{stamp}", own_file_name(&device_id)));
                let _ = std::fs::rename(&path, &aside);
                crate::log::line(format!("sync: own file unreadable, moved to {}", aside.display()));
            }
        }
    }

    let known: std::collections::HashSet<String> = existing
        .iter()
        .filter_map(|o| o.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    for op in ops {
        // Idempotent: a retried write never duplicates an operation.
        if !known.contains(op["id"].as_str().unwrap_or("")) {
            existing.push(op);
        }
    }
    if existing.len() > COMPACT_OVER {
        let before = existing.len();
        existing = compact(&existing);
        crate::log::line(format!("sync: compacted own file {before} → {} ops", existing.len()));
    }
    let count = existing.len();
    let doc = json!({ "version": 2, "writer": device_id, "device": device_name, "ops": existing });
    let bytes = serde_json::to_vec_pretty(&doc).map_err(|e| e.to_string())?;
    write_atomic(&path, &bytes).map_err(|e| format!("écriture impossible : {e}"))?;
    Ok(count)
}

// ── Free chat bridge (ask / answer files) ──────────────────────────────────────

/// Longest question (and history entry) we hand to the maison.
const MAX_ASK_TEXT: usize = 24_000;
/// ask/answer files of ours older than this are deleted.
pub const BRIDGE_KEEP_MS: u64 = 7 * 24 * 3600 * 1000;

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn clip(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Creates `ask-<deviceId>-<ms>.json` (atomically) from what the island sends:
/// `{ at, tiroir, text, history: [{role, content}] }`. Returns the ask id.
pub fn ask(dir: &Path, payload: &Value, ms: u64) -> Result<String, String> {
    let text = payload.get("text").and_then(Value::as_str).map(str::trim).unwrap_or("");
    if text.is_empty() {
        return Err("question vide".into());
    }
    let (device_id, device_name) = device();
    let id = format!("{device_id}-{ms}");
    let tiroir = if payload.get("tiroir").and_then(Value::as_str) == Some("perso") { "perso" } else { "pro" };
    let history: Vec<Value> = payload
        .get("history")
        .and_then(Value::as_array)
        .map(|h| {
            let turns: Vec<Value> = h
                .iter()
                .filter_map(|m| {
                    let role = m.get("role").and_then(Value::as_str)?;
                    let content = m.get("content").and_then(Value::as_str)?;
                    (role == "user" || role == "assistant")
                        .then(|| json!({ "role": role, "content": clip(content, MAX_ASK_TEXT) }))
                })
                .collect();
            // The six last turns at most.
            turns[turns.len().saturating_sub(6)..].to_vec()
        })
        .unwrap_or_default();
    let doc = json!({
        "id": id,
        "at": payload.get("at").and_then(Value::as_str).unwrap_or(""),
        "device": device_name,
        "tiroir": tiroir,
        "text": clip(text, MAX_ASK_TEXT),
        "history": history,
    });
    std::fs::create_dir_all(dir).map_err(|e| format!("dossier de synchronisation inaccessible : {e}"))?;
    let bytes = serde_json::to_vec_pretty(&doc).map_err(|e| e.to_string())?;
    write_atomic(&dir.join(format!("ask-{id}.json")), &bytes).map_err(|e| format!("écriture impossible : {e}"))?;
    Ok(id)
}

/// Deletes OUR ask / answer files older than `keep_ms` (by the time in their
/// name). Never touches anything else. Returns how many were removed.
pub fn cleanup_bridge(dir: &Path, now: u64, keep_ms: u64) -> usize {
    let (device_id, _) = device();
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let mut removed = 0;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let ms = bridge_ms(&name, "ask", &device_id).or_else(|| bridge_ms(&name, "answer", &device_id));
        if let Some(ms) = ms {
            if now.saturating_sub(ms) > keep_ms && std::fs::remove_file(e.path()).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

// ── Local state (this device only, never synced) ──────────────────────────────
//
// Which reminders already fired here, the day of the last morning summary…
// kept out of the shared log so two devices don't step on each other.

fn local_state_path() -> PathBuf {
    config_dir().join("local-state.json")
}

fn read_local() -> Map<String, Value> {
    std::fs::read(local_state_path())
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

pub fn local_get(key: &str) -> Option<Value> {
    read_local().get(key).cloned()
}

pub fn local_set(key: &str, value: Value) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut all = read_local();
    if value.is_null() {
        all.remove(key);
    } else {
        all.insert(key.to_string(), value);
    }
    platform::ensure_private_dir(&config_dir()).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(&Value::Object(all)).map_err(|e| e.to_string())?;
    write_atomic(&local_state_path(), &bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(id: &str, ts: u64, task: &str, set: Value) -> Value {
        json!({ "id": id, "ts": ts, "task": task, "set": set })
    }

    #[test]
    fn names() {
        assert!(is_ops_name("ops-macbook-pro-1a2b.json"));
        assert!(is_ops_name("ops-PC_42.json"));
        assert!(!is_ops_name("ops-x (1).json"));
        assert!(!is_ops_name("ops-.json"));
        assert!(!is_ops_name("ops-x.json.tmp"));
        assert!(!is_ops_name(".ops-x.json.tmp-12"));
        assert!(!is_ops_name("brief.json"));
    }

    #[test]
    fn slugs_and_ids() {
        assert_eq!(slug("MacBook-Pro-de-Camille.local"), "macbook-pro-de-camille-l");
        assert_eq!(slug("Été 2026!"), "t-2026");
        assert_eq!(slug("***"), "device");
        let r = random_suffix(8);
        assert_eq!(r.len(), 8);
        assert!(is_device_id(&format!("pc-{r}")));
    }

    #[test]
    fn compaction_keeps_latest_per_field() {
        let ops = vec![
            op("a", 1, "t1", json!({"title": "A", "done": false, "day": "2026-10-01"})),
            op("b", 2, "t1", json!({"title": "A2"})),
            op("c", 3, "t1", json!({"done": true})),
            op("d", 1, "t2", json!({"title": "B"})),
            op("e", 5, "t2", json!({"deleted": true})),
        ];
        let out = compact(&ops);
        let ids: Vec<&str> = out.iter().map(|o| o["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["a", "d", "b", "c", "e"]);
        assert_eq!(out[0]["set"], json!({"day": "2026-10-01"}));
        assert_eq!(out[2]["set"], json!({"title": "A2"}));
    }

    #[test]
    fn v2_names() {
        assert!(is_ops_name("ops-maison-1730000000000.json"));
        assert!(is_ops_name("ops-task-veille-1730000000000.json"));
        assert!(is_brief_name("brief-morning.json"));
        assert!(is_brief_name("brief-morning (1).json"));
        assert!(is_brief_name("brief-leisure-1730000000000.json"));
        assert!(!is_brief_name("brief.json"));
        assert!(!is_brief_name("brief-morning (x).json"));
        assert!(!is_brief_name(".brief-morning.json.tmp-1"));
        assert!(is_mail_name("mail-m-2026-10-05-1.json"));
        assert!(!is_mail_name("mailbox.json"));
        assert!(is_own_bridge("answer-mac-ab12-1730000000000.json", "answer", "mac-ab12"));
        assert!(!is_own_bridge("answer-pc-zz-1730000000000.json", "answer", "mac-ab12"));
        assert!(!is_own_bridge("answer-mac-ab12-17x.json", "answer", "mac-ab12"));
        assert!(is_own_bridge("ask-mac-ab12-5.json", "ask", "mac-ab12"));
        assert!(!is_own_bridge("ask-mac-ab12-5.json", "answer", "mac-ab12"));
    }

    #[test]
    fn v1_and_v2_ops_are_valid() {
        assert!(valid_op(&json!({"id": "a", "ts": 1, "task": "t", "set": {}})));
        assert!(valid_op(&json!({"id": "a", "ts": 1, "coll": "subs", "key": "s1", "set": {"name": "x"}})));
        assert!(valid_op(&json!({"id": "a", "ts": 1, "key": "t1", "set": {}})));
        assert!(!valid_op(&json!({"id": "a", "ts": 1, "coll": "subs", "set": {}})));
        assert!(!valid_op(&json!({"id": "a", "ts": 1, "coll": "", "key": "k", "set": {}})));
        assert!(!valid_op(&json!({"id": "a", "ts": 1, "coll": 3, "key": "k", "set": {}})));
    }

    #[test]
    fn compaction_is_per_collection() {
        let ops = vec![
            json!({"id": "a", "ts": 1, "coll": "tasks", "key": "k", "task": "k", "set": {"title": "T"}}),
            json!({"id": "b", "ts": 2, "coll": "shopping", "key": "k", "set": {"title": "S"}}),
            json!({"id": "c", "ts": 3, "task": "k", "set": {"title": "T2"}}),
        ];
        let out = compact(&ops);
        let ids: Vec<&str> = out.iter().map(|o| o["id"].as_str().unwrap()).collect();
        // v1 "c" and v2 tasks "a" share (tasks, k): "c" wins; shopping keeps "b".
        assert_eq!(ids, vec!["b", "c"]);
        assert_eq!(out[0]["coll"], json!("shopping"));
        assert_eq!(out[0]["key"], json!("k"));
        assert!(out[1].get("coll").is_none());
    }

    #[test]
    fn snapshot_reads_every_kind_and_bridge_files() {
        let dir = std::env::temp_dir().join(format!("nooky-sync-v2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (me, _) = device();
        let w = |n: &str, t: &str| std::fs::write(dir.join(n), t).unwrap();
        w("ops-maison-1730000000000.json", r#"{"version":2,"writer":"maison-x","ops":[]}"#);
        w("ops-maison-1730000000001.json", r#"{"version":2,"writer":"maison-x","ops":[]}"#);
        w("ops-x (1).json", "{}");
        w("brief-morning.json", r#"{"slot":"morning"}"#);
        w("brief-morning (1).json", r#"{"slot":"morning"}"#);
        w("mail-a.json", r#"{"id":"a"}"#);
        w(&format!("answer-{me}-1730000000000.json"), r#"{"id":"x","text":"ok"}"#);
        w("answer-someone-else-1730000000000.json", "{}");
        w("notes.txt", "x");
        let snap = read_all(&dir);
        assert_eq!(snap.files.len(), 2);
        assert_eq!(snap.briefs.len(), 2);
        assert_eq!(snap.mails.len(), 1);
        assert_eq!(snap.answers.len(), 1);
        assert!(snap.stamp.contains("brief-morning.json"));
        assert!(snap.stamp.contains("mail-a.json"));

        // ask → our own file, with the id in its name; history capped at 6 turns.
        let history: Vec<Value> = (0..9).map(|i| json!({"role": if i % 2 == 0 { "user" } else { "assistant" }, "content": format!("m{i}")})).collect();
        let id = ask(&dir, &json!({"text": " Bonjour ? ", "tiroir": "perso", "at": "2026-10-04T10:00:00.000Z", "history": history}), 1_730_000_000_500).unwrap();
        assert_eq!(id, format!("{me}-1730000000500"));
        let doc: Value = serde_json::from_slice(&std::fs::read(dir.join(format!("ask-{id}.json"))).unwrap()).unwrap();
        assert_eq!(doc["text"], json!("Bonjour ?"));
        assert_eq!(doc["tiroir"], json!("perso"));
        assert_eq!(doc["history"].as_array().unwrap().len(), 6);
        assert_eq!(doc["history"][0]["content"], json!("m3"));
        assert!(ask(&dir, &json!({"text": "  "}), 1).is_err());

        // Cleanup: only our own ask/answer files older than the window.
        let later = 1_730_000_000_500 + BRIDGE_KEEP_MS + 1;
        assert_eq!(cleanup_bridge(&dir, later, BRIDGE_KEEP_MS), 2);
        assert!(dir.join("answer-someone-else-1730000000000.json").exists());
        assert!(dir.join("mail-a.json").exists());
        assert_eq!(cleanup_bridge(&dir, later, BRIDGE_KEEP_MS), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn own_file_is_written_as_v2() {
        let dir = std::env::temp_dir().join(format!("nooky-sync-v2w-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        append(&dir, vec![json!({"id": "s1", "ts": 5, "coll": "shopping", "key": "k1", "set": {"label": "Lait"}})]).unwrap();
        let (me, _) = device();
        let doc: Value = serde_json::from_slice(&std::fs::read(dir.join(own_file_name(&me))).unwrap()).unwrap();
        assert_eq!(doc["version"], json!(2));
        assert_eq!(doc["writer"], json!(me));
        assert_eq!(doc["ops"][0]["coll"], json!("shopping"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn append_creates_dedupes_and_compacts() {
        let dir = std::env::temp_dir().join(format!("nooky-sync-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(append(&dir, vec![op("x1", 10, "t", json!({"title": "Hi"}))]).unwrap(), 1);
        assert_eq!(append(&dir, vec![op("x1", 10, "t", json!({"title": "Hi"}))]).unwrap(), 1);
        assert!(append(&dir, vec![json!({"id": "bad"})]).is_err());
        let many: Vec<Value> = (0..COMPACT_OVER as u64 + 5)
            .map(|i| op(&format!("m{i:05}"), 100 + i, "t", json!({"title": format!("v{i}")})))
            .collect();
        let n = append(&dir, many).unwrap();
        assert_eq!(n, 1, "only the latest title survives");
        let snap = read_all(&dir);
        assert_eq!(snap.files.len(), 1);
        assert!(snap.stamp.contains("ops-"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
