// Nooky Desktop — app wiring and the commands the island calls.
// Adapted from Coucou by Louis Raillé (MIT License, see LICENSE-COUCOU-MIT).

mod claude;
mod files;
mod island;
mod log;
mod platform;
mod secrets;
mod settings;
mod sync;
mod tray;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

use claude::{Chat, ChatContext, ChatReply};
use files::DroppedFile;
use island::{PollGate, ScreenInfo};
use platform::ScreenGeometry;
use settings::Settings;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
}

impl Shared {
    fn sync_dir(&self) -> Option<String> {
        self.settings.lock().unwrap().sync_dir.clone()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    /// Notch (or no notch) of the screen the island is on.
    geometry: ScreenGeometry,
    version: String,
    /// False where the OS has no global cursor (Wayland): the page then reports
    /// the cursor from its own mouse events.
    cursor_poll: bool,
    /// "macos", "windows" or "linux" — for wording only.
    os: String,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let settings = shared.settings.lock().unwrap().clone();
    let screen = island::screen_info(&app, &settings.screen);
    BootInfo {
        settings,
        screen,
        geometry: platform::geometry(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        cursor_poll: platform::CURSOR_POLL,
        os: std::env::consts::OS.to_string(),
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) {
    let (screen_changed, autostart_changed) = {
        let mut current = shared.settings.lock().unwrap();
        let screen_changed = current.screen != settings.screen;
        let autostart_changed = current.autostart != settings.autostart;
        *current = settings.clone();
        (screen_changed, autostart_changed)
    };
    if let Err(err) = settings::save(&settings) {
        log::line(format!("could not save settings: {err}"));
    }
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            log::line(format!("autostart: {err}"));
        }
    }
    if screen_changed {
        let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
        island::apply_geometry(&app, &settings.screen, collapsed);
        let _ = app.emit_to(island::WINDOW_LABEL, "screen-changed", ());
    }
    // Keep the other window in step (island ⇄ settings window).
    let _ = app.emit("settings-changed", settings);
}

/// Hidden island → shrink the window to the invisible wake strip and park the
/// cursor poll (Windows), or keep the window and slow the poll down (macOS,
/// where the hidden island is the notch); anything else → full panel, 60 Hz.
#[tauri::command]
fn set_collapsed(app: AppHandle, shared: State<Shared>, collapsed: bool) {
    shared.gate.collapsed.store(collapsed, Ordering::Relaxed);
    if platform::COLLAPSE_WINDOW {
        let pref = shared.settings.lock().unwrap().screen.clone();
        island::apply_geometry(&app, &pref, collapsed);
    }
    // The wake strip must always take the mouse, and a resize invalidates the flag.
    island::refresh_click_through(&app, &shared.gate);
    shared.gate.set_active(!collapsed || !platform::COLLAPSE_WINDOW);
}

/// The front end pushes the island shape; Rust decides click-through from it.
#[tauri::command]
fn set_island_rect(app: AppHandle, shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    shared.gate.set_rect(island::IslandRect { x, y, w: width, h: height });
    // Without the cursor poll the input region is the click-through: it follows the island.
    if !platform::CURSOR_POLL {
        island::refresh_click_through(&app, &shared.gate);
    }
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let Some(win) = island::window(&app) else { return };
    platform::set_activating(&win, focused);
    if focused {
        let _ = win.set_focus();
    }
}

/// Places the island again (display change, setting change) and returns the
/// geometry of the screen it ended up on.
#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) -> ScreenGeometry {
    let pref = shared.settings.lock().unwrap().screen.clone();
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed && platform::COLLAPSE_WINDOW);
    platform::geometry()
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    platform::open_url(&url);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Lets the island write to the same log as the Rust side.
#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

// ── Chat, files and secrets ───────────────────────────────────────────────────

