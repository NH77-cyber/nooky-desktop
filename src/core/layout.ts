// Island geometry. Adapted from Coucou by Louis Raillé (MIT License, see
// LICENSE-COUCOU-MIT): same panel, same sizes and corner radii, same motion.
// All values are logical pixels (points on a Mac).
//
// What changes with Nooky: the resting size follows the screen. On a Mac with
// a notch (or a camera housing) the hidden island is exactly the notch and the
// compact island grows out of it; elsewhere (Windows, external displays) the
// island retracts into the top edge, as on Coucou for Windows.

export type IslandMode = "hidden" | "compact" | "expanded";

export type IslandViewName =
  | "overview"
  | "tasks"
  | "prompt"
  | "reminder"
  | "morning"
  | "brief"
  | "upload"
  | "uploading"
  | "choose"
  | "note"
  | "confused"
  | "welcome"
  | "update"
  | "greeting"
  | "shopping"
  | "subs"
  | "agenda"
  | "watch"
  | "mail"
  | "recap"
  | "pause"
  | "notice";

export type BotStateName =
  | "idle"
  | "working"
  | "thinking"
  | "searching"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "ratelimit"
  | "sleeping"
  | "dizzy";

export type BotEmoteName = "love" | "surprised" | "proud" | "wink" | "yawn" | "happy" | "annoyed";

export interface ViewLayout {
  height: number;
  botX: number;
  botY: number | null; // null = centred in the content area
  botDiameter: number;
}

// The window is a fixed 720×320 (largest view); the island is drawn inside it,
// glued to the top edge and horizontally centred.
export const PANEL_W = 720;
export const PANEL_H = 320;

export const EXPANDED_W = 640;
export const ROUNDED_CORNER = 14; // hidden / compact
export const EXPANDED_CORNER = 22;

/** Invisible hover strip that wakes the island when hidden (Windows). */
export const WAKE_STRIP_W = 240;
export const WAKE_STRIP_H = 6;

/** The notch (or its stand-in) of the screen the island is on. Set from Rust. */
export const Geo = {
  hasNotch: false,
  notchW: 184,
  notchH: 32,
};

export function setGeometry(g: { hasNotch: boolean; notchW: number; notchH: number } | null | undefined) {
  if (!g) return;
  Geo.hasNotch = !!g.hasNotch;
  Geo.notchW = Math.max(80, Math.min(400, g.notchW || 184));
  Geo.notchH = Math.max(22, Math.min(60, g.notchH || 32));
}

/** Compact width: the notch plus a wing on each side (80 pt), or 288 without one. */
export function compactWidth(): number {
  return Geo.hasNotch ? Geo.notchW + 160 : 288;
}

/** Header bottom: 8 pt top inset + 34 pt header. */
export const HEADER_BOTTOM = 42;

export const VIEW_LAYOUTS: Record<IslandViewName, ViewLayout> = {
  overview: { height: 222, botX: 70, botY: null, botDiameter: 60 },
  tasks: { height: 300, botX: 54, botY: 92, botDiameter: 44 },
  prompt: { height: 240, botX: 46, botY: 96, botDiameter: 42 },
  reminder: { height: 168, botX: 74, botY: null, botDiameter: 62 },
  morning: { height: 200, botX: 74, botY: null, botDiameter: 62 },
  brief: { height: 300, botX: 54, botY: 92, botDiameter: 44 },
  upload: { height: 176, botX: 100, botY: null, botDiameter: 62 },
  uploading: { height: 176, botX: 46, botY: 103, botDiameter: 22 },
  choose: { height: 176, botX: 74, botY: null, botDiameter: 62 },
  note: { height: 160, botX: 70, botY: null, botDiameter: 58 },
  confused: { height: 160, botX: 76, botY: null, botDiameter: 64 },
  welcome: { height: 200, botX: 74, botY: null, botDiameter: 62 },
  update: { height: 168, botX: 74, botY: null, botDiameter: 62 },
  greeting: { height: 150, botX: 320, botY: 90, botDiameter: 0 },
  shopping: { height: 300, botX: 54, botY: 92, botDiameter: 44 },
  subs: { height: 290, botX: 54, botY: 92, botDiameter: 44 },
  agenda: { height: 290, botX: 54, botY: 92, botDiameter: 44 },
  watch: { height: 280, botX: 54, botY: 92, botDiameter: 44 },
  mail: { height: 300, botX: 54, botY: 92, botDiameter: 44 },
  recap: { height: 224, botX: 70, botY: null, botDiameter: 60 },
  pause: { height: 168, botX: 74, botY: null, botDiameter: 62 },
  notice: { height: 168, botX: 74, botY: null, botDiameter: 62 },
};

