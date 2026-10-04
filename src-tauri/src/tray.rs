// Menu-bar icon (macOS) / notification-area icon (Windows): Ouvrir, Réglages,
// Pause, Quitter. Adapted from Coucou by Louis Raillé (MIT License).

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter};

use crate::island::WINDOW_LABEL;

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Ouvrir Nooky", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Réglages…", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause / reprendre", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", "Rechercher une mise à jour…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quitter Nooky", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[&open, &sep1, &settings, &pause, &update, &sep2, &quit])?;

    let mut builder = TrayIconBuilder::with_id("nooky")
        .tooltip("Nooky")
        .menu(&menu)
        .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "settings" => crate::show_settings_window(app),
            id => {
                let _ = app.emit_to(WINDOW_LABEL, "tray", id.to_string());
            }
        });

    // macOS: a monochrome template cloud, tinted by the system like every
    // other menu-bar icon. Windows: the colour app icon.
    #[cfg(target_os = "macos")]
    match tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png")) {
        Ok(icon) => builder = builder.icon(icon).icon_as_template(true),
        Err(_) => {
            if let Some(icon) = app.default_window_icon().cloned() {
                builder = builder.icon(icon);
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}