/// One chat turn. The API key and any file bytes stay on the Rust side.
/// `extra` is what the island knows right now (date, open tasks).
#[tauri::command]
async fn chat_send(
    shared: State<'_, Shared>,
    chat: State<'_, Chat>,
    query: String,
    context: Option<ChatContext>,
    extra: Option<String>,
) -> Result<ChatReply, String> {
    let (model, profile) = {
        let s = shared.settings.lock().unwrap();
        (s.model.clone(), claude::Profile { first_name: s.first_name.clone(), about_me: s.about_me.clone() })
    };
    claude::send(&chat, &model, &profile, query, context, extra).await
}

#[tauri::command]
fn chat_reset(chat: State<Chat>) {
    chat.reset();
}

/// Copies a dropped file into the inbox and reports its name back.
#[tauri::command]
async fn ingest_file(path: String) -> Result<DroppedFile, String> {
    tauri::async_runtime::spawn_blocking(move || files::ingest(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// The island may only ask whether a key exists — never read it.
#[tauri::command]
fn secret_present(key: String) -> bool {
    secrets::present(&key)
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    secrets::set(&key, &value)
}

#[tauri::command]
fn secret_clear(key: String) -> Result<(), String> {
    secrets::clear(&key)
}

// ── Sync folder ───────────────────────────────────────────────────────────────
//
// Everything that touches the folder runs on a blocking worker: with Google
// Drive in streaming mode, opening a file may first download it.

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn sync_info(shared: State<'_, Shared>) -> Result<sync::SyncInfo, String> {
    let custom = shared.sync_dir();
    blocking(move || sync::info(custom.as_deref())).await
}

/// `None` goes back to the detected Google Drive folder.
#[tauri::command]
async fn sync_set_dir(
    app: AppHandle,
    shared: State<'_, Shared>,
    dir: Option<String>,
) -> Result<sync::SyncInfo, String> {
    let dir = dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.sync_dir = dir.clone();
        current.clone()
    };
    if let Err(err) = settings::save(&updated) {
        log::line(format!("could not save settings: {err}"));
    }
    let _ = app.emit("settings-changed", updated);
    let info = blocking(move || sync::info(dir.as_deref())).await?;
    let _ = app.emit("sync-changed", info.clone());
    Ok(info)
}

#[tauri::command]
async fn sync_stamp(shared: State<'_, Shared>) -> Result<String, String> {
    let custom = shared.sync_dir();
    blocking(move || sync::stamp(&sync::resolve(custom.as_deref()).0)).await
}

#[tauri::command]
async fn sync_read_all(shared: State<'_, Shared>) -> Result<sync::Snapshot, String> {
    let custom = shared.sync_dir();
    blocking(move || sync::read_all(&sync::resolve(custom.as_deref()).0)).await
}

/// Appends operations to this device's own file — the only file we write.
#[tauri::command]
async fn sync_append(shared: State<'_, Shared>, ops: Vec<Value>) -> Result<usize, String> {
    let custom = shared.sync_dir();
    blocking(move || sync::append(&sync::resolve(custom.as_deref()).0, ops)).await?
}

/// Free chat bridge: creates our `ask-<deviceId>-<ms>.json`, returns its id.
#[tauri::command]
async fn sync_ask(shared: State<'_, Shared>, ask: Value) -> Result<String, String> {
    let custom = shared.sync_dir();
    blocking(move || sync::ask(&sync::resolve(custom.as_deref()).0, &ask, sync::now_ms())).await?
}

/// Deletes our own ask/answer files older than 7 days.
#[tauri::command]
async fn sync_cleanup_bridge(shared: State<'_, Shared>) -> Result<usize, String> {
    let custom = shared.sync_dir();
    blocking(move || sync::cleanup_bridge(&sync::resolve(custom.as_deref()).0, sync::now_ms(), sync::BRIDGE_KEEP_MS)).await
}

/// Text of a caught file (≤ 20 KB) for a question sent through the bridge.
#[tauri::command]
async fn caught_text(path: String) -> Result<String, String> {
    blocking(move || files::read_caught_text(&path, files::BRIDGE_TEXT_MAX)).await?
}

#[tauri::command]
fn local_get(key: String) -> Option<Value> {
    sync::local_get(&key)
}

#[tauri::command]
fn local_set(key: String, value: Value) -> Result<(), String> {
    sync::local_set(&key, value)
}

// ── Settings window ───────────────────────────────────────────────────────────

/// WebView2 allows exactly one browser environment per app, and its options are
/// fixed by whichever webview is created first. Every window must therefore ask
/// for the *same* arguments as the island (see `additionalBrowserArgs` in
/// tauri.conf.json) — a mismatch makes the second window come up blank.
#[cfg(windows)]
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// In a dev build the pages are served by Vite, so the second window needs the
/// absolute dev URL; a bundled build resolves it inside the app bundle.
fn settings_page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/settings.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("settings.html".into())
}

/// The settings window is created hidden at launch and only ever shown and
/// hidden afterwards. A WebView2 window created later silently comes up blank
/// in this app, so the window that works is the one that exists before the
/// island's webview does.
fn create_settings_window(app: &AppHandle) {
    let url = settings_page_url(app);
    let builder = WebviewWindowBuilder::new(app, "settings", url);
    #[cfg(windows)]
    let builder = builder.additional_browser_args(BROWSER_ARGS);
    match builder
        .title("Réglages de Nooky")
        .inner_size(560.0, 640.0)
        .min_inner_size(460.0, 420.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            // Closing it must only hide it, or it could never be reopened.
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
            });
        }
        Err(err) => log::line(format!("settings window failed: {err}")),
    }
}

