// Thin wrapper over the Tauri commands/events. Adapted from Coucou by Louis
// Raillé (MIT License, see LICENSE-COUCOU-MIT).
//
// Outside Tauri (`npm run dev` in a browser) every call goes to a dev-only mock
// (core/mock.ts) that keeps tasks in localStorage and fakes the sync folder,
// so the island can be built and tested without the native side.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Settings } from "./state";
import type { Op } from "../tasks/oplog";
import { Mock } from "./mock";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Browser-only stand-in for the Rust side (stripped from production builds). */
export const USE_MOCK = !IS_TAURI && import.meta.env.DEV;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) {
    if (USE_MOCK) return (await Mock.call(cmd, args)) as T | null;
    return null;
  }
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[nooky] ${cmd} failed`, err);
    return null;
  }
}

/** Same as `call`, but surfaces the error so the UI can show what went wrong. */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) {
    if (USE_MOCK) return (await Mock.call(cmd, args, true)) as T;
    throw new Error("Nooky n'est pas lancé.");
  }
  return invoke<T>(cmd, args);
}

export interface ScreenGeometry {
  hasNotch: boolean;
  notchW: number;
  notchH: number;
}

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: { x: number; y: number; width: number; height: number; scale: number };
  geometry: ScreenGeometry;
  version: string;
  /** False where the OS has no global cursor (Wayland): see Island.followPageCursor. */
  cursorPoll: boolean;
  os: string;
}

export interface SyncInfo {
  dir: string;
  mode: "drive" | "custom" | "local";
  detected: string | null;
  deviceId: string;
  deviceName: string;
  ownFile: string;
  customError: string | null;
}

export interface SyncFile {
  file: string;
  json: string;
}

export interface SyncSnapshot {
  stamp: string;
  /** ops-*.json */
  files: SyncFile[];
  /** brief-*.json */
  briefs: SyncFile[];
  /** mail-*.json */
  mails: SyncFile[];
  /** answer-<our deviceId>-*.json */
  answers: SyncFile[];
  /** Legacy v1 brief.json / mailbox.json. */
  brief: string | null;
  mailbox: string | null;
}

/** What the island hands to the maison through the free chat bridge. */
export interface AskPayload {
  at: string;
  tiroir: "pro" | "perso";
  text: string;
  history: { role: "user" | "assistant"; content: string }[];
}

export type ChatContext = { kind: "file"; name: string; path: string };

export interface DroppedFile {
  name: string;
  path: string;
  size: number;
}

export const Bridge = {
  boot: () => call<BootInfo>("boot"),

  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),

  /** Hidden island: shrink to the wake strip (Windows) or slow the poll (macOS). */
  setCollapsed: (collapsed: boolean) => call<void>("set_collapsed", { collapsed }),

  /**
   * Pushes the island shape in window coordinates. Rust flips click-through from
   * its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),

  /** Give the window keyboard focus (text fields) and take it away again. */
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),

  /** Places the island again; returns the geometry of its screen. */
  reposition: () => call<ScreenGeometry>("reposition"),

  openUrl: (url: string) => {
    if (!IS_TAURI) {
      window.open(url, "_blank", "noopener");
      return Promise.resolve(null);
    }
    return call<void>("open_url", { url });
  },

  quit: () => call<void>("quit_app"),

  openSettingsWindow: () => call<void>("open_settings_window"),

  /** Writes to Nooky's log file, next to the Rust lines. */
  log: (message: string) => call<void>("log_line", { message }),

  // ── Chat, files, secrets ──────────────────────────────────────────────────
  /** One chat turn. The API key and any file bytes never leave Rust. */
  chatSend: (query: string, context: ChatContext | null, extra: string | null) =>
    callOrThrow<{ text: string }>("chat_send", { query, context, extra }),
  chatReset: () => call<void>("chat_reset"),
  /** Copies a dropped file into the inbox. */
  ingestFile: (path: string) => callOrThrow<DroppedFile>("ingest_file", { path }),
  /** Only ever tells you whether a key exists — never its value. */
  secretPresent: (key: string) => call<boolean>("secret_present", { key }),
  secretSet: (key: string, value: string) => callOrThrow<void>("secret_set", { key, value }),
  secretClear: (key: string) => callOrThrow<void>("secret_clear", { key }),

  // ── Sync folder ───────────────────────────────────────────────────────────
  syncInfo: () => call<SyncInfo>("sync_info"),
  /** `null` = back to the detected Google Drive folder. */
  syncSetDir: (dir: string | null) => callOrThrow<SyncInfo>("sync_set_dir", { dir }),
  syncStamp: () => call<string>("sync_stamp"),
  syncReadAll: () => call<SyncSnapshot>("sync_read_all"),
  /** Appends to this device's own file — the only one it ever writes. */
  syncAppend: (ops: Op[]) => callOrThrow<number>("sync_append", { ops }),
  /** Free chat bridge: creates our ask-<deviceId>-<ms>.json, returns its id. */
  syncAsk: (ask: AskPayload) => callOrThrow<string>("sync_ask", { ask }),
  /** Deletes our own ask/answer files older than 7 days. */
  syncCleanupBridge: () => call<number>("sync_cleanup_bridge"),
  /** Text of a caught file (≤ 20 KB, plain text), for the bridge. */
  caughtText: (path: string) => callOrThrow<string>("caught_text", { path }),

  // ── This device's own little state (never synced) ─────────────────────────
  weather: (city: string) => call<string>("weather_get", { city }),
  localGet: <T>(key: string) => call<T>("local_get", { key }),
  localSet: (key: string, value: unknown) => call<void>("local_set", { key, value }),
};

/** Folder picker (plugin-dialog). Null when cancelled or unavailable. */
export async function pickFolder(title: string): Promise<string | null> {
  if (!IS_TAURI) return null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false, title });
    return typeof picked === "string" ? picked : null;
  } catch (err) {
    console.error("[nooky] folder picker failed", err);
    return null;
  }
}

/**
 * Native notification (Notification Center / Windows toasts). Permission is
 * asked the first time one is needed.
 */
export async function notify(title: string, body: string): Promise<void> {
  if (!IS_TAURI) {
    if (USE_MOCK) Mock.notified.push({ title, body });
    return;
  }
  try {
    const n = await import("@tauri-apps/plugin-notification");
    let granted = await n.isPermissionGranted();
    if (!granted) granted = (await n.requestPermission()) === "granted";
    if (granted) n.sendNotification({ title, body });
  } catch (err) {
    console.error("[nooky] notification failed", err);
  }
}

export interface DragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
  position?: { x: number; y: number };
}

/** Files dragged onto the island. Only reaches us when the window takes the mouse. */
export async function onDragDrop(handler: (e: DragDropPayload) => void) {
  if (!IS_TAURI) return () => {};
  return getCurrentWebview().onDragDropEvent((event) => {
    handler(event.payload as DragDropPayload);
  });
}

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) {
    if (USE_MOCK) return Mock.on(name, handler as (p: unknown) => void);
    return () => {};
  }
  return listen<T>(name, (e) => handler(e.payload));
}
