// Reminders, notices and the morning summary. Nooky Desktop — original code.
//
// What already fired is kept on THIS device only (local state, not the shared
// log), so the Mac and the PC never fight over it. A task reminder's key
// carries the task's day and time, so "Dans 30 min" re-arms it naturally.
// During a focus session everything waits (core/focus.ts), except important mail.

import { Bridge } from "../core/bridge";
import { Focus, notifySoft } from "../core/focus";
import { isoDow } from "../core/hours";
import { hello } from "../core/state";
import type { IslandViewName } from "../core/layout";
import { carriedLabel, type Task } from "./oplog";
import { addDays, dayKey, nowHM, timeLabel } from "./parse";
import { daysUntil, effectiveRenewal, euros, whenLabel } from "./records";
import { Tasks } from "./store";

/** A card the island shows for a subscription, a trial, an event. */
export interface Notice {
  label: string;
  title: string;
  sub: string;
  /** "Voir" opens this view. */
  view: IslandViewName;
}

export interface ReminderHooks {
  /** Open the island on the reminder card. */
  showReminder(task: Task): void;
  /** Open the island on a notice card. */
  showNotice(n: Notice): void;
  /** Open the evening recap. */
  showRecap(): void;
  /** True while a card is on screen (or a focus session runs): the next one waits. */
  reminderShowing(): boolean;
}

const CHECK_MS = 20_000;

let reminded = new Set<string>();
let mailSeen = new Set<string>();
let loaded = false;
const queue: ({ kind: "task"; id: string } | { kind: "notice"; n: Notice })[] = [];

const keyOf = (t: Task) => `${t.id}@${t.day}T${t.time}`;

async function loadReminded() {
  if (loaded) return;
  loaded = true;
  const saved = (await Bridge.localGet<string[]>("reminded")) ?? [];
  // Forget anything older than three days.
  const cutoff = dayKey(new Date(Date.now() - 3 * 864e5));
  reminded = new Set(saved.filter((k) => (k.split("@")[1] ?? "").slice(0, 10) >= cutoff));
  const seen = await Bridge.localGet<string[]>("mailSeen");
  mailSeen = new Set(seen ?? []);
  if (!seen) {
    // First run: what is already there is not news.
    for (const m of Tasks.mails) mailSeen.add(m.id);
  }
}

function persist() {
  void Bridge.localSet("reminded", [...reminded]);
  void Bridge.localSet("mailSeen", [...mailSeen].slice(-500));
}

/** Tasks (and timed routine occurrences) due now that were not reminded on this device yet. */
export function dueNow(now = new Date()): Task[] {
  const today = dayKey(now);
  const hm = nowHM(now);
  return Tasks.lists(today).open.filter(
    (t) => t.day === today && t.time != null && t.time <= hm && !reminded.has(keyOf(t)),
  );
}

/** Fires `fn` once per device for `key`. */
function once(key: string, fn: () => void) {
  if (reminded.has(key)) return;
  reminded.add(key);
  fn();
}

function notice(n: Notice) {
  queue.push({ kind: "notice", n });
}

