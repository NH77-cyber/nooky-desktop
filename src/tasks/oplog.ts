// The shared state as an append-only operation log — see SYNC-FORMAT.md (v2).
// Pure functions only (no DOM, no Tauri), so they can be unit-tested and
// reused as-is by the web "maison". Nooky Desktop — original code.
//
// v2 generalises v1: every op names a collection (`coll`) and a record key
// (`key`). A v1 op has neither: it is `coll: "tasks"` with `key = op.task`.

import { addDays, daysBetween, dayKey } from "./parse";

export type Tiroir = "pro" | "perso";

/** The collections of format v2. Unknown ones are folded too, and ignored by the views. */
export type Coll = "tasks" | "routines" | "subs" | "watch" | "shopping" | "events" | "prefs" | "mailread";

/** The fields a task carries. Every op sets some of them. */
export interface TaskFields {
  title: string;
  tiroir: Tiroir;
  /** "YYYY-MM-DD" — the day the task is planned for. */
  day: string;
  /** The day it was first planned for — drives the "reportée" tag. */
  origDay: string;
  /** "HH:MM" or null. */
  time: string | null;
  done: boolean;
  /** ISO 8601 timestamp, or null. */
  doneAt: string | null;
  /** ISO 8601 timestamp. */
  createdAt: string;
  deleted?: boolean;
  /** Set on a routine occurrence ("r_<routineKey>_<YYYYMMDD>"). */
  routine?: string;
}

export interface Op {
  /** Unique id of the operation (UUID). */
  id: string;
  /** Epoch milliseconds when it was made. */
  ts: number;
  /** Collection (v2). Absent = "tasks" (v1). */
  coll?: string;
  /** Record key (v2). Absent = `task` (v1). */
  key?: string;
  /** v1: id of the task. Nooky still writes it on task ops, so v1 readers keep working. */
  task?: string;
  /** Fields it sets (all of them on creation, only the changed ones after). */
  set: Record<string, unknown>;
}

export interface OpsFile {
  version: 1 | 2;
  /** v2: the writer's id (deviceId, "maison-…", "task-…"). */
  writer?: string;
  /** Readable name of the device (information only). */
  device?: string;
  ops: Op[];
}

export interface Task extends TaskFields {
  id: string;
  /** Timestamp of the last op that touched it. */
  updatedTs: number;
}

/** A folded record of any collection. */
export type Rec = Record<string, unknown> & { key: string; updatedTs: number; firstTs: number };

/** `^ops-[A-Za-z0-9_-]+\.json$`: Drive conflict copies such as "ops-x (1).json" don't match. */
export const OPS_FILE_RE = /^ops-[A-Za-z0-9_-]+\.json$/;

export const opColl = (op: Op): string => (typeof op.coll === "string" && op.coll ? op.coll : "tasks");
export const opKey = (op: Op): string => (typeof op.key === "string" && op.key ? op.key : String(op.task ?? ""));

const nonEmpty = (v: unknown) => typeof v === "string" && v.length > 0;

export function isOp(o: unknown): o is Op {
  if (!o || typeof o !== "object") return false;
  const v = o as Record<string, unknown>;
  if (v.coll !== undefined && !nonEmpty(v.coll)) return false;
  return (
    nonEmpty(v.id) &&
    typeof v.ts === "number" && Number.isFinite(v.ts) && v.ts > 0 &&
    (nonEmpty(v.key) || nonEmpty(v.task)) &&
    !!v.set && typeof v.set === "object" && !Array.isArray(v.set)
  );
}

/** The ops of one file, or null when the file does not parse (yet). */
export function parseOpsFile(text: string): Op[] | null {
  try {
    const doc = JSON.parse(text) as Partial<OpsFile>;
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.ops)) return null;
    return doc.ops.filter(isOp);
  } catch {
    return null;
  }
}

