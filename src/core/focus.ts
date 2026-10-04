// Focus mode ("Concentration 25 min"): the island stays compact with a slim
// progress bar, Nooky goes sleepy-calm, and reminders / notifications wait
// until the end (except important ones). Nooky Desktop — original code.

import { notify } from "./bridge";

class FocusState {
  startMs = 0;
  endMs = 0;
  minutes = 0;
  /** Notifications held back during the session. */
  deferred: { title: string; body: string }[] = [];

  get active(): boolean {
    return this.endMs > 0;
  }

  start(minutes: number, now = Date.now()) {
    this.minutes = minutes;
    this.startMs = now;
    this.endMs = now + minutes * 60_000;
  }

  /** Ends the session; returns the notifications that were held back. */
  stop(): { title: string; body: string }[] {
    this.startMs = 0;
    this.endMs = 0;
    const held = this.deferred;
    this.deferred = [];
    return held;
  }

  remainingMs(now = Date.now()): number {
    return Math.max(0, this.endMs - now);
  }

  /** Whole minutes left, rounded up ("18 min"). */
  remainingMin(now = Date.now()): number {
    return Math.ceil(this.remainingMs(now) / 60_000);
  }

  progress(now = Date.now()): number {
    if (!this.active) return 0;
    return Math.min(1, Math.max(0, (now - this.startMs) / (this.endMs - this.startMs)));
  }
}

export const Focus = new FocusState();

/**
 * Native notification, held back during a focus session unless `important`.
 */
export function notifySoft(title: string, body: string, important = false) {
  if (Focus.active && !important) {
    Focus.deferred.push({ title, body });
    return;
  }
  void notify(title, body);
}
