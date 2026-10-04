// Unit tests for format v2: collections, v1 compatibility, routines, quick
// capture, briefs and mail, pro/perso hours, subscriptions.
// Run with `npm test` (bundled by esbuild, run by node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { compact, dayLists, fold, live, putOp, toTask, type Op } from "../src/tasks/oplog";
import { parseTask } from "../src/tasks/parse";
import { occKey, occurrences, occursOn, parseRepeat, ruleLabel, toRoutine } from "../src/tasks/routines";
import { nextMonthDay, parseCapture, splitItems, subCategory } from "../src/tasks/capture";
import { firstLine, parseMails, pickBriefs, slotFromName } from "../src/tasks/briefs";
import { autoMode, currentMode, nextBoundary, normHours, toggleOverride, DEFAULT_PRO_HOURS } from "../src/core/hours";
import { addCycle, effectiveRenewal, monthlyTotal, parseWatch, toPrefs, upcoming, type Sub } from "../src/tasks/records";

const file = (name: string, ops: unknown[], version = 2) => ({ file: `ops-${name}.json`, json: JSON.stringify({ version, writer: name, ops }) });
const op = (id: string, ts: number, coll: string | undefined, key: string, set: Record<string, unknown>, task?: string): Op => {
  const o: Op = { id, ts, set };
  if (coll) o.coll = coll;
  if (key) o.key = key;
  if (task) o.task = task;
  return o;
};
const taskBase = { title: "A", tiroir: "pro", day: "2026-10-05", origDay: "2026-10-05", time: null, done: false, doneAt: null, createdAt: "2026-10-05T08:00:00.000Z" };

test("v1 ops are tasks; v1 and v2 ops on the same task merge", () => {
  const r = fold([
    { file: "ops-old-mac.json", json: JSON.stringify({ version: 1, device: "Mac", ops: [{ id: "a", ts: 1, task: "t1", set: taskBase }] }) },
    file("maison-1730000000000", [op("b", 2, "tasks", "t1", { done: true, doneAt: "2026-10-05T09:00:00.000Z" })]),
  ]);
  const t = r.tasks.get("t1")!;
  assert.equal(t.title, "A");
  assert.equal(t.done, true);
});

test("collections are folded separately, deleted records kept in colls but not live", () => {
  const r = fold([
    file("maison-1", [
      op("1", 10, "shopping", "k", { label: "Lait", done: false }),
      op("2", 11, "subs", "k", { name: "Netflix", price: 13.49 }),
      op("3", 12, "shopping", "k", { done: true }),
    ]),
    file("maison-2", [op("4", 13, "subs", "k", { deleted: true })]),
  ]);
  assert.equal(r.colls.get("shopping")!.get("k")!.done, true);
  assert.equal(r.colls.get("shopping")!.get("k")!.label, "Lait");
  assert.equal(r.colls.get("subs")!.get("k")!.deleted, true);
  assert.equal(live(r.colls, "subs").length, 0);
  assert.equal(live(r.colls, "shopping").length, 1);
  assert.equal(r.tasks.size, 0);
});

test("many ops-maison-<ts> files and an ops-task file are all read; conflict copies are not", () => {
  const files = Array.from({ length: 45 }, (_, i) => file(`maison-${1730000000000 + i}`, [op(`m${i}`, 100 + i, "shopping", `s${i}`, { label: `x${i}` })]));
  files.push(file("task-veille-1730000000999", [op("tv", 999, "watch", "w1", { title: "The Bear", kind: "serie" })]));
  files.push({ file: "ops-maison-1 (1).json", json: JSON.stringify({ version: 2, ops: [op("cc", 5, "shopping", "zz", { label: "NON" })] }) });
  const r = fold(files);
  assert.equal(live(r.colls, "shopping").length, 45);
  assert.equal(live(r.colls, "watch").length, 1);
  assert.deepEqual(r.ignored, ["ops-maison-1 (1).json"]);
});

