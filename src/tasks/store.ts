// The live shared state: polls the sync folder, folds every writer's op file
// (format v2: tasks, routines, subs, watch, shopping, events, prefs, mailread),
// writes this device's ops, and reads the briefs, the mail and the chat
// bridge's answers. Nooky Desktop — original code. Format: SYNC-FORMAT.md.

import { Bridge, type SyncInfo, type SyncFile } from "../core/bridge";
import { Mode } from "../core/mode";
import type { Tiroir } from "../core/hours";
import {
  carriedLabel, createOp, dayLists, editOp, fold, live, newKey, putOp,
  type Coll, type DayLists, type Op, type Rec, type Task,
} from "./oplog";
import { addDays, dayKey, pad, timeLabel } from "./parse";
import { occKey, occurrences, ruleLabel, toRoutine, type Routine, type Rule } from "./routines";
import { parseCapture, captureSummary, type Capture } from "./capture";
import { pickBriefs, parseMails, type Brief, type Mail, type Slot } from "./briefs";
import {
  sortShopping, toEvent, toPrefs, toShopping, toSub, toWatch,
  type AgendaEvent, type Prefs, type ShoppingItem, type Sub, type WatchItem,
} from "./records";

export type { Brief, Mail };

const POLL_MS = 5000;

/** What a capture wrote, so it can be undone (deleted: true on each record). */
export interface CaptureResult {
  capture: Capture;
  summary: string;
  targets: { coll: Coll; key: string }[];
}

export interface Answer {
  id: string;
  at: string;
  text: string;
  /** The maison flagged the question as needing the internet (the free path can't answer well). */
  needsWeb?: boolean;
}

type Listener = () => void;

class Store {
  tasks = new Map<string, Task>();
  colls = new Map<string, Map<string, Rec>>();
  ready = false;
  info: SyncInfo | null = null;
  briefs = new Map<Slot, Brief>();
  mails: Mail[] = [];
  answers = new Map<string, Answer>();
  prefs: Prefs = toPrefs(undefined);
  /** Shown in the tasks view when a write failed. */
  error: string | null = null;
  /** Files skipped in the last read (not parsable yet). */
  skipped: string[] = [];

