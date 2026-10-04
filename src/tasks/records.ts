// The other collections of format v2 — shopping, subs, events, watch, prefs —
// read from folded records. Pure functions only. Nooky Desktop — original code.

import { DEFAULT_PRO_HOURS, normHours, type ProHours } from "../core/hours";
import { isDay, isTime, type Rec } from "./oplog";
import { addDays, daysBetween, dayKey, toDate } from "./parse";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : []);

// ── Shopping ──────────────────────────────────────────────────────────────────

export interface ShoppingItem {
  key: string;
  label: string;
  done: boolean;
  doneAt: string | null;
  firstTs: number;
}

export function toShopping(r: Rec): ShoppingItem | null {
  if (r.deleted === true) return null;
  const label = str(r.label).trim();
  if (!label) return null;
  return { key: r.key, label, done: r.done === true, doneAt: str(r.doneAt) || null, firstTs: r.firstTs };
}

/** To buy first (in the order they were added), then the ones already in the cart. */
export function sortShopping(items: ShoppingItem[]): ShoppingItem[] {
  return [...items].sort((a, b) => Number(a.done) - Number(b.done) || a.firstTs - b.firstTs);
}

// ── Subscriptions ─────────────────────────────────────────────────────────────

export interface Sub {
  key: string;
  name: string;
  price: number;
  cycle: "monthly" | "yearly";
  nextRenewal: string;
  trialEnd: string | null;
  category: "jeux" | "streaming" | "autre";
}

export function toSub(r: Rec): Sub | null {
  if (r.deleted === true) return null;
  const name = str(r.name).trim();
  const price = typeof r.price === "number" && Number.isFinite(r.price) ? r.price : NaN;
  if (!name || !(price >= 0) || !isDay(r.nextRenewal)) return null;
  return {
    key: r.key,
    name,
    price,
    cycle: r.cycle === "yearly" ? "yearly" : "monthly",
    nextRenewal: r.nextRenewal,
    trialEnd: isDay(r.trialEnd) ? r.trialEnd : null,
    category: r.category === "jeux" || r.category === "streaming" ? r.category : "autre",
  };
}

/** Adds one cycle to a "YYYY-MM-DD", keeping the day (clamped to short months). */
export function addCycle(day: string, cycle: Sub["cycle"], orig = toDate(day).getDate()): string {
  const d = toDate(day);
  const y = d.getFullYear() + (cycle === "yearly" ? 1 : 0);
  const m = d.getMonth() + (cycle === "monthly" ? 1 : 0);
  const last = new Date(y, m + 1, 0).getDate();
  return dayKey(new Date(y, m, Math.min(orig, last)));
}

/**
 * The renewal date to show: nextRenewal, rolled forward by whole cycles while
 * it is in the past (a display rule — nothing is written).
 */
export function effectiveRenewal(s: Sub, today = dayKey()): string {
  let d = s.nextRenewal;
  const orig = toDate(d).getDate();
  for (let i = 0; i < 400 && d < today; i++) d = addCycle(d, s.cycle, orig);
  return d;
}

/** Monthly total: monthly prices + yearly prices / 12, rounded to the cent. */
export function monthlyTotal(subs: Sub[]): number {
  const t = subs.reduce((sum, s) => sum + (s.cycle === "yearly" ? s.price / 12 : s.price), 0);
  return Math.round(t * 100) / 100;
}

export const euros = (n: number) => `${n.toFixed(2).replace(".", ",")} €`;

/** "12/10" */
export const shortDate = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

export const daysUntil = (day: string, today = dayKey()) => daysBetween(today, day);

/** "aujourd'hui", "demain", "dans 3 jours", "le 12/10". */
export function whenLabel(day: string, today = dayKey()): string {
  const n = daysUntil(day, today);
  if (n === 0) return "aujourd'hui";
  if (n === 1) return "demain";
  if (n > 1 && n <= 6) return `dans ${n} jours`;
  return `le ${shortDate(day)}`;
}

// ── Events (agenda) ───────────────────────────────────────────────────────────

export type EventKind = "ecole" | "anniv" | "rdv" | "autre";

export interface AgendaEvent {
  key: string;
  title: string;
  date: string;
  time: string | null;
  kind: EventKind;
  remindDaysBefore: number;
  /** A calendar meeting (written by the planned agenda task): reminded 15 min before. */
  meeting?: boolean;
  location?: string;
}

/** The next meeting today that starts within `withinMin` minutes (and has not started more than 2 min ago). */
export function nextMeeting(events: AgendaEvent[], now = new Date(), withinMin = 180): { e: AgendaEvent; min: number } | null {
  let best: { e: AgendaEvent; min: number } | null = null;
  for (const e of events) {
    if (!e.meeting || !e.time) continue;
    const start = new Date(`${e.date}T${e.time}:00`).getTime();
    const min = Math.ceil((start - now.getTime()) / 60_000);
    if (min < -2 || min > withinMin) continue;
    if (!best || min < best.min) best = { e, min };
  }
  return best;
}