test("putOp writes coll/key, and task too for tasks (v1 readers)", () => {
  const t = putOp("tasks", "t9", { title: "X" });
  assert.equal(t.coll, "tasks");
  assert.equal(t.key, "t9");
  assert.equal(t.task, "t9");
  const s = putOp("shopping", "s1", { label: "Pain" });
  assert.equal(s.task, undefined);
});

test("compaction keeps the same folded state across collections", () => {
  const ops: Op[] = [];
  for (let i = 0; i < 30; i++) {
    ops.push(op(`a${String(i).padStart(3, "0")}`, 10 + i, "shopping", "s", { label: `v${i}`, done: i % 2 === 0 }));
    ops.push(op(`b${String(i).padStart(3, "0")}`, 10 + i, "tasks", "s", { ...taskBase, title: `t${i}` }, "s"));
  }
  ops.push(op("c", 100, undefined, "", { done: true }, "s"));
  const small = compact(ops);
  assert.ok(small.length <= 4, `compacted to ${small.length}`);
  // Same records (firstTs is local bookkeeping: the first op may be compacted away).
  const strip = (c: ReturnType<typeof fold>["colls"]) =>
    [...c].map(([k, m]) => [k, [...m].map(([kk, r]) => [kk, { ...r, firstTs: 0 }])]);
  assert.deepEqual(strip(fold([file("m", small)]).colls), strip(fold([file("m", ops)]).colls));
});

test("routine occurrences: rules, keys, done state, removal, never carried", () => {
  // 2026-10-05 is a Monday.
  assert.equal(occursOn({ freq: "daily", workdaysOnly: true }, "2026-10-10"), false);
  assert.equal(occursOn({ freq: "daily", workdaysOnly: true }, "2026-10-09"), true);
  assert.equal(occursOn({ freq: "weekly", days: [2, 4] }, "2026-10-06"), true);
  assert.equal(occursOn({ freq: "weekly", days: [2, 4] }, "2026-10-07"), false);
  assert.equal(occursOn({ freq: "monthly", monthDay: 31 }, "2026-11-30"), true, "31 → last day of a 30-day month");
  assert.equal(occursOn({ freq: "monthly", monthDay: 5 }, "2026-10-05"), true);
  assert.equal(occKey("r1", "2026-10-05"), "r_r1_20261005");

  const r = fold([file("m", [
    op("1", 1, "routines", "r1", { title: "Piscine", tiroir: "perso", rule: { freq: "weekly", days: [1] }, time: "17:00", kind: "task", active: true }),
    op("2", 2, "routines", "r2", { title: "Goûter", tiroir: "perso", rule: { freq: "daily" }, time: null, kind: "sac", active: true }),
    op("3", 3, "routines", "r3", { title: "Stoppée", rule: { freq: "daily" }, active: false }),
    op("4", 4, "tasks", "r_r1_20261005", { title: "Piscine", tiroir: "perso", day: "2026-10-05", origDay: "2026-10-05", time: "17:00", done: true, doneAt: "2026-10-05T17:30:00.000Z", createdAt: "2026-10-05T17:30:00.000Z", routine: "r1" }, "r_r1_20261005"),
    // Last week's occurrence, left undone: must not be carried over.
    op("5", 5, "tasks", "r_r1_20260928", { title: "Piscine", day: "2026-09-28", origDay: "2026-09-28", done: false, routine: "r1" }, "r_r1_20260928"),
  ])]);
  const routines = live(r.colls, "routines").map(toRoutine).filter((x) => !!x);
  const occ = occurrences(routines as never, r.colls.get("tasks"), "2026-10-05", "task");
  assert.deepEqual(occ.map((t) => [t.id, t.done]), [["r_r1_20261005", true]]);
  assert.equal(occurrences(routines as never, r.colls.get("tasks"), "2026-10-06", "task").length, 0);
  assert.deepEqual(occurrences(routines as never, r.colls.get("tasks"), "2026-10-06", "sac").map((t) => t.id), ["r_r2_20261006"]);
  const l = dayLists(r.tasks.values(), "2026-10-05");
  assert.equal(l.open.length + l.doneToday.length + l.later.length, 0, "occurrence records stay out of the plain lists");
  // A deleted occurrence ("Pas aujourd'hui") disappears.
  const r2 = fold([file("m", [...JSON.parse(file("x", []).json).ops,
    op("1", 1, "routines", "r1", { title: "Piscine", rule: { freq: "daily" }, active: true }),
    op("9", 9, "tasks", "r_r1_20261005", { deleted: true }, "r_r1_20261005")])]);
  const rr = live(r2.colls, "routines").map(toRoutine).filter((x) => !!x);
  assert.equal(occurrences(rr as never, r2.colls.get("tasks"), "2026-10-05").length, 0);
  assert.equal(toTask("x", { key: "x", updatedTs: 1, firstTs: 1, title: "T", routine: "r1" })!.routine, "r1");
});

