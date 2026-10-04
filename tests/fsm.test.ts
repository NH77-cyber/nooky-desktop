// The island never hides on its own: it stays compact (petit) until the user pauses it.
import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as unknown as { window: unknown }).window = globalThis;
const { IslandStateMachine } = await import("../src/island/fsm");

test("compact island does not auto-hide", async () => {
  const m = new IslandStateMachine();
  m.launch();
  m.forcePetit();
  m.mouseEntered();
  m.mouseLeft();
  assert.equal(m.state, "petit");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(m.state, "petit");
  m.cancelTimers();
});

test("an explicit finite delay still hides (dev harness)", async () => {
  const m = new IslandStateMachine();
  m.petitToHiddenDelay = 0.02;
  m.forcePetit();
  m.mouseEntered();
  m.mouseLeft();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(m.state, "hidden");
});