/** Views whose height follows their content (registered by the views). */
export const DynamicHeights: Partial<Record<IslandViewName, () => number>> = {};

/** Height of an expanded view. */
export function viewHeight(view: IslandViewName, chatCount = 0): number {
  if (view === "prompt") return chatPromptHeight(chatCount);
  return DynamicHeights[view]?.() ?? VIEW_LAYOUTS[view].height;
}

/** Chat view grows with the conversation. */
export function chatPromptHeight(messageCount: number): number {
  return Math.min(300, 240 + messageCount * 30);
}

export function islandSize(
  mode: IslandMode,
  view: IslandViewName,
  chatCount = 0,
): { w: number; h: number } {
  switch (mode) {
    case "hidden":
      // With a notch the island *is* the notch; without one it retracts into
      // the top edge of the screen.
      return Geo.hasNotch ? { w: Geo.notchW, h: Geo.notchH } : { w: Geo.notchW, h: 0 };
    case "compact":
      return { w: compactWidth(), h: Geo.notchH };
    case "expanded":
      return { w: EXPANDED_W, h: viewHeight(view, chatCount) };
  }
}

export interface BotPlacement {
  cx: number;
  cy: number;
  diameter: number;
  opacity: number;
}

/** Where Nooky sits — cy is measured from the island's top edge. */
export function botPosition(
  mode: IslandMode,
  view: IslandViewName,
  islandH: number,
  uploadProgress = 0,
): BotPlacement {
  switch (mode) {
    case "hidden":
      return { cx: 40, cy: Geo.notchH / 2, diameter: 6, opacity: 0 };
    case "compact":
      return { cx: 40, cy: Geo.notchH / 2, diameter: Math.min(20, Math.max(0, Geo.notchH - 6)), opacity: 1 };
    case "expanded": {
      const layout = VIEW_LAYOUTS[view];
      if (view === "uploading") {
        // Nooky rides the leading edge of the progress bar (left 36, width 526).
        return { cx: 36 + uploadProgress * 526, cy: layout.botY ?? 103, diameter: layout.botDiameter, opacity: 1 };
      }
      if (layout.botY != null) {
        return { cx: layout.botX, cy: layout.botY, diameter: layout.botDiameter, opacity: 1 };
      }
      const cy = HEADER_BOTTOM + (islandH - HEADER_BOTTOM - 10) / 2;
      return { cx: layout.botX, cy, diameter: layout.botDiameter, opacity: 1 };
    }
  }
}

/** Glow behind Nooky; `accent` (the pro / perso colour) when nothing is going on. */
export function botGlowColor(s: BotStateName, accent = "#8B7CFF"): string {
  switch (s) {
    case "working":
    case "searching":
      return "#3B9EFF";
    case "thinking":
      return "#A78BFA";
    case "approval":
      return "#F5A524";
    case "question":
      return "#22D3EE";
    case "error":
      return "#F4505E";
    case "finished":
      return "#34D399";
    case "ratelimit":
      return "#F59E0B";
    default:
      return accent;
  }
}

export function botGlowOpacity(s: BotStateName): number {
  switch (s) {
    case "idle":
      return 0.16;
    case "sleeping":
      return 0.12;
    case "dizzy":
      return 0;
    default:
      return 0.6;
  }
}

// Card wash colours (radial glow at the bottom of a card).
export type Wash = "red" | "green" | "pink" | "amber" | "cyan" | "indigo" | "violet" | "soft" | null;

export function washRGBA(wash: Wash): string {
  switch (wash) {
    case "red":
      return "rgba(244,80,94,0.55)";
    case "green":
      return "rgba(52,211,153,0.5)";
    case "pink":
      return "rgba(244,114,182,0.55)";
    case "amber":
      return "rgba(245,165,36,0.42)";
    case "cyan":
      return "rgba(34,211,238,0.38)";
    case "indigo":
      return "rgba(99,102,241,0.5)";
    case "violet":
      return "rgba(139,124,255,0.42)";
    case "soft":
      return "rgba(255,255,255,0.08)";
    default:
      return "rgba(0,0,0,0)";
  }
}
