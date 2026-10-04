// macOS: AppKit for the island window (level above the menu bar, every Space,
// notch geometry), CoreGraphics for the cursor, ~/Library for files.
//
// Nooky Desktop — new code, written for this fork. The notch geometry follows
// the logic of IslandScreenGeometry / IslandWindowController in the macOS
// version of Coucou by Louis Raillé (MIT License, see LICENSE-COUCOU-MIT).
//
// How the island lives on a Mac:
//   * the window is a fixed 720×320 pt transparent panel glued to the top edge
//     of the screen, *over* the menu bar (level = main menu + 3, like Coucou);
//   * it never resizes: hidden, the island is a black shape exactly the size of
//     the notch (so it looks like the notch itself), or a zero-height sliver on
//     a screen without one;
//   * click-through is `ignoresMouseEvents`, flipped by the cursor poll
//     (island.rs) from CoreGraphics' cursor position, which any thread may read.

use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSScreen, NSWindow, NSWindowCollectionBehavior};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use tauri::{AppHandle, Manager, WebviewWindow};

use super::{home_dir, LocalTime, ScreenGeometry};

/// Environment variable holding the home directory.
pub const HOME_VAR: &str = "HOME";

/// The window keeps its full size on macOS: a hidden island is the notch, and
/// hover over it is read from the cursor poll, which keeps running (slowly).
pub const COLLAPSE_WINDOW: bool = false;

/// The poll reads the cursor from CoreGraphics.
pub const CURSOR_POLL: bool = true;

/// NSMainMenuWindowLevel (24) + 3 — the level Coucou's panel uses, above the
/// menu bar and its status items, below screen savers.
const ISLAND_LEVEL: isize = 24 + 3;

// ── Files ─────────────────────────────────────────────────────────────────────

/// ~/Library/Application Support/Nooky — preferences, device id, local state.
pub fn config_dir() -> PathBuf {
    home_dir().join("Library").join("Application Support").join("Nooky")
}

/// Same folder: the inbox of dropped files and the log live there too.
pub fn local_dir() -> PathBuf {
    config_dir()
}

/// Creates `dir` and closes it to other users.
pub fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

/// Nothing to set up before the webview starts.
pub fn prepare_environment() {}

pub fn local_time() -> LocalTime {
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        libc::localtime_r(&now, &mut tm);
    }
    LocalTime {
        year: (tm.tm_year + 1900) as u32,
        month: (tm.tm_mon + 1) as u32,
        day: tm.tm_mday as u32,
        hour: tm.tm_hour as u32,
        minute: tm.tm_min as u32,
        second: tm.tm_sec as u32,
    }
}

/// The machine's name, for the `device` field of the sync file.
pub fn hostname() -> String {
    let mut buf = [0u8; 256];
    let ok = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0;
    if !ok {
        return "Mac".into();
    }
    let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
    let name = String::from_utf8_lossy(&buf[..end]).to_string();
    name.trim_end_matches(".local").to_string()
}

// ── Processes ─────────────────────────────────────────────────────────────────

pub fn open_url(url: &str) {
    let _ = Command::new("/usr/bin/open").arg(url).spawn();
}

// ── Cursor (CoreGraphics — thread-safe, no permission needed) ─────────────────

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreate(source: *const c_void) -> *mut c_void;
    fn CGEventGetLocation(event: *mut c_void) -> CGPoint;
    fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const c_void);
}

/// Cursor in global display points, origin at the top-left of the main display.
fn cursor_global() -> Option<(f64, f64)> {
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return None;
        }
        let p = CGEventGetLocation(event);
        CFRelease(event as *const c_void);
        Some((p.x, p.y))
    }
}

/// kCGEventSourceStateCombinedSessionState, kCGMouseButtonLeft.
pub fn left_button_down() -> bool {
    unsafe { CGEventSourceButtonState(0, 0) }
}

/// Top-left corner of the island window in global display points (same space
/// as `cursor_global`), recorded each time the window is placed.
static PANEL_ORIGIN: Mutex<Option<(f64, f64)>> = Mutex::new(None);

/// Notch geometry of the screen the island is on, recorded with the placement.
static GEOMETRY: Mutex<ScreenGeometry> = Mutex::new(ScreenGeometry::NO_NOTCH);

/// Cursor in window-logical points.
pub fn cursor_logical(_win: &WebviewWindow) -> Option<(f64, f64)> {
    let origin = (*PANEL_ORIGIN.lock().unwrap())?;
    let (x, y) = cursor_global()?;
    Some((x - origin.0, y - origin.1))
}

pub fn geometry() -> ScreenGeometry {
    *GEOMETRY.lock().unwrap()
}

// ── Screens and the notch ─────────────────────────────────────────────────────

/// The notch (or camera housing) of `screen`, measured the way Coucou does:
/// the safe-area inset gives its height, and the gap between the two
/// auxiliary top areas its width (macOS 12+).
fn screen_geometry(screen: &NSScreen) -> ScreenGeometry {
    let frame = screen.frame();
    let insets = screen.safeAreaInsets();
    if insets.top <= 0.0 {
        return ScreenGeometry::NO_NOTCH;
    }
    let left = screen.auxiliaryTopLeftArea();
    let right = screen.auxiliaryTopRightArea();
    let measured = frame.size.width - left.size.width - right.size.width;
    let width = if left.size.width > 0.0
        && right.size.width > 0.0
        && measured > 0.0
        && measured < frame.size.width
    {
        measured
    } else {
        ScreenGeometry::FALLBACK_NOTCH_W
    };
    ScreenGeometry { has_notch: true, notch_w: width, notch_h: insets.top }
}