test("parseRepeat", () => {
  const now = new Date(2026, 9, 6); // Tuesday
  assert.deepEqual(parseRepeat("piscine chaque mardi 17h", now), { rule: { freq: "weekly", days: [2] }, rest: "piscine 17h" });
  assert.deepEqual(parseRepeat("sport tous les mardis et jeudis", now)?.rule, { freq: "weekly", days: [2, 4] });
  assert.deepEqual(parseRepeat("goûter tous les jours", now)?.rule, { freq: "daily" });
  assert.deepEqual(parseRepeat("point jours ouvrés 9h", now)?.rule, { freq: "daily", workdaysOnly: true });
  assert.deepEqual(parseRepeat("payer le loyer chaque mois le 5", now)?.rule, { freq: "monthly", monthDay: 5 });
  assert.deepEqual(parseRepeat("loyer le 5 de chaque mois", now)?.rule, { freq: "monthly", monthDay: 5 });
  assert.deepEqual(parseRepeat("réunion chaque semaine", now)?.rule, { freq: "weekly", days: [2] });
  assert.equal(parseRepeat("appeler le garage mardi", now), null);
  assert.equal(ruleLabel({ freq: "weekly", days: [2, 4] }), "chaque mardi et jeudi");
  assert.equal(ruleLabel({ freq: "daily", workdaysOnly: true }), "jours ouvrés");
});

test("quick capture: shopping, subscriptions, tasks, routines, sac", () => {
  const now = new Date(2026, 9, 4, 10); // Sunday 4 Oct 2026
  assert.deepEqual(parseCapture("courses : lait, pain et beurre", now), { kind: "shopping", items: ["Lait", "Pain", "Beurre"] });
  assert.deepEqual(parseCapture("+courses lait", now), { kind: "shopping", items: ["Lait"] });
  assert.deepEqual(parseCapture("+ courses : œufs; farine", now), { kind: "shopping", items: ["Œufs", "Farine"] });
  const sub = parseCapture("abo Netflix 13,49 le 12", now)!;
  assert.deepEqual(sub, { kind: "sub", name: "Netflix", price: 13.49, cycle: "monthly", nextRenewal: "2026-10-12", trialEnd: null, category: "streaming" });
  const sub2 = parseCapture("abo PS Plus 71,99 € par an le 3", now)!;
  assert.equal(sub2.kind === "sub" && sub2.cycle, "yearly");
  assert.equal(sub2.kind === "sub" && sub2.nextRenewal, "2026-11-03");
  assert.equal(sub2.kind === "sub" && sub2.category, "jeux");
  const sub3 = parseCapture("abo Max 9.99 essai jusqu'au 20/11", now)!;
  assert.equal(sub3.kind === "sub" && sub3.trialEnd, "2026-11-20");
  assert.equal(sub3.kind === "sub" && sub3.nextRenewal, "2026-11-04");
  // In the chat a "+" is required for tasks, so questions still go to Claude.
  assert.equal(parseCapture("comment relancer le client ?", now, { requirePlus: true }), null);
  assert.deepEqual(parseCapture("+ relancer le client demain 14h", now, { requirePlus: true }),
    { kind: "task", title: "Relancer le client", day: "2026-10-05", time: "14:00", repeat: null, sac: false });
  const rout = parseCapture("+ piscine chaque mardi 17h", now)!;
  assert.equal(rout.kind === "task" && rout.title, "Piscine");
  assert.deepEqual(rout.kind === "task" && rout.repeat, { freq: "weekly", days: [2] });
  assert.equal(rout.kind === "task" && rout.time, "17:00");
  const sac = parseCapture("+ sac : goûter", now)!;
  assert.equal(sac.kind === "task" && sac.sac, true);
  assert.deepEqual(sac.kind === "task" && sac.repeat, { freq: "daily", workdaysOnly: true });
  // "courses" inside a task does not become shopping.
  assert.equal(parseCapture("courses à faire demain", now)!.kind, "task");
  assert.deepEqual(splitItems("lait,  pain ; et beurre."), ["Lait", "Pain", "Beurre"]);
  assert.equal(nextMonthDay(31, "2026-11-04"), "2026-11-30");
  assert.equal(nextMonthDay(4, "2026-10-04"), "2026-10-04");
  assert.equal(subCategory("Ma box", { streaming: ["box"] }), "streaming");
});