export async function checkReminders(hooks: ReminderHooks, now = new Date()) {
  if (!Tasks.ready) return;
  await loadReminded();
  const today = dayKey(now);
  const hm = nowHM(now);

  for (const t of dueNow(now)) {
    reminded.add(keyOf(t));
    queue.push({ kind: "task", id: t.id });
    notifySoft(`Rappel · ${timeLabel(t.time!)}`, t.title);
  }

  // Subscriptions: 3 days before the renewal and before the end of a trial.
  for (const s of Tasks.subs()) {
    const r = effectiveRenewal(s, today);
    const d = daysUntil(r, today);
    if (d >= 0 && d <= 3) {
      once(`sub:${s.key}@${r}`, () => {
        const body = `${s.name} se renouvelle ${whenLabel(r, today)} (${euros(s.price)}).`;
        notifySoft("Abonnement", body);
        notice({ label: "Abonnement", title: `${s.name} : renouvellement ${whenLabel(r, today)}`, sub: `${euros(s.price)} ${s.cycle === "yearly" ? "par an" : "par mois"}. Garde-le ou résilie-le à temps.`, view: "subs" });
      });
    }
    if (s.trialEnd) {
      const dt = daysUntil(s.trialEnd, today);
      if (dt >= 0 && dt <= 3) {
        once(`trial:${s.key}@${s.trialEnd}`, () => {
          notifySoft("Fin d'essai", `L'essai ${s.name} se termine ${whenLabel(s.trialEnd!, today)}.`);
          notice({ label: "Fin d'essai", title: `Essai ${s.name} : fin ${whenLabel(s.trialEnd!, today)}`, sub: `Ensuite ${euros(s.price)} ${s.cycle === "yearly" ? "par an" : "par mois"}.`, view: "subs" });
        });
      }
    }
  }

  // Agenda: remindDaysBefore days ahead.
  for (const e of Tasks.events()) {
    const d = daysUntil(e.date, today);
    if (d >= 0 && d <= e.remindDaysBefore) {
      once(`ev:${e.key}@${e.date}`, () => {
        const when = `${whenLabel(e.date, today)}${e.time ? ` à ${timeLabel(e.time)}` : ""}`;
        notifySoft("Agenda", `${e.title}, ${when}.`);
        notice({ label: "Agenda", title: `${e.title}, ${when}`, sub: "Je te le rappelle pour que rien ne t'échappe.", view: "agenda" });
      });
    }
  }

  // Sac de demain: a gentle nudge at 19:30 when things are still unchecked.
  if (hm >= "19:30" && hm < "23:00") {
    const left = Tasks.sacFor(addDays(today, 1)).filter((t) => !t.done);
    if (left.length) once(`sac@${today}`, () => notifySoft("Sac de demain", `Encore à préparer : ${left.map((t) => t.title).join(", ")}.`));
  }

  // Evening recap, on workdays, within three hours of its time.
  const recap = Tasks.prefs.eveningRecap;
  if (Tasks.prefs.proHours.days.includes(isoDow(now)) && hm >= recap && hm < addHours(recap, 3)) {
    once(`recap@${today}`, () => {
      const p = Tasks.progress(today);
      notifySoft("Bilan du jour", p.total ? `${p.done} faite${p.done > 1 ? "s" : ""} sur ${p.total}.` : "Rien de prévu aujourd'hui.");
      hooks.showRecap();
    });
  }

  // Important mail: notified right away, even during a focus session.
  for (const m of Tasks.mails) {
    if (mailSeen.has(m.id)) continue;
    mailSeen.add(m.id);
    if (m.important && !Tasks.isRead(m)) notifySoft(`Courrier · ${m.from || "Maison"}`, m.title, true);
  }

  persist();
  showNext(hooks);
}

function addHours(hm: string, h: number): string {
  const n = Math.min(23 * 60 + 59, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)) + h * 60);
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}

/** Shows the next queued reminder or notice, if the card is free. */
export function showNext(hooks: ReminderHooks) {
  if (hooks.reminderShowing() || Focus.active) return;
  while (queue.length) {
    const q = queue.shift()!;
    if (q.kind === "notice") {
      hooks.showNotice(q.n);
      return;
    }
    const t = Tasks.get(q.id);
    if (t && !t.done) {
      hooks.showReminder(t);
      return;
    }
  }
}

export const pendingCount = () => queue.length;

export function startReminders(hooks: ReminderHooks) {
  void checkReminders(hooks);
  window.setInterval(() => void checkReminders(hooks), CHECK_MS);
}

// ── Morning summary ───────────────────────────────────────────────────────────

/** True (once) on the first wake of the day: launch, or first peek after midnight. */
export async function claimMorning(now = new Date()): Promise<boolean> {
  const today = dayKey(now);
  const last = await Bridge.localGet<string>("lastMorning");
  if (last === today) return false;
  await Bridge.localSet("lastMorning", today);
  return true;
}

export function morningSummary(today = dayKey()): { line: string; first: Task[]; count: number; carried: number } {
  const { open } = Tasks.lists(today);
  const carried = open.filter((t) => carriedLabel(t, today)).length;
  const n = open.length;
  let line: string;
  if (n === 0) line = "Rien de prévu aujourd'hui. Profite !";
  else {
    line = `${n} tâche${n > 1 ? "s" : ""} aujourd'hui`;
    if (carried) line += `, dont ${carried} reportée${carried > 1 ? "s" : ""}`;
  }
  return { line, first: open.slice(0, 3), count: n, carried };
}

export function notifyMorning() {
  const s = morningSummary();
  const next = s.first.map((t) => (t.time ? `${timeLabel(t.time)} ${t.title}` : t.title)).join(" · ");
  notifySoft(hello(), next ? `${s.line} — ${next}` : s.line);
}

/** Evening recap data: done today, still open (carried to tomorrow), tomorrow's first timed task. */
export function recapSummary(now = new Date()) {
  const today = dayKey(now);
  const tomorrow = addDays(today, 1);
  const l = Tasks.lists(today);
  const tomorrowFirst = [
    ...Tasks.lists(tomorrow).open.filter((t) => t.day === tomorrow || t.routine),
  ].filter((t) => t.time).sort((a, b) => a.time!.localeCompare(b.time!))[0] ?? null;
  return {
    done: l.doneToday,
    // Routine occurrences are not carried over.
    remaining: l.open.filter((t) => !t.routine),
    tomorrowFirst,
    evening: Tasks.briefs.get("evening") ?? null,
  };
}
