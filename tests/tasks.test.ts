// Unit tests for the op-log fold, compaction and the task parser.
// Run with `npm test` (bundled by esbuild, run by node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  carriedLabel, compact, createOp, dayLists, editOp, fold, type Op,
} from "../src/tasks/oplog";
import { addDays, dayKey, parseTask } from "../src/tasks/parse";

const file = (device: string, ops: Op[]) => ({
  file: `ops-${device}.json`,
  json: JSON.stringify({ version: 1, device, ops }),
});
const op = (id: string, ts: number, task: string, set: Op["set"]): Op => ({ id, ts, task, set });
const base = { title: "A", tiroir: "pro", day: "2026-10-04", origDay: "2026-10-04", time: null, done: false, doneAt: null, createdAt: "2026-10-04T08:00:00.000Z" };

test("create, edit, delete", () => {
  const r = fold([file("mac", [
    op("1", 100, "t1", { ...base }),
    op("2", 200, "t1", { title: "A2", time: "14:00" }),
    op("3", 100, "t2", { ...base, title: "B" }),
    op("4", 300, "t2", { deleted: true }),
  ])]);
  assert.equal(r.tasks.size, 1);
  const t1 = r.tasks.get("t1")!;
  assert.equal(t1.title, "A2");
  assert.equal(t1.time, "14:00");
  assert.equal(t1.tiroir, "pro");
  assert.equal(t1.done, false);
});

test("last writer wins per field, across two device files", () => {
  const r = fold([
    file("mac", [op("a", 100, "t1", { ...base }), op("c", 300, "t1", { title: "from mac (later)" })]),
    file("pc", [op("b", 200, "t1", { title: "from pc", done: true, doneAt: "2026-10-04T09:00:00.000Z" })]),
  ]);
  const t = r.tasks.get("t1")!;
  assert.equal(t.title, "from mac (later)", "later ts wins the title");
  assert.equal(t.done, true, "the pc's done survives: different field");
  // File order must not matter.
  const r2 = fold([
    file("pc", [op("b", 200, "t1", { title: "from pc", done: true, doneAt: "2026-10-04T09:00:00.000Z" })]),
    file("mac", [op("a", 100, "t1", { ...base }), op("c", 300, "t1", { title: "from mac (later)" })]),
  ]);
  assert.deepEqual(r2.tasks.get("t1"), t);
});

test("equal timestamps are ordered by op id", () => {
  const r = fold([
    file("mac", [op("a", 100, "t1", { ...base }), op("zz", 500, "t1", { title: "zz" })]),
    file("pc", [op("aa", 500, "t1", { title: "aa" })]),
  ]);
  assert.equal(r.tasks.get("t1")!.title, "zz");
});

test("conflict copies and other files are ignored, corrupt files skipped", () => {
  const r = fold([
    file("mac", [op("a", 100, "t1", { ...base })]),
    { file: "ops-mac (1).json", json: JSON.stringify({ version: 1, device: "x", ops: [op("x", 999, "t1", { title: "conflict" })] }) },
    { file: "notes.json", json: "{}" },
    { file: "ops-tablet.json", json: '{"version":1,"ops":[{"id":' },
  ]);
  assert.equal(r.tasks.get("t1")!.title, "A");
  assert.deepEqual(r.ignored.sort(), ["notes.json", "ops-mac (1).json"]);
  assert.deepEqual(r.skipped, ["ops-tablet.json"]);
});

test("invalid ops and duplicate op ids are tolerated", () => {
  const r = fold([
    { file: "ops-a.json", json: JSON.stringify({ version: 1, device: "a", ops: [op("1", 100, "t1", { ...base }), { id: 5 }, null] }) },
    file("b", [op("1", 100, "t1", { ...base })]),
  ]);
  assert.equal(r.tasks.size, 1);
  assert.equal(r.opCount, 1);
});

test("a task whose create op has not synced yet stays hidden", () => {
  const r = fold([file("pc", [op("x", 100, "t9", { done: true })])]);
  assert.equal(r.tasks.size, 0);
});