test("parseTask understands dd/mm dates", () => {
  const now = new Date(2026, 9, 4, 10);
  assert.deepEqual(parseTask("anniversaire de Léa le 12/11 14h", now), { title: "Anniversaire de Léa", day: "2026-11-12", time: "14:00" });
  assert.deepEqual(parseTask("galette 06/01", now), { title: "Galette", day: "2027-01-06", time: null });
});

test("briefs: newest per slot, Drive duplicates, legacy brief.json", () => {
  const b = (slot: string, at: string, title: string) => JSON.stringify({ slot, updatedAt: at, title, text: "x", items: [{ title: "i", url: "javascript:alert(1)" }] });
  const m = pickBriefs([
    { file: "brief-veille.json", json: b("veille", "2026-10-05T08:00:00Z", "new") },
    { file: "brief-veille (1).json", json: b("veille", "2026-10-04T08:00:00Z", "old") },
    { file: "brief-evening-1730.json", json: JSON.stringify({ updatedAt: "2026-10-05T18:00:00Z", title: "soir", text: "" }) },
    { file: "brief-weekly.json", json: "{ partial" },
    { file: "brief-unknown.json", json: b("nope", "2026-10-05T08:00:00Z", "?") },
  ], JSON.stringify({ updatedAt: "2026-10-05T07:00:00Z", brief: "**3 choses**", items: [{ source: "S", title: "T", url: "https://e.com" }] }));
  assert.equal(m.get("veille")!.title, "new");
  assert.equal(m.get("veille")!.items[0].url, "", "only http(s) links are kept");
  assert.equal(m.get("evening")!.title, "soir", "slot taken from the file name");
  assert.equal(m.get("morning")!.text, "**3 choses**", "legacy brief.json is the morning brief");
  assert.equal(m.has("weekly"), false);
  assert.equal(slotFromName("brief-leisure (2).json"), "leisure");
  assert.equal(firstLine({ ...m.get("morning")!, text: "**3 choses à retenir** :\n- Météo : soleil" }), "3 choses à retenir : Météo : soleil");
});

