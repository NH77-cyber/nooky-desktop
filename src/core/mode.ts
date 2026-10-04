// The pro / perso mode in force, with its accent colour. The hours come from
// the synced prefs (coll "prefs", key "main"); a manual switch from the island
// header is kept on this device only, until the next boundary.
// Nooky Desktop — original code.

import { Bridge } from "./bridge";
import {
  ACCENT, DEFAULT_PRO_HOURS, currentMode, normHours, toggleOverride,
  type ModeOverride, type ProHours, type Tiroir,
} from "./hours";

class ModeState {
  hours: ProHours = { ...DEFAULT_PRO_HOURS };
  override: ModeOverride | null = null;
  /** "Tout voir" in Ma journée: show both pro and perso tasks. */
  showAll = false;
  private loaded = false;

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    const o = await Bridge.localGet<ModeOverride>("modeOverride");
    if (o && (o.mode === "pro" || o.mode === "perso") && typeof o.until === "number") this.override = o;
  }

  setHours(v: unknown) {
    this.hours = normHours(v);
  }

  current(now = new Date()): Tiroir {
    return currentMode(this.hours, this.override, now);
  }

  get manual(): boolean {
    return !!this.override && Date.now() < this.override.until;
  }

  toggle(now = new Date()) {
    this.override = toggleOverride(this.hours, this.override, now);
    void Bridge.localSet("modeOverride", this.override);
  }
}

export const Mode = new ModeState();

export function modeAccent(now?: Date) {
  return ACCENT[Mode.current(now)];
}

export { ACCENT };
export type { Tiroir };