  /** Ops written by us that the folder may not show yet (or failed to write). */
  private pending: Op[] = [];
  private unsent: Op[] = [];
  private files: SyncFile[] = [];
  private stamp = "";
  private timer: number | null = null;
  private reading = false;
  private listeners = new Set<Listener>();

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }

  async start() {
    await Mode.load();
    this.info = await Bridge.syncInfo();
    await this.refresh(true);
    if (this.timer == null) this.timer = window.setInterval(() => void this.refresh(false), POLL_MS);
  }

  /** The sync folder changed (Settings): read everything again. */
  async reload() {
    this.info = await Bridge.syncInfo();
    this.stamp = "";
    await this.refresh(true);
  }

  async refresh(force: boolean) {
    if (this.reading) return;
    this.reading = true;
    try {
      if (this.unsent.length) await this.flush();
      const stamp = await Bridge.syncStamp();
      if (!force && stamp != null && stamp === this.stamp && this.ready) return;
      const snap = await Bridge.syncReadAll();
      if (!snap) {
        this.ready = true;
        this.notify();
        return;
      }
      this.stamp = stamp ?? snap.stamp;
      this.files = snap.files;
      const seen = new Set<string>();
      for (const f of snap.files) {
        if (!f.json.includes('"id"')) continue;
        for (const op of this.pending) if (f.json.includes(op.id)) seen.add(op.id);
      }
      this.pending = this.pending.filter((op) => !seen.has(op.id) || this.unsent.includes(op));
      this.briefs = pickBriefs(snap.briefs ?? [], snap.brief);
      this.mails = parseMails(snap.mails ?? [], snap.mailbox);
      this.answers = new Map();
      for (const a of snap.answers ?? []) {
        try {
          const v = JSON.parse(a.json) as Record<string, unknown>;
          const id = typeof v.id === "string" ? v.id : a.file.replace(/^answer-|\.json$/g, "");
          if (typeof v.text === "string") this.answers.set(id, { id, at: String(v.at ?? ""), text: v.text, needsWeb: v.needsWeb === true });
        } catch {
          /* still downloading: next round */
        }
      }
      this.refold();
      this.ready = true;
      this.notify();
    } finally {
      this.reading = false;
    }
  }

  private refold() {
    const files = this.pending.length
      ? [...this.files, { file: "ops-pending-local.json", json: JSON.stringify({ version: 2, writer: "local", ops: this.pending }) }]
      : this.files;
    const r = fold(files);
    this.tasks = r.tasks;
    this.colls = r.colls;
    this.skipped = r.skipped;
    this.prefs = toPrefs(this.colls.get("prefs")?.get("main"));
    Mode.setHours(this.prefs.proHours);
  }

  /** Applies ops locally right away, then writes them to our own file. */
  private async apply(...ops: Op[]) {
    this.pending.push(...ops);
    this.unsent.push(...ops);
    this.refold();
    this.notify();
    await this.flush();
  }

  private async flush() {
    if (!this.unsent.length) return;
    const batch = [...this.unsent];
    try {
      await Bridge.syncAppend(batch);
      this.unsent = this.unsent.filter((o) => !batch.includes(o));
      this.error = null;
    } catch (err) {
      this.error = "Je n'ai pas pu enregistrer dans le dossier de synchronisation. Je réessaie toutes les 5 secondes.";
      console.error("[nooky] sync_append", err);
    }
    this.notify();
  }

  // ── Reading ─────────────────────────────────────────────────────────────────

  routines(): Routine[] {
    return live(this.colls, "routines").map(toRoutine).filter((r): r is Routine => !!r);
  }

  /** Today's routine occurrences (kind "task"). */
  occurrences(day = dayKey()): Task[] {
    return occurrences(this.routines(), this.colls.get("tasks"), day, "task");
  }

  /** "Sac de demain": tomorrow's kind "sac" occurrences. */
  sacFor(day = addDays(dayKey(), 1)): Task[] {
    return occurrences(this.routines(), this.colls.get("tasks"), day, "sac");
  }

  /**
   * Ma journée: tasks plus today's routine occurrences (never carried over),
   * filtered on a mode when one is given.
   */
  lists(today = dayKey(), mode: Tiroir | null = null): DayLists {
    const l = dayLists(this.tasks.values(), today);
    const occ = this.occurrences(today);
    const keep = (t: Task) => !mode || t.tiroir === mode;
    // Timed first (by time), then carried over, then routines, then the rest.
    const rank = (t: Task) => (t.time ? 0 : carriedLabel(t, today) ? 1 : t.routine ? 2 : 3);
    const open = [...l.open, ...occ.filter((t) => !t.done)].filter(keep);
    open.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? a.time!.localeCompare(b.time!) : 0));
    const doneToday = [...l.doneToday, ...occ.filter((t) => t.done)].filter(keep);
    return { open, doneToday, later: l.later.filter(keep) };
  }

  progress(today = dayKey(), mode: Tiroir | null = null): { done: number; total: number; carried: number } {
    const l = this.lists(today, mode);
    return {
      done: l.doneToday.length,
      total: l.open.length + l.doneToday.length,
      carried: l.open.filter((t) => carriedLabel(t, today)).length,
    };
  }

  get(id: string): Task | null {
    if (this.tasks.has(id)) return this.tasks.get(id)!;
    if (id.startsWith("r_")) {
      const today = dayKey();
      return [...this.occurrences(today), ...this.sacFor()].find((t) => t.id === id) ?? null;
    }
    return null;
  }

  shopping(): ShoppingItem[] {
    return sortShopping(live(this.colls, "shopping").map(toShopping).filter((x): x is ShoppingItem => !!x));
  }

  subs(): Sub[] {
    return live(this.colls, "subs").map(toSub).filter((x): x is Sub => !!x);
  }

  events(): AgendaEvent[] {
    return live(this.colls, "events").map(toEvent).filter((x): x is AgendaEvent => !!x);
  }

  watch(): WatchItem[] {
    return live(this.colls, "watch").map(toWatch).filter((x): x is WatchItem => !!x).sort((a, b) => b.firstTs - a.firstTs);
  }

  isRead(m: Mail): boolean {
    return m.legacyRead || this.colls.get("mailread")?.get(m.id)?.read === true;
  }

  unreadMails(): Mail[] {
    return this.mails.filter((m) => !this.isRead(m));
  }

  /** The newest brief of all slots. */
  newestBrief(): Brief | null {
    let best: Brief | null = null;
    for (const b of this.briefs.values()) {
      if (!best || (b.updatedAt ?? "") > (best.updatedAt ?? "")) best = b;
    }
    return best;
  }

  /** What the chat knows about the day (rides in the system prompt). */
  contextForChat(now = new Date()): string {
    const today = dayKey(now);
    const date = now.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const mode = Mode.current(now);
    const { open, later } = this.lists(today);
    const line = (t: Task) => {
      const bits: string[] = [t.tiroir];
      if (t.time) bits.push(timeLabel(t.time));
      const c = carriedLabel(t, today);
      if (c) bits.push(c);
      if (t.routine) bits.push("routine");
      return `- ${t.title} (${bits.join(", ")})`;
    };
    let s = `Nous sommes le ${date}, il est ${pad(now.getHours())}h${pad(now.getMinutes())}.`;
    s += `\nMode actuel : ${mode === "pro" ? "pro (heures de travail)" : "perso (hors travail)"}.`;
    s += `\n\nSes tâches du jour encore à faire :\n${open.map(line).join("\n") || "(aucune)"}`;
    if (later.length) s += `\n\nPrévues plus tard :\n${later.slice(0, 12).map((t) => `${line(t)} le ${t.day}`).join("\n")}`;
    return s;
  }

  // ── Tasks ───────────────────────────────────────────────────────────────────

  /** Adds a task (plain line, as typed in Ma journée). */
  async add(raw: string, tiroir: Tiroir = Mode.current()) {
    const r = await this.capture(raw, { tiroir });
    return r?.capture.kind === "task" ? r.capture : null;
  }

  /**
   * Quick capture: a task, a routine, shopping items or a subscription.
   * Returns what was understood and written, or null.
   */
  async capture(raw: string, o: { tiroir?: Tiroir; requirePlus?: boolean; repeat?: Rule | null; sac?: boolean } = {}): Promise<CaptureResult | null> {
    const now = new Date();
    const c = parseCapture(raw, now, { requirePlus: o.requirePlus, streaming: this.prefs.streaming, platforms: this.prefs.platforms });
    if (!c) return null;
    const tiroir = o.tiroir ?? Mode.current(now);
    const targets: CaptureResult["targets"] = [];
    const ops: Op[] = [];
    let ruleText: string | undefined;
    if (c.kind === "shopping") {
      for (const label of c.items) {
        const key = newKey("s");
        targets.push({ coll: "shopping", key });
        ops.push(putOp("shopping", key, { label, done: false, doneAt: null }, now));
      }
    } else if (c.kind === "sub") {
      const key = newKey("a");
      targets.push({ coll: "subs", key });
      ops.push(putOp("subs", key, {
        name: c.name, price: c.price, cycle: c.cycle, nextRenewal: c.nextRenewal, trialEnd: c.trialEnd, category: c.category,
      }, now));
    } else {
      const repeat = o.repeat !== undefined && o.repeat !== null ? o.repeat : c.repeat;
      const sac = o.sac ?? c.sac;
      if (repeat || sac) {
        const rule = repeat ?? { freq: "daily", workdaysOnly: true };
        c.repeat = rule;
        c.sac = sac;
        ruleText = ruleLabel(rule);
        const key = newKey("r");
        targets.push({ coll: "routines", key });
        ops.push(putOp("routines", key, {
          title: c.title, tiroir, rule, time: c.time, kind: sac ? "sac" : "task", active: true,
        }, now));
      } else {
        const op = createOp({ title: c.title, day: c.day, time: c.time, tiroir }, now);
        targets.push({ coll: "tasks", key: op.key! });
        ops.push(op);
      }
    }
    await this.apply(...ops);
    return { capture: c, summary: captureSummary(c, ruleText), targets };
  }

  /** "Annuler" after a capture: deleted: true on everything it wrote. */
  async undo(r: CaptureResult) {
    await this.apply(...r.targets.map((t) => putOp(t.coll, t.key, { deleted: true })));
  }

  async setDone(id: string, done: boolean) {
    const set = done ? { done: true, doneAt: new Date().toISOString() } : { done: false, doneAt: null };
    const occ = id.startsWith("r_") && !this.tasks.has(id) ? this.get(id) : null;
    if (occ?.routine && !this.colls.get("tasks")?.has(id)) {
      // First tick of a routine occurrence: the record is created whole.
      await this.apply(putOp("tasks", id, {
        title: occ.title, tiroir: occ.tiroir, day: occ.day, origDay: occ.day, time: occ.time,
        ...set, createdAt: new Date().toISOString(), routine: occ.routine,
      }));
      return;
    }
    await this.apply(editOp(id, set));
  }

  /** "Demain": moves the task to tomorrow (keeps origDay). Not for routine occurrences. */
  async tomorrow(id: string) {
    if (id.startsWith("r_")) return;
    await this.apply(editOp(id, { day: addDays(dayKey(), 1) }));
  }

  /** Removes a task, or today's occurrence of a routine. */
  async remove(id: string) {
    await this.apply(editOp(id, { deleted: true }));
  }

  /** "Dans 30 min": the reminder time moves to now + `minutes`. */
  async snooze(id: string, minutes = 30) {
    if (id.startsWith("r_")) return;
    const d = new Date(Date.now() + minutes * 60_000);
    await this.apply(editOp(id, { day: dayKey(d), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }));
  }

  async setTiroir(id: string, tiroir: Tiroir) {
    await this.apply(editOp(id, { tiroir }));
  }

  // ── Routines ────────────────────────────────────────────────────────────────

  async removeRoutine(key: string) {
    await this.apply(putOp("routines", key, { deleted: true }));
  }

  // ── Shopping ────────────────────────────────────────────────────────────────

  async toggleShopping(key: string) {
    const it = this.shopping().find((s) => s.key === key);
    if (!it) return;
    await this.apply(putOp("shopping", key, it.done ? { done: false, doneAt: null } : { done: true, doneAt: new Date().toISOString() }));
  }

  /** "Vider les cochés". */
  async clearShoppingDone() {
    const ops = this.shopping().filter((s) => s.done).map((s) => putOp("shopping", s.key, { deleted: true }));
    if (ops.length) await this.apply(...ops);
  }

  async removeShopping(key: string) {
    await this.apply(putOp("shopping", key, { deleted: true }));
  }

  // ── Subs, events, watch ─────────────────────────────────────────────────────

  async removeSub(key: string) {
    await this.apply(putOp("subs", key, { deleted: true }));
  }

  async addEvent(e: Omit<AgendaEvent, "key">) {
    const key = newKey("e");
    await this.apply(putOp("events", key, { ...e }));
    return key;
  }

  async removeEvent(key: string) {
    await this.apply(putOp("events", key, { deleted: true }));
  }

  async addWatch(w: { title: string; kind: WatchItem["kind"]; platform: string; note?: string }) {
    const key = newKey("w");
    await this.apply(putOp("watch", key, { title: w.title, kind: w.kind, platform: w.platform, note: w.note ?? "" }));
    return key;
  }

  async removeWatch(key: string) {
    await this.apply(putOp("watch", key, { deleted: true }));
  }

  // ── Mail, prefs ─────────────────────────────────────────────────────────────

  async markRead(ids: string[]) {
    const ops = ids.filter((id) => this.colls.get("mailread")?.get(id)?.read !== true).map((id) => putOp("mailread", id, { read: true }));
    if (ops.length) await this.apply(...ops);
  }

  /** Writes some fields of the synced prefs (coll "prefs", key "main"). */
  async setPrefs(set: Partial<Prefs>) {
    await this.apply(putOp("prefs", "main", { ...set }));
  }
}

