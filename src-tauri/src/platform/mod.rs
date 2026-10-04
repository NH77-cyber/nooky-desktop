// Everything that differs between operating systems, behind one set of names.
// Adapted from Coucou by Louis Raillé (MIT License, see LICENSE-COUCOU-MIT).
//
// The rest of the app calls `platform::…` and never touches Win32, AppKit or a
// Linux API directly. Each OS file exposes the same functions; the compiler
// picks one.

use std::path::PathBuf;

use serde::Serialize;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::*;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use self::macos::*;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use self::linux::*;

/// Wall-clock time in the user's time zone, for log lines.
pub struct LocalTime {
    pub year: u32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

/// What the island has to fit around at the top of the screen. On a Mac with a
/// notch (or a camera housing) the hidden island *is* the notch; everywhere
/// else there is nothing there and the island retracts into the edge.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenGeometry {
    pub has_notch: bool,
    /// Logical width of the resting island (the notch width when there is one).
    pub notch_w: f64,
    /// Logical height of the compact island (the notch height when there is one).
    pub notch_h: f64,
}

impl ScreenGeometry {
    /// Used when macOS reports a notch but not the areas on either side of it.
    #[allow(dead_code)]
    pub const FALLBACK_NOTCH_W: f64 = 184.0;
    /// No notch: the PC sizes from Coucou's spec.
    pub const NO_NOTCH: Self = Self { has_notch: false, notch_w: 184.0, notch_h: 32.0 };
}

/// The user's home directory.
pub fn home_dir() -> PathBuf {
    std::env::var_os(HOME_VAR)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}
