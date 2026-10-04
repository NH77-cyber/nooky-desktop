// App state — the parts the island needs. Adapted from Coucou by Louis Raillé
// (MIT License, see LICENSE-COUCOU-MIT).

import type { BotStateName, IslandMode, IslandViewName } from "./layout";

export interface ChatMessage {
  id: number;
  role: "user" | "assistant" | "note";
  content: string;
  /** A small action under a note ("Annuler", "Ajouter ces 3 tâches", "Ouvrir la maison"). */
  action?: { label: string; run: () => void };
  /** Rendered as simple markdown (bridge answers). */
  markdown?: boolean;
}

/** A card for a subscription, a trial or an event (reminders.ts → island). */
export interface NoticeCard {
  label: string;
  title: string;
  sub: string;
  view: IslandViewName;
}

export interface Settings {
  soundEnabled: boolean;
  /** 0…1 */
  soundVolume: number;
  autoCloseInterval: number;
  screen: "primary" | "cursor";
  autostart: boolean;
  /** Claude model used by the chat. */
  model: string;
  /** Hand-picked sync folder; null = Google Drive, detected. */
  syncDir: string | null;
  /** "Ton prénom" — greeting and chat. Empty = "Bonjour !" and the welcome card. */
  firstName: string;
  /** "Ce que Nooky doit savoir sur toi" — appended to the chat's system prompt. */
  aboutMe: string;
  /** "Lien de la maison" — the overview button is hidden when empty. */
  maisonUrl: string;
}

/** Models offered in the settings (ids as published by Anthropic). */
export const MODELS: [string, string][] = [
  ["claude-sonnet-5-5", "Claude Sonnet 5.5 (conseillé)"],
  ["claude-haiku-4-5", "Claude Haiku 4.5 (économique)"],
  ["claude-opus-5-5", "Claude Opus 5.5 (le plus fort, plus cher)"],
];

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.5,
  autoCloseInterval: 15,
  screen: "primary",
  autostart: false,
  model: "claude-sonnet-5-5",
  syncDir: null,
  firstName: "",
  aboutMe: "",
  maisonUrl: "",
};

/** "Bonjour Camille !" / "Bonsoir !" (after 18:00), from the settings. */
export function hello(now = new Date()): string {
  const word = now.getHours() >= 18 ? "Bonsoir" : "Bonjour";
  const name = (State.settings.firstName ?? "").trim();
  return name ? `${word} ${name} !` : `${word} !`;
}

/** The "Lien de la maison", if it is a web link. */
export function maisonUrl(): string | null {
  const u = (State.settings.maisonUrl ?? "").trim();
  return /^https?:\/\/\S+$/i.test(u) ? u : null;
}

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  /** Mood forced by what is going on (thinking, reminder, dizzy…). */
  stateOverride: BotStateName | null = null;

  /** Cursor in window-logical pixels, origin top-left of the panel. */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  uploadProgress = 0;
  fileDragOver = false;

  droppedFile: { name: string; path: string } | null = null;
  /** Text dropped on the island (instead of a file). */
  droppedText: string | null = null;
  /** The notice card on screen. */
  notice: NoticeCard | null = null;
  /** Free chat bridge: the question waiting for the maison's answer. */
  pendingAsk: { id: string; since: number; closedNoted: boolean } | null = null;
  noteMessage: string | null = null;
  chatHistory: ChatMessage[] = [];
  hasApiKey = false;

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? "idle";
  }

  defaultView(): IslandViewName {
    return "overview";
  }
}

export const State = new AppState();