/** Total order shared by every device: timestamp, then op id. */
export function compareOps(a: Op, b: Op): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface FoldResult {
  /** Live tasks (deleted ones and ones without a title are left out). */
  tasks: Map<string, Task>;
  /** Every collection, record by record — deleted records included (deleted: true). */
  colls: Map<string, Map<string, Rec>>;
  /** Files that matched the pattern but did not parse — skipped this round. */
  skipped: string[];
  /** Files that did not match the pattern. */
  ignored: string[];
  opCount: number;
}

/** Folds every writer's ops into the current state: last writer wins, per field, per (coll, key). */
export function fold(files: { file: string; json: string }[]): FoldResult {
  const all: Op[] = [];
  const skipped: string[] = [];
  const ignored: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (!OPS_FILE_RE.test(f.file)) {
      ignored.push(f.file);
      continue;
    }
    const ops = parseOpsFile(f.json);
    if (!ops) {
      skipped.push(f.file);
      continue;
    }
    for (const op of ops) {
      if (seen.has(op.id)) continue;
      seen.add(op.id);
      all.push(op);
    }
  }
  all.sort(compareOps);

  const colls = new Map<string, Map<string, Rec>>();
  for (const op of all) {
    const c = opColl(op);
    const k = opKey(op);
    let m = colls.get(c);
    if (!m) colls.set(c, (m = new Map()));
    let r = m.get(k);
    if (!r) m.set(k, (r = { key: k, updatedTs: 0, firstTs: op.ts }));
    for (const [f, v] of Object.entries(op.set)) {
      if (f === "key" || f === "updatedTs" || f === "firstTs") continue;
      r[f] = v;
    }
    r.updatedTs = op.ts;
  }

  const tasks = new Map<string, Task>();
  for (const [id, raw] of colls.get("tasks") ?? []) {
    const t = toTask(id, raw);
    if (t) tasks.set(id, t);
  }
  return { tasks, colls, skipped, ignored, opCount: all.length };
}

/** A folded "tasks" record as a Task, or null (deleted, or no title yet). */
export function toTask(id: string, raw: Rec): Task | null {
  if (raw.deleted === true) return null;
  if (typeof raw.title !== "string" || !raw.title.trim()) return null;
  const day = isDay(raw.day) ? raw.day : dayKey(new Date(raw.updatedTs));
  const t: Task = {
    id,
    title: raw.title,
    tiroir: raw.tiroir === "perso" ? "perso" : "pro",
    day,
    origDay: isDay(raw.origDay) ? raw.origDay : day,
    time: isTime(raw.time) ? raw.time : null,
    done: raw.done === true,
    doneAt: typeof raw.doneAt === "string" ? raw.doneAt : null,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(raw.updatedTs).toISOString(),
    updatedTs: raw.updatedTs,
  };
  if (typeof raw.routine === "string" && raw.routine) t.routine = raw.routine;
  return t;
}

/** Live (not deleted) records of one collection. */
export function live(colls: Map<string, Map<string, Rec>>, coll: string): Rec[] {
  return [...(colls.get(coll)?.values() ?? [])].filter((r) => r.deleted !== true);
}

export const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
export const isTime = (v: unknown): v is string => typeof v === "string" && /^\d{2}:\d{2}$/.test(v);

/**
 * Keeps only the latest op per (coll, key, field). An op that still wins a
 * field keeps its id and timestamp with just those fields, so folding the
 * result gives exactly the same state. (Rust does the same in src-tauri/src/sync.rs.)
 */
export function compact(ops: Op[]): Op[] {
  const sorted = ops.filter(isOp).sort(compareOps);
  const winner = new Map<string, number>();
  sorted.forEach((op, i) => {
    for (const field of Object.keys(op.set)) winner.set(`${opColl(op)}\u0000${opKey(op)}\u0000${field}`, i);
  });
  const kept = new Map<number, Set<string>>();
  for (const [key, i] of winner) {
    const field = key.split("\u0000")[2];
    if (!kept.has(i)) kept.set(i, new Set());
    kept.get(i)!.add(field);
  }
  return [...kept.keys()].sort((a, b) => a - b).map((i) => {
    const op = sorted[i];
    const fields = kept.get(i)!;
    const set: Op["set"] = {};
    for (const [k, v] of Object.entries(op.set)) if (fields.has(k)) set[k] = v;
    const out: Op = { id: op.id, ts: op.ts, set };
    if (op.coll !== undefined) out.coll = op.coll;
    if (op.key !== undefined) out.key = op.key;
    if (op.task !== undefined) out.task = op.task;
    return out;
  });
}

