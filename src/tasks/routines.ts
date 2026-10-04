// Routines (recurring tasks) — SYNC-FORMAT.md, collection "routines".
// Pure functions only. Nooky Desktop — original code.
//
// A routine never writes anything by itself: each day it occurs, it shows up
// as a virtual task keyed "r_<routineKey>_<YYYYMMDD>". Ticking it writes that
// key in the "tasks" collection. An occurrence left undone is NOT carried over.
// kind "sac" = things to get ready the evening before ("Sac de demain").

import { isTime, type Rec, type Task, type Tiroir } from "./oplog";
import { JOURS, toDate } from "./parse";

export interface Rule {
  freq: "daily" | "weekly" | "monthly";
  /** ISO weekdays (1 = Monday) — weekly only. */
  days?: number[];
  /** 1…31 — monthly only (31 in a 30-day month = its last day). */
  monthDay?: number;
  /** Skip Saturdays and Sundays. */
  workdaysOnly?: boolean;
}

export interface Routine {
  key: string;
  title: string;
  tiroir: Tiroir;
  rule: Rule;
  time: string | null;
  kind: "task" | "sac";
  active: boolean;
}

const isoDowOf = (day: string) => toDate(day).getDay() || 7;

export function normRule(v: unknown): Rule | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const workdaysOnly = o.workdaysOnly === true;
  if (o.freq === "daily") return { freq: "daily", workdaysOnly };
  if (o.freq === "weekly") {
    const days = Array.isArray(o.days) ? [...new Set(o.days.map(Number).filter((d) => d >= 1 && d <= 7))].sort() : [];
    return days.length ? { freq: "weekly", days, workdaysOnly } : null;
  }
  if (o.freq === "monthly") {
    const d = Number(o.monthDay);
    return Number.isInteger(d) && d >= 1 && d <= 31 ? { freq: "monthly", monthDay: d, workdaysOnly } : null;
  }
  return null;
}

/** A folded "routines" record as a Routine, or null if it is deleted or malformed. */
export function toRoutine(r: Rec): Routine | null {
  if (r.deleted === true) return null;
  if (typeof r.title !== "string" || !r.title.trim()) return null;
  const rule = normRule(r.rule);
  if (!rule) return null;
  return {
    key: r.key,
    title: r.title,
    tiroir: r.tiroir === "perso" ? "perso" : "pro",
    rule,
    time: isTime(r.time) ? r.time : null,
    kind: r.kind === "sac" ? "sac" : "task",
    active: r.active !== false,
  };
}

/** Does the rule fall on that day ("YYYY-MM-DD")? */
export function occursOn(rule: Rule, day: string): boolean {
  const dow = isoDowOf(day);
  if (rule.workdaysOnly && dow > 5) return false;
  switch (rule.freq) {
    case "daily":
      return true;
    case "weekly":
      return (rule.days ?? []).includes(dow);
    case "monthly": {
      const d = toDate(day);
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      return d.getDate() === Math.min(rule.monthDay ?? 1, last);
    }
  }
}

export const occKey = (routineKey: string, day: string) => `r_${routineKey}_${day.replace(/-/g, "")}`;

/**
 * The occurrences of the active routines of `kind` on `day`, as tasks. Their
 * done state comes from the "tasks" record of the same key; an occurrence
 * whose record was deleted ("Retirer" for today) is left out.
 */
export function occurrences(
  routines: Iterable<Routine>,
  taskRecs: Map<string, Rec> | undefined,
  day: string,
  kind: Routine["kind"] = "task",
): Task[] {
  const out: Task[] = [];
  for (const r of routines) {
    if (!r.active || r.kind !== kind || !occursOn(r.rule, day)) continue;
    const id = occKey(r.key, day);
    const rec = taskRecs?.get(id);
    if (rec?.deleted === true) continue;
    out.push({
      id,
      title: r.title,
      tiroir: r.tiroir,
      day,
      origDay: day,
      time: r.time,
      done: rec?.done === true,
      doneAt: typeof rec?.doneAt === "string" ? rec.doneAt : null,
      createdAt: typeof rec?.createdAt === "string" ? rec.createdAt : `${day}T00:00:00.000Z`,
      updatedTs: rec?.updatedTs ?? 0,
      routine: r.key,
    });
  }
  return out.sort((a, b) => (a.time ?? "99").localeCompare(b.time ?? "99") || a.title.localeCompare(b.title));
}

// ── Words ─────────────────────────────────────────────────────────────────────

/** ISO weekday → "lundi"… */
export const isoDayName = (d: number) => JOURS[d % 7];

export function ruleLabel(rule: Rule): string {
  switch (rule.freq) {
    case "daily":
      return rule.workdaysOnly ? "jours ouvrés" : "tous les jours";
    case "weekly": {
      const names = (rule.days ?? []).map(isoDayName);
      const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} et ${names[names.length - 1]}` : names[0];
      return `chaque ${list}`;
    }
    case "monthly":
      return `chaque mois le ${rule.monthDay}`;
  }
}

const DAY_RE = "lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche";

/**
 * Finds a repetition in French text and returns the rule and the text without
 * it. Understood: "tous les jours", "chaque jour", "jours ouvrés", "en semaine",
 * "chaque mardi", "tous les mardis et jeudis", "chaque semaine" (today's
 * weekday), "chaque mois le 5", "le 5 de chaque mois", "tous les mois le 5".
 */
export function parseRepeat(raw: string, now = new Date()): { rule: Rule; rest: string } | null {
  const s = ` ${raw} `;
  const cut = (m: RegExpMatchArray) => (s.slice(0, m.index) + " " + s.slice((m.index ?? 0) + m[0].length)).replace(/\s+/g, " ").trim();
  let m = s.match(/\s(?:tous les jours ouvr[ée]s|(?:les )?jours ouvr(?:é|a)(?:s|bles)|en semaine|du lundi au vendredi)(?=\s)/i);
  if (m) return { rule: { freq: "daily", workdaysOnly: true }, rest: cut(m) };
  m = s.match(/\s(?:tous les jours|chaque jour|chaque matin|chaque soir|quotidiennement)(?=\s)/i);
  if (m) return { rule: { freq: "daily" }, rest: cut(m) };
  m = s.match(/\s(?:chaque|tous les|toutes les)\s+mois\s+le\s+(\d{1,2})(?:er)?(?=\s)/i)
    ?? s.match(/\sle\s+(\d{1,2})(?:er)?\s+(?:de\s+)?(?:chaque|tous les)\s+mois(?=\s)/i);
  if (m) {
    const d = Number(m[1]);
    if (d >= 1 && d <= 31) return { rule: { freq: "monthly", monthDay: d }, rest: cut(m) };
  }
  m = s.match(new RegExp(`\\s(?:chaque|tous les)\\s+((?:${DAY_RE})s?(?:\\s*(?:,|et)\\s*(?:${DAY_RE})s?)*)(?=\\s)`, "i"));
  if (m) {
    const days = [...m[1].toLowerCase().matchAll(new RegExp(DAY_RE, "g"))].map((x) => JOURS.indexOf(x[0]) || 7);
    return { rule: { freq: "weekly", days: [...new Set(days)].sort() }, rest: cut(m) };
  }
  m = s.match(/\s(?:chaque semaine|toutes les semaines)(?=\s)/i);
  if (m) return { rule: { freq: "weekly", days: [now.getDay() || 7] }, rest: cut(m) };
  return null;
}
