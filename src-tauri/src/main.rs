// Nooky runs without a console window: Nooky is the whole UI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    nooky_lib::run()
}