export const Tasks = new Store();

export { occKey };
// The live shared state: polls the sync folder, folds every writer's op file
// (format v2: tasks, routines, subs, watch, shopping, events, prefs, mailread),
// writes this device's ops, and reads the briefs, the mail and the chat
// bridge's answers. Nooky Desktop — original code. Format: SYNC-FORMAT.md.

import { Bridge, type SyncInfo, type SyncFile } from "../core/bridge";
import { Mode } from "../core/mode";
import type { Tiroir } from "../core/hours";
import {
  carriedLabel, createOp, dayLists, editOp, fold, live, newKey, putOp,
  type Coll, type DayLists, type Op, type Rec, type Task,
} from "./oplog";
import { addDays, dayKey, pad, timeLabel } from "./parse";
import { occKey, occurrences, ruleLabel, toRoutine, type Routine, type Rule } from "./routines";
import { parseCapture, captureSummary, type Capture } from "./capture";
import { pickBriefs, parseMails, type Brief, type Mail, type Slot } from "./briefs";
import {
  sortShopping, toEvent, toPrefs, toShopping, toSub, toWatch,
  type AgendaEvent, type Prefs, type ShoppingItem, type Sub, type WatchItem,
} from "./records";

export type { Brief, Mail };

const POLL_MS = 5000;