// ── Ids ───────────────────────────────────────────────────────────────────────

export function newOpId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

export function newTaskId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** A record key for any collection: "<prefix><time36><rand>". */
export function newKey(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** One op on any record. Task ops also carry `task` (v1 readers keep seeing tasks). */
export function putOp(coll: Coll | string, key: string, set: Op["set"], now = new Date()): Op {
  const op: Op = { id: newOpId(), ts: now.getTime(), coll, key, set };
  if (coll === "tasks") op.task = key;
  return op;
}

// ── Ops for each action ───────────────────────────────────────────────────────

export function createOp(
  fields: { title: string; day: string; time: string | null; tiroir?: Tiroir },
  now = new Date(),
): Op {
  return putOp("tasks", newTaskId(), {
    title: fields.title,
    tiroir: fields.tiroir === "perso" ? "perso" : "pro",
    day: fields.day,
    origDay: fields.day,
    time: fields.time,
    done: false,
    doneAt: null,
    createdAt: now.toISOString(),
  }, now);
}

export function editOp(task: string, set: Op["set"], now = new Date()): Op {
  return putOp("tasks", task, set, now);
}

// ── Lists (the "Ma journée" view rules) ───────────────────────────────────────

export interface DayLists {
  /** To do today, including undone tasks from earlier days (carried over). */
  open: Task[];
  doneToday: Task[];
  later: Task[];
}

/** The day a task was first due: its origDay, or its day if that is earlier. */
const firstDay = (t: Task) => (t.origDay < t.day ? t.origDay : t.day);

/**
 * "reportée d'hier", "reportée depuis 3 jours", or "". Carry-over is a pure
 * view rule: an undone task from an earlier day shows up today, nothing is
 * written.
 */
export function carriedLabel(t: Task, today = dayKey()): string {
  if (t.done) return "";
  const from = firstDay(t);
  if (from >= today) return "";
  const n = daysBetween(from, today);
  return n <= 1 ? "reportée d'hier" : `reportée depuis ${n} jours`;
}

/**
 * Open list order: timed tasks by time, then carried ones (oldest first),
 * then the rest in creation order.
 */
export function sortOpen(list: Task[], today: string): Task[] {
  const rank = (t: Task) => (t.time ? 0 : carriedLabel(t, today) ? 1 : 2);
  return [...list].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) return a.time!.localeCompare(b.time!) || a.createdAt.localeCompare(b.createdAt);
    if (ra === 1) return firstDay(a).localeCompare(firstDay(b)) || a.createdAt.localeCompare(b.createdAt);
    return a.createdAt.localeCompare(b.createdAt);
  });
}

export function dayLists(tasks: Iterable<Task>, today = dayKey()): DayLists {
  const open: Task[] = [];
  const doneToday: Task[] = [];
  const later: Task[] = [];
  for (const t of tasks) {
    // Routine occurrences are virtual tasks, listed by the routines module and never carried over.
    if (t.routine || t.id.startsWith("r_")) continue;
    if (t.done) {
      const doneDay = t.doneAt ? dayKey(new Date(t.doneAt)) : t.day;
      if (doneDay === today) doneToday.push(t);
    } else if (t.day <= today) {
      open.push(t);
    } else {
      later.push(t);
    }
  }
  doneToday.sort((a, b) => String(a.doneAt).localeCompare(String(b.doneAt)));
  later.sort((a, b) => (a.day + (a.time ?? "99")).localeCompare(b.day + (b.time ?? "99")));
  return { open: sortOpen(open, today), doneToday, later };
}

/** Moves a task to tomorrow (keeps origDay, so it stays "reportée"). */
export const tomorrowOf = (today = dayKey()) => addDays(today, 1);