test("mail: dedupe by id, 30 days, newest first, legacy read flag", () => {
  const now = new Date("2026-10-05T12:00:00Z");
  const mails = parseMails([
    { file: "mail-a.json", json: JSON.stringify({ id: "a", at: "2026-10-05T08:00:00Z", from: "X", title: "A" }) },
    { file: "mail-a (1).json", json: JSON.stringify({ id: "a", at: "2026-10-05T08:00:00Z", from: "X", title: "A" }) },
    { file: "mail-b.json", json: JSON.stringify({ id: "b", at: "2026-10-05T10:00:00Z", from: "X", title: "B", important: true }) },
    { file: "mail-old.json", json: JSON.stringify({ id: "old", at: "2026-08-01T10:00:00Z", title: "old" }) },
    { file: "mail-bad.json", json: "{" },
  ], JSON.stringify({ messages: [{ id: "l", at: "2026-10-04T10:00:00Z", title: "legacy", read: true }] }), now);
  assert.deepEqual(mails.map((m) => m.id), ["b", "a", "l"]);
  assert.equal(mails[0].important, true);
  assert.equal(mails[2].legacyRead, true);
});

test("pro / perso hours and the manual switch", () => {
  const h = DEFAULT_PRO_HOURS;
  assert.equal(autoMode(h, new Date(2026, 9, 5, 9, 0)), "pro"); // Monday 9:00
  assert.equal(autoMode(h, new Date(2026, 9, 5, 8, 29)), "perso");
  assert.equal(autoMode(h, new Date(2026, 9, 5, 18, 30)), "perso");
  assert.equal(autoMode(h, new Date(2026, 9, 4, 11, 0)), "perso"); // Sunday
  assert.deepEqual(nextBoundary(h, new Date(2026, 9, 5, 9, 0)), new Date(2026, 9, 5, 18, 30));
  assert.deepEqual(nextBoundary(h, new Date(2026, 9, 3, 12, 0)), new Date(2026, 9, 5, 8, 30), "Saturday → Monday 8:30");
  const sat = new Date(2026, 9, 3, 12, 0);
  const o = toggleOverride(h, null, sat);
  assert.equal(o.mode, "pro");
  assert.equal(currentMode(h, o, sat), "pro");
  assert.equal(currentMode(h, o, new Date(2026, 9, 5, 8, 31)), "pro", "back to the clock after the boundary (pro anyway)");
  assert.equal(currentMode(h, o, new Date(2026, 9, 5, 18, 31)), "perso");
  assert.deepEqual(normHours({ days: [9, 2, 2, 1], start: "7:00", end: "17:00" }), { days: [1, 2], start: "08:30", end: "17:00" });
});

test("subscriptions: renewal rolled forward, monthly total; agenda window; watch parser; prefs", () => {
  const s: Sub = { key: "a", name: "N", price: 13.49, cycle: "monthly", nextRenewal: "2026-08-31", trialEnd: null, category: "streaming" };
  assert.equal(effectiveRenewal(s, "2026-10-05"), "2026-10-31");
  assert.equal(addCycle("2026-01-31", "monthly"), "2026-02-28");
  assert.equal(monthlyTotal([s, { ...s, price: 120, cycle: "yearly" }]), 23.49);
  const ev = (key: string, date: string, time: string | null = null) => ({ key, title: key, date, time, kind: "autre" as const, remindDaysBefore: 1 });
  assert.deepEqual(upcoming([ev("c", "2026-10-20"), ev("b", "2026-10-06", "09:00"), ev("a", "2026-10-06"), ev("old", "2026-10-01")], "2026-10-05").map((e) => e.key), ["b", "a"]);
  assert.deepEqual(parseWatch("The Bear (série, Disney+)", ["Disney+", "Switch"]), { title: "The Bear", kind: "serie", platform: "Disney+" });
  assert.deepEqual(parseWatch("Zelda jeu Switch", ["Disney+", "Switch"]), { title: "Zelda", kind: "jeu", platform: "Switch" });
  const p = toPrefs({ key: "main", updatedTs: 1, firstTs: 1, prenom: " Sam ", platforms: ["PS5", 3], schoolZone: "Z", eveningRecap: "19:15" });
  assert.equal(p.prenom, "Sam");
  assert.deepEqual(p.platforms, ["PS5"]);
  assert.equal(p.schoolZone, "");
  assert.equal(p.eveningRecap, "19:15");
  assert.deepEqual(p.proHours, DEFAULT_PRO_HOURS);
});