/** What a capture wrote, so it can be undone (deleted: true on each record). */
export interface CaptureResult {
  capture: Capture;
  summary: string;
  targets: { coll: Coll; key: string }[];
}

export interface Answer {
  id: string;
  at: string;
  text: string;
}

type Listener = () => void;

class Store {
  tasks = new Map<string, Task>();
  colls = new Map<string, Map<string, Rec>>();
  ready = false;
  info: SyncInfo | null = null;
  briefs = new Map<Slot, Brief>();
  mails: Mail[] = [];
  answers = new Map<string, Answer>();
  prefs: Prefs = toPrefs(undefined);
  /** Shown in the tasks view when a write failed. */
  error: string | null = null;
  /** Files skipped in the last read (not parsable yet). */
  skipped: string[] = [];

  /** Ops written by us that the folder may not show yet (or failed to write). */
  private pending: Op[] = [];
  private unsent: Op[] = [];
  private files: SyncFile[] = [];
  private stamp = "";
  private timer: number | null = null;
  private reading = false;
  private listeners = new Set<Listener>();

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }

  async start() {
    await Mode.load();
    this.info = await Bridge.syncInfo();
    await this.refresh(true);
    if (this.timer == null) this.timer = window.setInterval(() => void this.refresh(false), POLL_MS);
  }

  /** The sync folder changed (Settings): read everything again. */
  async reload() {
    this.info = await Bridge.syncInfo();
    this.stamp = "";
    await this.refresh(true);
  }

  async refresh(force: boolean) {
    if (this.reading) return;
    this.reading = true;
    try {
      if (this.unsent.length) await this.flush();
      const stamp = await Bridge.syncStamp();
      if (!force && stamp != null && stamp === this.stamp && this.ready) return;
      const snap = await Bridge.syncReadAll();
      if (!snap) {
        this.ready = true;
        this.notify();
        return;
      }
      this.stamp = stamp ?? snap.stamp;
      this.files = snap.files;
      const seen = new Set<string>();
      for (const f of snap.files) {
        if (!f.json.includes('"id"')) continue;
        for (const op of this.pending) if (f.json.includes(op.id)) seen.add(op.id);
      }
      this.pending = this.pending.filter((op) => !seen.has(op.id) || this.unsent.includes(op));
      this.briefs = pickBriefs(snap.briefs ?? [], snap.brief);
      this.mails = parseMails(snap.mails ?? [], snap.mailbox);
      this.answers = new Map();
      for (const a of snap.answers ?? []) {
        try {
          const v = JSON.parse(a.json) as Record<string, unknown>;
          const id = typeof v.id === "string" ? v.id : a.file.replace(/^answer-|\.json$/g, "");
          if (typeof v.text === "string") this.answers.set(id, { id, at: String(v.at ?? ""), text: v.text });
        } catch {
          /* still downloading: next round */
        }
      }
      this.refold();
      this.ready = true;
      this.notify();
    } finally {
      this.reading = false;
    }
  }

  private refold() {
    const files = this.pending.length
      ? [...this.files, { file: "ops-pending-local.json", json: JSON.stringify({ version: 2, writer: "local", ops: this.pending }) }]
      : this.files;
    const r = fold(files);
    this.tasks = r.tasks;
    this.colls = r.colls;
    this.skipped = r.skipped;
    this.prefs = toPrefs(this.colls.get("prefs")?.get("main"));
    Mode.setHours(this.prefs.proHours);
  }

  /** Applies ops locally right away, then writes them to our own file. */
  private async apply(...ops: Op[]) {
    this.pending.push(...ops);
    this.unsent.push(...ops);
    this.refold();
    this.notify();
    await this.flush();
  }

  private async flush() {
    if (!this.unsent.length) return;
    const batch = [...this.unsent];
    try {
      await Bridge.syncAppend(batch);
      this.unsent = this.unsent.filter((o) => !batch.includes(o));
      this.error = null;
    } catch (err) {
      this.error = "Je n'ai pas pu enregistrer dans le dossier de synchronisation. Je réessaie toutes les 5 secondes.";
      console.error("[nooky] sync_append", err);
    }
    this.notify();
  }

  // ── Reading ─────────────────────────────────────────────────────────────────

  routines(): Routine[] {
    return live(this.colls, "routines").map(toRoutine).filter((r): r is Routine => !!r);
  }

  /** Today's routine occurrences (kind "task"). */
  occurrences(day = dayKey()): Task[] {
    return occurrences(this.routines(), this.colls.get("tasks"), day, "task");
  }

  /** "Sac de demain": tomorrow's kind "sac" occurrences. */
  sacFor(day = addDays(dayKey(), 1)): Task[] {
    return occurrences(this.routines(), this.colls.get("tasks"), day, "sac");
  }

  /**
   * Ma journée: tasks plus today's routine occurrences (never carried over),
   * filtered on a mode when one is given.
   */
  lists(today = dayKey(), mode: Tiroir | null = null): DayLists {
    const l = dayLists(this.tasks.values(), today);
    const occ = this.occurrences(today);
    const keep = (t: Task) => !mode || t.tiroir === mode;
    // Timed first (by time), then carried over, then routines, then the rest.
    const rank = (t: Task) => (t.time ? 0 : carriedLabel(t, today) ? 1 : t.routine ? 2 : 3);
    const open = [...l.open, ...occ.filter((t) => !t.done)].filter(keep);
    open.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? a.time!.localeCompare(b.time!) : 0));
    const doneToday = [...l.doneToday, ...occ.filter((t) => t.done)].filter(keep);
    return { open, doneToday, later: l.later.filter(keep) };
  }

  progress(today = dayKey(), mode: Tiroir | null = null): { done: number; total: number; carried: number } {
    const l = this.lists(today, mode);
    return {
      done: l.doneToday.length,
      total: l.open.length + l.doneToday.length,
      carried: l.open.filter((t) => carriedLabel(t, today)).length,
    };
  }

  get(id: string): Task | null {
    if (this.tasks.has(id)) return this.tasks.get(id)!;
    if (id.startsWith("r_")) {
      const today = dayKey();
      return [...this.occurrences(today), ...this.sacFor()].find((t) => t.id === id) ?? null;
    }
    return null;
  }

  shopping(): ShoppingItem[] {
    return sortShopping(live(this.colls, "shopping").map(toShopping).filter((x): x is ShoppingItem => !!x));
  }

  subs(): Sub[] {
    return live(this.colls, "subs").map(toSub).filter((x): x is Sub => !!x);
  }

  events(): AgendaEvent[] {
    return live(this.colls, "events").map(toEvent).filter((x): x is AgendaEvent => !!x);
  }

  watch(): WatchItem[] {
    return live(this.colls, "watch").map(toWatch).filter((x): x is WatchItem => !!x).sort((a, b) => b.firstTs - a.firstTs);
  }

  isRead(m: Mail): boolean {
    return m.legacyRead || this.colls.get("mailread")?.get(m.id)?.read === true;
  }

  unreadMails(): Mail[] {
    return this.mails.filter((m) => !this.isRead(m));
  }

  /** The newest brief of all slots. */
  newestBrief(): Brief | null {
    let best: Brief | null = null;
    for (const b of this.briefs.values()) {
      if (!best || (b.updatedAt ?? "") > (best.updatedAt ?? "")) best = b;
    }
    return best;
  }

  /** What the chat knows about the day (rides in the system prompt). */
  contextForChat(now = new Date()): string {
    const today = dayKey(now);
    const date = now.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const mode = Mode.current(now);
    const { open, later } = this.lists(today);
    const line = (t: Task) => {
      const bits: string[] = [t.tiroir];
      if (t.time) bits.push(timeLabel(t.time));
      const c = carriedLabel(t, today);
      if (c) bits.push(c);
      if (t.routine) bits.push("routine");
      return `- ${t.title} (${bits.join(", ")})`;
    };
    let s = `Nous sommes le ${date}, il est ${pad(now.getHours())}h${pad(now.getMinutes())}.`;
    s += `\nMode actuel : ${mode === "pro" ? "pro (heures de travail)" : "perso (hors travail)"}.`;
    s += `\n\nSes tâches du jour encore à faire :\n${open.map(line).join("\n") || "(aucune)"}`;
    if (later.length) s += `\n\nPrévues plus tard :\n${later.slice(0, 12).map((t) => `${line(t)} le ${t.day}`).join("\n")}`;
    return s;
  }

  // ── Tasks ───────────────────────────────────────────────────────────────────

  /** Adds a task (plain line, as typed in Ma journée). */
  async add(raw: string, tiroir: Tiroir = Mode.current()) {
    const r = await this.capture(raw, { tiroir });
    return r?.capture.kind === "task" ? r.capture : null;
  }

  /**
   * Quick capture: a task, a routine, shopping items or a subscription.
   * Returns what was understood and written, or null.
   */
  async capture(raw: string, o: { tiroir?: Tiroir; requirePlus?: boolean; repeat?: Rule | null; sac?: boolean } = {}): Promise<CaptureResult | null> {
    const now = new Date();
    const c = parseCapture(raw, now, { requirePlus: o.requirePlus, streaming: this.prefs.streaming, platforms: this.prefs.platforms });
    if (!c) return null;
    const tiroir = o.tiroir ?? Mode.current(now);
    const targets: CaptureResult["targets"] = [];
    const ops: Op[] = [];
    let ruleText: string | undefined;
    if (c.kind === "shopping") {
      for (const label of c.items) {
        const key = newKey("s");
        targets.push({ coll: "shopping", key });
        ops.push(putOp("shopping", key, { label, done: false, doneAt: null }, now));
      }
    } else if (c.kind === "sub") {
      const key = newKey("a");
      targets.push({ coll: "subs", key });
      ops.push(putOp("subs", key, {
        name: c.name, price: c.price, cycle: c.cycle, nextRenewal: c.nextRenewal, trialEnd: c.trialEnd, category: c.category,
      }, now));
    } else {
      const repeat = o.repeat !== undefined && o.repeat !== null ? o.repeat : c.repeat;
      const sac = o.sac ?? c.sac;
      if (repeat || sac) {
        const rule = repeat ?? { freq: "daily", workdaysOnly: true };
        c.repeat = rule;
        c.sac = sac;
        ruleText = ruleLabel(rule);
        const key = newKey("r");
        targets.push({ coll: "routines", key });
        ops.push(putOp("routines", key, {
          title: c.title, tiroir, rule, time: c.time, kind: sac ? "sac" : "task", active: true,
        }, now));
      } else {
        const op = createOp({ title: c.title, day: c.day, time: c.time, tiroir }, now);
        targets.push({ coll: "tasks", key: op.key! });
        ops.push(op);
      }
    }
    await this.apply(...ops);
    return { capture: c, summary: captureSummary(c, ruleText), targets };
  }

  /** "Annuler" after a capture: deleted: true on everything it wrote. */
  async undo(r: CaptureResult) {
    await this.apply(...r.targets.map((t) => putOp(t.coll, t.key, { deleted: true })));
  }

  async setDone(id: string, done: boolean) {
    const set = done ? { done: true, doneAt: new Date().toISOString() } : { done: false, doneAt: null };
    const occ = id.startsWith("r_") && !this.tasks.has(id) ? this.get(id) : null;
    if (occ?.routine && !this.colls.get("tasks")?.has(id)) {
      // First tick of a routine occurrence: the record is created whole.
      await this.apply(putOp("tasks", id, {
        title: occ.title, tiroir: occ.tiroir, day: occ.day, origDay: occ.day, time: occ.time,
        ...set, createdAt: new Date().toISOString(), routine: occ.routine,
      }));
      return;
    }
    await this.apply(editOp(id, set));
  }

  /** "Demain": moves the task to tomorrow (keeps origDay). Not for routine occurrences. */
  async tomorrow(id: string) {
    if (id.startsWith("r_")) return;
    await this.apply(editOp(id, { day: addDays(dayKey(), 1) }));
  }

  /** Removes a task, or today's occurrence of a routine. */
  async remove(id: string) {
    await this.apply(editOp(id, { deleted: true }));
  }

  /** "Dans 30 min": the reminder time moves to now + `minutes`. */
  async snooze(id: string, minutes = 30) {
    if (id.startsWith("r_")) return;
    const d = new Date(Date.now() + minutes * 60_000);
    await this.apply(editOp(id, { day: dayKey(d), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }));
  }

  async setTiroir(id: string, tiroir: Tiroir) {
    await this.apply(editOp(id, { tiroir }));
  }

  // ── Routines ────────────────────────────────────────────────────────────────

  async removeRoutine(key: string) {
    await this.apply(putOp("routines", key, { deleted: true }));
  }

  // ── Shopping ────────────────────────────────────────────────────────────────

  async toggleShopping(key: string) {
    const it = this.shopping().find((s) => s.key === key);
    if (!it) return;
    await this.apply(putOp("shopping", key, it.done ? { done: false, doneAt: null } : { done: true, doneAt: new Date().toISOString() }));
  }

  /** "Vider les cochés". */
  async clearShoppingDone() {
    const ops = this.shopping().filter((s) => s.done).map((s) => putOp("shopping", s.key, { deleted: true }));
    if (ops.length) await this.apply(...ops);
  }

  async removeShopping(key: string) {
    await this.apply(putOp("shopping", key, { deleted: true }));
  }

  // ── Subs, events, watch ─────────────────────────────────────────────────────

  async removeSub(key: string) {
    await this.apply(putOp("subs", key, { deleted: true }));
  }

  async addEvent(e: Omit<AgendaEvent, "key">) {
    const key = newKey("e");
    await this.apply(putOp("events", key, { ...e }));
    return key;
  }

  async removeEvent(key: string) {
    await this.apply(putOp("events", key, { deleted: true }));
  }

  async addWatch(w: { title: string; kind: WatchItem["kind"]; platform: string; note?: string }) {
    const key = newKey("w");
    await this.apply(putOp("watch", key, { title: w.title, kind: w.kind, platform: w.platform, note: w.note ?? "" }));
    return key;
  }

  async removeWatch(key: string) {
    await this.apply(putOp("watch", key, { deleted: true }));
  }

  // ── Mail, prefs ─────────────────────────────────────────────────────────────

  async markRead(ids: string[]) {
    const ops = ids.filter((id) => this.colls.get("mailread")?.get(id)?.read !== true).map((id) => putOp("mailread", id, { read: true }));
    if (ops.length) await this.apply(...ops);
  }

  /** Writes some fields of the synced prefs (coll "prefs", key "main"). */
  async setPrefs(set: Partial<Prefs>) {
    await this.apply(putOp("prefs", "main", { ...set }));
  }
}

export const Tasks = new Store();

export { occKey };
