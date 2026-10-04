// Pro / perso hours — pure functions (no DOM, no Tauri), shared by the island,
// the settings window and the tests. Nooky Desktop — original code.
// Rule (SYNC-FORMAT.md §5): "pro" during prefs.main.proHours, "perso" otherwise.

export type Tiroir = "pro" | "perso";

export interface ProHours {
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  days: number[];
  /** "HH:MM" */
  start: string;
  /** "HH:MM" */
  end: string;
}

export const DEFAULT_PRO_HOURS: ProHours = { days: [1, 2, 3, 4, 5], start: "08:30", end: "18:30" };

export const ACCENT: Record<Tiroir, { hex: string; rgb: [number, number, number]; label: string }> = {
  pro: { hex: "#f1b45c", rgb: [241, 180, 92], label: "Pro" },
  perso: { hex: "#6fd6b4", rgb: [111, 214, 180], label: "Perso" },
};

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 1 = Monday … 7 = Sunday. */
export const isoDow = (d: Date) => d.getDay() || 7;

/** Cleans whatever came from the synced prefs; falls back to the defaults. */
export function normHours(v: unknown): ProHours {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const days = Array.isArray(o.days)
    ? [...new Set(o.days.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort()
    : DEFAULT_PRO_HOURS.days;
  const start = typeof o.start === "string" && HM.test(o.start) ? o.start : DEFAULT_PRO_HOURS.start;
  const end = typeof o.end === "string" && HM.test(o.end) ? o.end : DEFAULT_PRO_HOURS.end;
  return { days, start, end };
}

const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const at = (d: Date, hm: string) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), Number(hm.slice(0, 2)), Number(hm.slice(3, 5)));

/** The mode the clock says, without any manual switch. */
export function autoMode(h: ProHours, now = new Date()): Tiroir {
  if (!h.days.includes(isoDow(now))) return "perso";
  const m = now.getHours() * 60 + now.getMinutes();
  return m >= minutes(h.start) && m < minutes(h.end) ? "pro" : "perso";
}

/** The next moment the automatic mode flips (a start or an end of the pro hours). */
export function nextBoundary(h: ProHours, now = new Date()): Date {
  for (let i = 0; i < 15; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    if (!h.days.includes(isoDow(d))) continue;
    for (const hm of [h.start, h.end]) {
      const b = at(d, hm);
      if (b.getTime() > now.getTime()) return b;
    }
  }
  return new Date(now.getTime() + 24 * 3600e3);
}

export interface ModeOverride {
  mode: Tiroir;
  /** Epoch ms: the override lapses at the next boundary. */
  until: number;
}

/** The mode in force: a manual switch wins until the next boundary. */
export function currentMode(h: ProHours, override: ModeOverride | null, now = new Date()): Tiroir {
  if (override && now.getTime() < override.until) return override.mode;
  return autoMode(h, now);
}

/** Flips the current mode by hand, until the next boundary. */
export function toggleOverride(h: ProHours, override: ModeOverride | null, now = new Date()): ModeOverride {
  const cur = currentMode(h, override, now);
  return { mode: cur === "pro" ? "perso" : "pro", until: nextBoundary(h, now).getTime() };
}

/** Monday–Friday, the default "workdays" for the evening recap and routines. */
export const isWorkday = (d: Date) => isoDow(d) <= 5;