fn contains(frame: NSRect, x: f64, y: f64) -> bool {
    x >= frame.origin.x
        && x < frame.origin.x + frame.size.width
        && y >= frame.origin.y
        && y < frame.origin.y + frame.size.height
}

/// Places the island window at the top centre of the chosen screen, over the
/// menu bar, and records where it went. Must run on the main thread.
fn place_now(win: &WebviewWindow, pref: &str, panel_w: f64, panel_h: f64) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let screens = NSScreen::screens(mtm);
    if screens.count() == 0 {
        return;
    }
    // screens[0] is the screen with the menu bar; its frame starts at (0, 0) and
    // defines the flip between AppKit (bottom-left) and CoreGraphics (top-left).
    let primary_h = screens.objectAtIndex(0).frame().size.height;

    let mut chosen = None;
    if pref == "cursor" {
        if let Some((cx, cy)) = cursor_global() {
            let ay = primary_h - cy;
            chosen = screens.iter().find(|s| contains(s.frame(), cx, ay));
        }
    }
    if chosen.is_none() {
        // "primary" on a Mac means the notch screen when there is one — the
        // MacBook's own display, even with an external monitor as main display.
        chosen = screens.iter().find(|s| s.safeAreaInsets().top > 0.0);
    }
    let screen = chosen.unwrap_or_else(|| screens.objectAtIndex(0));

    let frame = screen.frame();
    let geo = screen_geometry(&screen);
    let x = frame.origin.x + ((frame.size.width - panel_w) / 2.0).round();
    let top = frame.origin.y + frame.size.height;
    let rect = NSRect::new(NSPoint::new(x, top - panel_h), NSSize::new(panel_w, panel_h));

    *GEOMETRY.lock().unwrap() = geo;
    *PANEL_ORIGIN.lock().unwrap() = Some((x, primary_h - top));

    if let Some(ns) = ns_window(win) {
        // setFrame:display: is not run through constrainFrameRect:, so the
        // window may sit over the menu bar and the notch.
        ns.setFrame_display(rect, true);
        apply_window_flags(ns);
    }
}

/// Places the island. Safe from any thread: the AppKit part is sent to the
/// main thread, and the geometry is updated before this returns when we are
/// already on it.
pub fn place_island(app: &AppHandle, win: &WebviewWindow, pref: &str, panel_w: f64, panel_h: f64) {
    if MainThreadMarker::new().is_some() {
        place_now(win, pref, panel_w, panel_h);
        return;
    }
    let win = win.clone();
    let pref = pref.to_string();
    let _ = app.run_on_main_thread(move || place_now(&win, &pref, panel_w, panel_h));
}

// ── Island window ─────────────────────────────────────────────────────────────

fn ns_window(win: &WebviewWindow) -> Option<&NSWindow> {
    let ptr = win.ns_window().ok()?;
    if ptr.is_null() {
        return None;
    }
    // The pointer is tao's NSWindow, alive as long as `win` is.
    Some(unsafe { &*(ptr as *const NSWindow) })
}

fn apply_window_flags(ns: &NSWindow) {
    ns.setLevel(ISLAND_LEVEL);
    ns.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    ns.setHidesOnDeactivate(false);
    ns.setHasShadow(false);
}

/// Level above the menu bar, on every Space and over full-screen apps, never in
/// the window cycle. Called from `setup`, on the main thread.
pub fn make_non_activating(win: &WebviewWindow) {
    if MainThreadMarker::new().is_none() {
        return;
    }
    if let Some(ns) = ns_window(win) {
        apply_window_flags(ns);
    }
}

/// The island only takes the keyboard while a text field needs it (chat,
/// tasks). Giving it back hands focus to whatever app had it before.
pub fn set_activating(win: &WebviewWindow, activating: bool) {
    let handle = win.app_handle().clone();
    let win = win.clone();
    let _ = handle.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let app = NSApplication::sharedApplication(mtm);
        if activating {
            #[allow(deprecated)]
            app.activateIgnoringOtherApps(true);
        } else if app.isActive() {
            // Only when the island has the focus — never pull it from Settings.
            let island = win.ns_window().ok().map(|p| p as *const c_void);
            let key = app.keyWindow().map(|k| Retained::as_ptr(&k) as *const c_void);
            if key.is_none() || key == island {
                app.deactivate();
            }
        }
    });
}

/// Brings a regular window (Settings) to the front of an accessory app.
pub fn bring_to_front(win: &WebviewWindow) {
    let handle = win.app_handle().clone();
    let _ = handle.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else { return };
        #[allow(deprecated)]
        NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
    });
}

/// AppKit delivers drags to the webview whatever `ignoresMouseEvents` says.
pub fn unblock_webview_drops(_app: &AppHandle) {}

/// Click-through is the poll's `set_ignore_cursor_events`, not a region.
pub fn set_input_region(_win: &WebviewWindow, _rect: Option<(f64, f64, f64, f64)>) {}
