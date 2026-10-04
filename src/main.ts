// Entry point: boot the bridge, wire the island, start the greeting.
// Adapted from Coucou by Louis Raillé (MIT License, see LICENSE-COUCOU-MIT).

import "./style.css";
import { Bridge, IS_TAURI, USE_MOCK, onEvent, type ScreenGeometry } from "./core/bridge";
import { setGeometry } from "./core/layout";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { Island } from "./island/island";
import { Tasks } from "./tasks/store";
import { checkReminders, claimMorning, notifyMorning, startReminders } from "./tasks/reminders";
import { Mock } from "./core/mock";
import { Mode } from "./core/mode";
import { Focus } from "./core/focus";
import { Updates, checkForUpdate } from "./core/updates";
import { Briefs } from "./views/views";

const UPDATE_EVERY_MS = 6 * 3600_000;

/** Looks for a new version. Automatic checks stay silent unless there is one. */
async function runUpdateCheck(island: Island, manual: boolean) {
  const r = await checkForUpdate();
  if (r.ok && r.update) {
    Updates.pending = r.update;
    if (State.isPinned && !manual) {
      // A reminder or the welcome card is up: try again in a minute.
      window.setTimeout(() => island.showUpdate(), 60_000);
      return;
    }
    island.showUpdate();
  } else if (manual) {
    island.note(
      r.ok
        ? `Nooky est à jour (version ${Updates.current}).`
        : "Je n'ai pas pu vérifier les mises à jour. Elles marchent avec la version téléchargée depuis GitHub, et il faut être en ligne.",
    );
    if (!r.ok) void Bridge.log(`update check failed: ${r.error}`);
  } else if (!r.ok) {
    void Bridge.log(`update check failed: ${r.error}`);
  }
}

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  // Dev harness: `?reset` wipes the fake sync folder, `#tasks`, `#reminder`… force a state.
  const params = new URLSearchParams(location.search);
  const force = location.hash.replace(/^#/, "");
  if (USE_MOCK && params.has("reset")) Mock.reset();

  void Sound.preload();

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
    setGeometry(boot.geometry);
  }
  document.documentElement.dataset.os = boot?.os ?? "browser";
  Updates.current = boot?.version ?? "";

  const island = new Island(root);
  island.applySettings();
  if (boot && !boot.cursorPoll) island.followPageCursor();

  State.hasApiKey = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
  Briefs.seen = (await Bridge.localGet<Record<string, string>>("briefsSeen")) ?? {};
  // Our own ask/answer files of the chat bridge are kept 7 days.
  void Bridge.syncCleanupBridge();
  window.setInterval(() => void Bridge.syncCleanupBridge(), 6 * 3600_000);

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));

  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "open":
        State.paused = false;
        island.alert(State.defaultView());
        break;
      case "update":
        void runUpdateCheck(island, true);
        break;
      case "shortcut":
        State.paused = false;
        island.alert("prompt");
        break;
      case "pause":
        State.paused = !State.paused;
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  await onEvent<null>("screen-changed", async () => {
    const g = await Bridge.reposition();
    if (g) {
      setGeometry(g as ScreenGeometry);
      island.relayout();
    }
  });

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", async (s) => {
    const dirChanged = s.syncDir !== State.settings.syncDir;
    State.settings = { ...State.settings, ...s };
    island.applySettings();
    State.hasApiKey = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
  Briefs.seen = (await Bridge.localGet<Record<string, string>>("briefsSeen")) ?? {};
  // Our own ask/answer files of the chat bridge are kept 7 days.
  void Bridge.syncCleanupBridge();
  window.setInterval(() => void Bridge.syncCleanupBridge(), 6 * 3600_000);
    if (dirChanged) void Tasks.reload();
  });
  await onEvent<unknown>("sync-changed", () => void Tasks.reload());
  // Settings → À propos → "Rechercher une mise à jour".
  await onEvent<unknown>("check-update", () => void runUpdateCheck(island, true));

  // Reading the sync folder can be slow (Drive downloads on demand): the
  // greeting never waits for it; the dev harness does, for stable screenshots.
  const tasksReady = Tasks.start();
  if (force) await tasksReady;

  // The morning summary: after the greeting on the first launch of the day, or
  // on the first peek after midnight.
  // No prénom yet: the greeting ends on the welcome card (the morning summary waits).
  if (!force && !(State.settings.firstName ?? "").trim()) island.welcomeAfterGreeting = true;
  const morningNow = force || island.welcomeAfterGreeting ? false : await claimMorning();
  if (morningNow) {
    island.morningAfterGreeting = true;
    void tasksReady.then(notifyMorning);
  }
  island.onWake = () => {
    void claimMorning().then((first) => {
      if (!first) return;
      notifyMorning();
      window.setTimeout(() => island.alert("morning"), 350);
    });
  };

  if (force && USE_MOCK) {
    island.onWake = null;
    devStart(island, force);
  } else {
    island.launch();
    // Reminders start once the greeting is over; updates a little later.
    window.setTimeout(() => startReminders(island.reminderHooks), 5200);
    window.setTimeout(() => void runUpdateCheck(island, false), 25_000);
    window.setInterval(() => void runUpdateCheck(island, false), UPDATE_EVERY_MS);
  }

  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

/** Browser-only: open the island straight on a state, for screenshots and tests. */
function devStart(island: Island, what: string) {
  document.body.classList.add("dev-harness");
  // Keep it open: the fake cursor never "leaves".
  State.settings.autoCloseInterval = 3600;
  island.fsm.homeToPetitDelay = 3600;
  island.fsm.petitToHiddenDelay = 3600;
  switch (what) {
    case "greeting":
      island.launch();
      break;
    case "reminder": {
      const t = Tasks.lists().open.find((x) => x.time) ?? Tasks.lists().open[0];
      if (t) island.reminderHooks.showReminder(t);
      break;
    }
    case "chat":
      island.devForce("prompt");
      break;
    case "update":
      void runUpdateCheck(island, true);
      break;
    case "chat-bridge": {
      island.devForce("prompt");
      State.hasApiKey = false;
      break;
    }
    case "chat-reply":
      island.devForce("prompt");
      State.hasApiKey = true;
      State.chatHistory = [
        { id: 1, role: "user", content: "Comment je relance le client sans être lourd ?" },
        { id: 2, role: "assistant", content: "Envoie-lui un récap en trois lignes et propose un point de 15 min jeudi. Je te prépare le mail ?" },
      ];
      island.engine.talking = true;
      State.notify();
      break;
    default:
      island.devForce(what);
  }
  (window as unknown as { nooky: unknown }).nooky = {
    island, State, Tasks, Mock, Mode, Focus,
    checkReminders: () => checkReminders(island.reminderHooks),
  };
}

void main();