pub fn show_settings_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("settings") else {
        log::line("settings window missing");
        return;
    };
    let _ = win.unminimize();
    let _ = win.show();
    platform::bring_to_front(&win);
    let _ = win.set_focus();
}

#[tauri::command]
fn open_settings_window(app: AppHandle) {
    show_settings_window(&app);
}

pub fn run() {
    platform::prepare_environment();
    let loaded = settings::load();
    let gate = Arc::new(PollGate::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = app.emit_to(island::WINDOW_LABEL, "tray", "open".to_string());
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        let _ = app.emit_to(island::WINDOW_LABEL, "tray", "shortcut".to_string());
                    }
                })
                .build(),
        )
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
        })
        .manage(Chat::default())
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            set_collapsed,
            set_island_rect,
            focus_window,
            reposition,
            open_url,
            quit_app,
            log_line,
            chat_send,
            chat_reset,
            ingest_file,
            secret_present,
            secret_set,
            secret_clear,
            sync_info,
            sync_set_dir,
            sync_stamp,
            sync_read_all,
            sync_append,
            sync_ask,
            sync_cleanup_bridge,
            caught_text,
            local_get,
            local_set,
            open_settings_window,
        ])
        .setup(move |app| {
            // A menu-bar app on macOS: no Dock icon, no app menu (Info.plist
            // says LSUIElement too, so the Dock icon never even flashes).
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let handle = app.handle().clone();
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
                // Already taken by another app? Then Nooky simply has no shortcut.
                let _ = handle
                    .global_shortcut()
                    .register(Shortcut::new(Some(Modifiers::CONTROL), Code::Space));
            }
            tray::build(&handle)?;
            // Before the island: see create_settings_window.
            create_settings_window(&handle);

            if let Some(win) = island::window(&handle) {
                platform::make_non_activating(&win);
                island::apply_geometry(&handle, &loaded.screen, false);
                let _ = win.show();
            }
            gate.collapsed.store(false, Ordering::Relaxed);
            // Nothing drawn yet, so nothing takes the mouse until the page
            // reports the island's shape.
            if !platform::CURSOR_POLL {
                island::refresh_click_through(&handle, &gate);
            }
            gate.set_active(true);
            island::spawn_cursor_poll(handle.clone(), gate.clone());

            log::line(format!("--- Nooky {} started ---", env!("CARGO_PKG_VERSION")));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Nooky");
}