export function toEvent(r: Rec): AgendaEvent | null {
  if (r.deleted === true) return null;
  const title = str(r.title).trim();
  if (!title || !isDay(r.date)) return null;
  const kind = r.kind === "ecole" || r.kind === "anniv" || r.kind === "rdv" ? r.kind : "autre";
  const n = Number(r.remindDaysBefore);
  return {
    key: r.key, title, date: r.date, time: isTime(r.time) ? r.time : null, kind,
    remindDaysBefore: Number.isFinite(n) && n >= 0 ? Math.min(60, Math.round(n)) : 1,
    meeting: r.meeting === true,
    location: str(r.location).trim(),
  };
}

/** Events from today to today + `days`, by date and time. */
export function upcoming(events: AgendaEvent[], today = dayKey(), days = 14): AgendaEvent[] {
  const end = addDays(today, days);
  return events
    .filter((e) => e.date >= today && e.date <= end)
    .sort((a, b) => (a.date + (a.time ?? "99")).localeCompare(b.date + (b.time ?? "99")));
}

/** Guess the kind of an event from its title. */
export function eventKind(title: string): EventKind {
  const t = title.toLowerCase();
  if (/\banniv|\banniversaire|\bfête de\b/.test(t)) return "anniv";
  if (/\b(école|ecole|classe|maîtresse|maitresse|kermesse|sortie scolaire|réunion parents|vacances scolaires|cantine|collège|college)\b/.test(t)) return "ecole";
  if (/\b(rdv|rendez-vous|médecin|medecin|dentiste|docteur|kiné|kine|coiffeur|garage|vétérinaire|veterinaire)\b/.test(t)) return "rdv";
  return "autre";
}

export const EVENT_KIND_LABEL: Record<EventKind, string> = { ecole: "école", anniv: "anniv", rdv: "rdv", autre: "" };

// ── Watch list ────────────────────────────────────────────────────────────────

export interface WatchItem {
  key: string;
  title: string;
  kind: "jeu" | "serie" | "film";
  platform: string;
  note: string;
  firstTs: number;
}

export function toWatch(r: Rec): WatchItem | null {
  if (r.deleted === true) return null;
  const title = str(r.title).trim();
  if (!title) return null;
  const kind = r.kind === "jeu" || r.kind === "film" ? r.kind : "serie";
  return { key: r.key, title, kind, platform: str(r.platform), note: str(r.note), firstTs: r.firstTs };
}

export const WATCH_KIND_LABEL: Record<WatchItem["kind"], string> = { jeu: "jeu", serie: "série", film: "film" };

/**
 * "Zelda jeu Switch", "The Bear (série, Disney+)", "Dune film" → title, kind,
 * platform (a word from the user's platforms / streaming services, if any).
 */
export function parseWatch(raw: string, known: string[] = []): { title: string; kind: WatchItem["kind"]; platform: string } | null {
  let s = ` ${raw.replace(/[(),]/g, " ")} `;
  let kind: WatchItem["kind"] = "serie";
  const k = s.match(/\s(jeu|jeu vidéo|série|serie|film)\s/i);
  if (k) {
    kind = /^jeu/i.test(k[1]) ? "jeu" : /^film/i.test(k[1]) ? "film" : "serie";
    s = s.replace(k[0], " ");
  }
  let platform = "";
  for (const p of [...known].sort((a, b) => b.length - a.length)) {
    const i = s.toLowerCase().indexOf(` ${p.toLowerCase()} `);
    if (p && i >= 0) {
      platform = p;
      s = s.slice(0, i) + " " + s.slice(i + p.length + 2);
      break;
    }
  }
  const title = s.replace(/\s+/g, " ").trim();
  if (!title) return null;
  return { title: title.charAt(0).toUpperCase() + title.slice(1), kind, platform };
}

// ── Prefs (single record "main") ──────────────────────────────────────────────

export interface Prefs {
  prenom: string;
  proHours: ProHours;
  platforms: string[];
  streaming: string[];
  schoolZone: "A" | "B" | "C" | "";
  eveningRecap: string;
}

export const DEFAULT_PREFS: Prefs = {
  prenom: "",
  proHours: DEFAULT_PRO_HOURS,
  platforms: [],
  streaming: [],
  schoolZone: "",
  eveningRecap: "18:00",
};

export function toPrefs(r: Rec | undefined): Prefs {
  if (!r) return { ...DEFAULT_PREFS };
  return {
    prenom: str(r.prenom).trim(),
    proHours: normHours(r.proHours),
    platforms: strList(r.platforms),
    streaming: strList(r.streaming),
    schoolZone: r.schoolZone === "A" || r.schoolZone === "B" || r.schoolZone === "C" ? r.schoolZone : "",
    eveningRecap: isTime(r.eveningRecap) ? r.eveningRecap : DEFAULT_PREFS.eveningRecap,
  };
}