test("compaction keeps the same folded state", () => {
  const ops: Op[] = [op("a", 1, "t1", { ...base })];
  for (let i = 0; i < 50; i++) ops.push(op(`e${String(i).padStart(3, "0")}`, 10 + i, "t1", { title: `v${i}`, time: i % 2 ? "10:00" : null }));
  ops.push(op("z", 100, "t1", { done: true, doneAt: "2026-10-04T10:00:00.000Z" }));
  const small = compact(ops);
  assert.ok(small.length <= 4, `compacted to ${small.length}`);
  assert.deepEqual(fold([file("m", small)]).tasks, fold([file("m", ops)]).tasks);
});

test("createOp / editOp shapes", () => {
  const now = new Date(2026, 9, 4, 8, 30);
  const c = createOp({ title: "Relancer le client", day: "2026-10-05", time: "14:00" }, now);
  assert.equal(typeof c.id, "string");
  assert.equal(c.ts, now.getTime());
  assert.deepEqual(Object.keys(c.set).sort(), ["createdAt", "day", "done", "doneAt", "origDay", "time", "tiroir", "title"]);
  assert.equal(c.set.origDay, "2026-10-05");
  const e = editOp(c.task, { done: true });
  assert.equal(e.task, c.task);
  assert.deepEqual(e.set, { done: true });
});

test("carry-over is a view rule, with the right labels and order", () => {
  const today = "2026-10-04";
  const mk = (id: string, set: Partial<typeof base>) => op(id, 100, id, { ...base, ...set });
  const r = fold([file("m", [
    mk("plain", { title: "plain", createdAt: "2026-10-04T07:00:00.000Z" }),
    mk("timed", { title: "timed", time: "16:00" }),
    mk("timed2", { title: "timed2", time: "09:30" }),
    mk("y1", { title: "hier", day: "2026-10-03", origDay: "2026-10-03" }),
    mk("y3", { title: "3 jours", day: "2026-10-01", origDay: "2026-10-01" }),
    mk("later", { title: "later", day: "2026-10-06", origDay: "2026-10-06" }),
    mk("doneT", { title: "done", done: true, doneAt: new Date(2026, 9, 4, 9).toISOString() }),
    mk("doneOld", { title: "old", day: "2026-10-01", done: true, doneAt: new Date(2026, 9, 1, 9).toISOString() }),
  ])]);
  const l = dayLists(r.tasks.values(), today);
  assert.deepEqual(l.open.map((t) => t.id), ["timed2", "timed", "y3", "y1", "plain"]);
  assert.deepEqual(l.doneToday.map((t) => t.id), ["doneT"]);
  assert.deepEqual(l.later.map((t) => t.id), ["later"]);
  assert.equal(carriedLabel(r.tasks.get("y1")!, today), "reportée d'hier");
  assert.equal(carriedLabel(r.tasks.get("y3")!, today), "reportée depuis 3 jours");
  assert.equal(carriedLabel(r.tasks.get("plain")!, today), "");
});

test("parseTask understands days and times", () => {
  const now = new Date(2026, 9, 4, 10, 0); // Sunday 4 Oct 2026
  const today = dayKey(now);
  assert.deepEqual(parseTask("relancer le client demain 14h", now), { title: "Relancer le client", day: addDays(today, 1), time: "14:00" });
  assert.deepEqual(parseTask("point budget après-demain à 9h", now), { title: "Point budget", day: addDays(today, 2), time: "09:00" });
  assert.deepEqual(parseTask("appeler le garage 14h30", now), { title: "Appeler le garage", day: today, time: "14:30" });
  assert.deepEqual(parseTask("envoyer le bilan lundi", now), { title: "Envoyer le bilan", day: addDays(today, 1), time: null });
  assert.deepEqual(parseTask("préparer la négo vendredi prochain vers 18h", now), { title: "Préparer la négo", day: addDays(today, 5), time: "18:00" });
  assert.deepEqual(parseTask("ce dimanche gâteau", now), { title: "Gâteau", day: addDays(today, 7), time: null });
  assert.deepEqual(parseTask("+ facture fournisseur 9:15", now), { title: "Facture fournisseur", day: today, time: "09:15" });
  assert.deepEqual(parseTask("budget 2027", now), { title: "Budget 2027", day: today, time: null });
  assert.deepEqual(parseTask("réunion 25h", now), { title: "Réunion 25h", day: today, time: null });
});
