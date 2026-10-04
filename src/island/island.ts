// The island: DOM shell, sizing animation, Nooky's placement, mouse handling.
// Adapted from Coucou by Louis Raillé (MIT License, see LICENSE-COUCOU-MIT):
// the open/close springs and close curve, the peek on hover, the click-through
// rect and the frame loop are Coucou's, unchanged.

import { Tracked, Spring, clamp, Ease } from "../core/anim";
import { Bridge, IS_TAURI, notify, onDragDrop } from "../core/bridge";
import {
  EXPANDED_CORNER, EXPANDED_W, Geo, PANEL_H, PANEL_W, ROUNDED_CORNER,
  botGlowColor, botGlowOpacity, botPosition, islandSize, viewHeight,
  type BotEmoteName, type IslandMode, type IslandViewName,
} from "../core/layout";
import { Mode, modeAccent } from "../core/mode";
import { Focus } from "../core/focus";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { BotEngine } from "../nooky/engine";
import { Greeting } from "../nooky/greeting";
import { buildHeader, buildViews, Reminder, type ViewActions, type ViewHost } from "../views/views";
import { h } from "../views/dom";
import { IslandStateMachine, type FsmState } from "./fsm";
import { Tasks } from "../tasks/store";
import { showNext, type ReminderHooks } from "../tasks/reminders";
import { PauseInfo } from "../views/cards";
import { askAbout } from "../views/chat";
import type { Task } from "../tasks/oplog";
import { timeLabel } from "../tasks/parse";
import { nextMeeting } from "../tasks/records";
import { Updates } from "../core/updates";

const BOT_OVERHANG = 40;
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;

/** Seconds Nooky spends catching a dropped file before the bar shows. */
const CATCH_S = 0.8;
/** Seconds the little progress bar takes. */
const BAR_S = 1.1;

/** Views with a text field: leaving them hands the keyboard back. */
const KEYBOARD_VIEWS: ReadonlySet<IslandViewName> = new Set(["prompt", "tasks"]);

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);

export class Island {
  readonly fsm = new IslandStateMachine();

  /** Called when the island wakes from hidden (peek) — the morning check hangs off it. */
  onWake: (() => void) | null = null;
  /** Set at launch on the first start of the day: the greeting opens the morning card. */
  morningAfterGreeting = false;
  /** Set at launch when no prénom is known yet: the greeting opens the welcome card. */
  welcomeAfterGreeting = false;

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private greetingCanvas!: HTMLCanvasElement;
  private compactInfo!: HTMLElement;
  private compactCount!: HTMLElement;
  private compactNext!: HTMLElement;
  private focusBar!: HTMLElement;
  private focusTimer: number | null = null;
  private countdown!: HTMLElement;
  private wakeStrip!: HTMLElement;

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;

  private width = new Tracked(Geo.notchW);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  private botCx = new Spring(40);
  private botCy = new Spring(16);
  private botSize = new Spring(10);

  readonly engine = new BotEngine();
  private greeting = new Greeting();

  private running = false;
  private lastFrame = 0;
  private dirty = true;
  private canvasPx = 0;

  // Rust starts the window at full size so the launch greeting has room.
  private collapsed = false;
  private collapseTimer: number | null = null;
  private wasInIsland = false;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };
  private homeCollapseAt: number | null = null;

  // Bot hover → love
  private botHovering = false;
  private botHoverTimer: number | null = null;
  private lastLoveTime = 0;
  private botHoverStart = { x: 0, y: 0 };

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "overview";
  private lastSyncedView: IslandViewName | null = null;
  private keyboardTaken = false;

  // File drop
  private dropAt = 0;
  private ingestDone = false;
  private dropTimer: number | null = null;

  private talkTimer: number | null = null;
  private finishTimer: number | null = null;

  readonly reminderHooks: ReminderHooks = {
    showReminder: (t) => this.showReminder(t),
    showNotice: (n) => this.showNotice(n),
    showRecap: () => this.showRecap(),
    // Paused, focusing, or another card up: the card waits (the native notification still goes out).
    reminderShowing: () =>
      State.paused || Focus.active ||
      (State.mode === "expanded" && State.isPinned && ["reminder", "notice", "welcome", "update"].includes(State.view)),
  };

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
    this.wireFsm();
    this.wireInput();
    this.engine.onDizzy = () => this.handleDizzy();
    this.greeting.onComplete = () => this.onGreetingDone();
    State.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
    Tasks.subscribe(() => State.notify());
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      collapse: () => this.collapse(),
      openUrl: (url) => {
        if (url) void Bridge.openUrl(url);
      },
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        if (State.settings.soundEnabled) Sound.play("blip");
        State.notify();
      },
      openSettingsWindow: () => void Bridge.openSettingsWindow(),
      blip: () => Sound.play("blip"),
      wantKeyboard: (on) => this.wantKeyboard(on),
      emote: (e) => this.emote(e),
      taskChecked: (allDone) => this.taskChecked(allDone),
      talk: (s) => this.talk(s),
      reminderDone: () => {
        const t = Reminder.task;
        if (t) void Tasks.setDone(t.id, true);
        this.taskChecked(false);
        this.closeReminder();
      },
      reminderSnooze: () => {
        const t = Reminder.task;
        if (t) void Tasks.snooze(t.id, 30);
        Sound.play("blip");
        this.closeReminder();
      },
      reminderLater: () => this.closeReminder(),
      saveWelcome: (name, url) => this.saveWelcome(name, url),
      dismissWelcome: () => this.unpinAndCollapse(),
      installUpdate: () => void this.installUpdate(),
      dismissUpdate: () => this.unpinAndCollapse(),
      toggleMode: () => {
        Mode.toggle();
        Sound.play("blip");
        this.engine.triggerEmote("wink");
        State.notify();
      },
      startFocus: (min) => this.startFocus(min),
      stopFocus: () => this.stopFocus(false),
      closeCard: () => this.closeCard(),
      askAbout: (k) => void askAbout(k),
      heightChanged: () => this.animateGeometry(false),
    };

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.compactCount = h("span", { class: "cc-count" });
    this.compactNext = h("span", { class: "cc-next" });
    this.focusBar = h("div", { id: "focus-bar" }, h("i"));
    this.compactInfo = h("div", { id: "compact-info" }, this.compactNext, this.compactCount, this.focusBar);
    this.countdown = h("div", { id: "countdown" });

    this.header = buildHeader(actions);
    this.views = buildViews(actions, () => this.animateGeometry(false));
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    this.clipEl = h("div", { id: "island-clip" }, this.greetingCanvas, this.contentEl, this.compactInfo);
    this.islandEl = h("div", { id: "island" }, this.clipEl, this.botGlow, this.botCanvas, this.countdown);

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
    this.greetingCanvas.height = Math.round(150 * dpr);
    this.greetingCanvas.style.width = `${EXPANDED_W}px`;
    this.greetingCanvas.style.height = "150px";

    this.root.append(this.wakeStrip, this.islandEl);
    this.width.jump(Geo.notchW);
    this.height.jump(Geo.hasNotch ? Geo.notchH : 0);
    this.applyGeometry();
  }

  // ── FSM ─────────────────────────────────────────────────────────────────────

  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.onTransition = (from: FsmState, to: FsmState) => {
      if (from === "greet") this.leaveGreeting();
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "hidden") Sound.play("peek");
          this.setMode("compact");
          if (from === "greet") State.view = State.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          if (from === "hidden") this.onWake?.();
          break;
        case "home":
          this.expand(State.defaultView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "greet":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
    };
  }

  launch() {
    this.fsm.launch();
  }

  /** The greeting's Nooky hands over to the island's own, where it stands. */
  private leaveGreeting() {
    const p = this.greeting.handoff();
    this.greeting.interrupt();
    this.botCx.set(p.x);
    this.botCy.set(p.y);
    this.botSize.set(p.d / 0.6);
    this.engine.triggerEmote("happy", 1.2);
  }

  private onGreetingDone() {
    if (this.welcomeAfterGreeting && this.fsm.state === "greet") {
      this.welcomeAfterGreeting = false;
      this.showWelcome();
      return;
    }
    if (this.morningAfterGreeting && this.fsm.state === "greet") {
      this.morningAfterGreeting = false;
      this.alert("morning");
      return;
    }
    this.fsm.greetComplete();
  }

  // ── Mode / view ─────────────────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
      State.isPinned = false;
      // A click on the island may have activated the app (macOS): closing it
      // always hands the focus back to whatever app had it.
      this.keyboardTaken = false;
      void Bridge.focusWindow(false);
    }
    if (mode !== "expanded") {
      this.engine.anticipate(false);
      State.fileDragOver = false;
    }
    this.updateWindowCollapsed();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  expand(view: IslandViewName) {
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    this.homeCollapseAt = null;
    State.notify();
  }

  setView(view: IslandViewName) {
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const grew = this.viewHeight(view) >= this.viewHeight(State.view);
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry(!grew);
    State.notify();
  }

  private viewHeight(v: IslandViewName) {
    return viewHeight(v, State.chatHistory.length);
  }

  collapse() {
    State.isPinned = false;
    this.fsm.pinned = false;
    this.fsm.forcePetit();
  }

  /** Open straight on this view. Pinned alerts never auto-close. */
  alert(view: IslandViewName) {
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    this.expand(view);
  }

  reveal() {
    this.fsm.reveal();
  }

  /** The screen or its notch changed: resize to match. */
  relayout() {
    this.animateGeometry(false);
    this.pushedRect = { x: -1, y: -1, w: -1, h: -1 };
  }

  private wantKeyboard(on: boolean) {
    if (on === this.keyboardTaken) return;
    this.keyboardTaken = on;
    void Bridge.focusWindow(on);
  }

  // ── Nooky's moods ───────────────────────────────────────────────────────────

  emote(e: BotEmoteName) {
    this.engine.triggerEmote(e);
    this.ensureRunning();
  }

  private taskChecked(allDone: boolean) {
    this.engine.triggerEmote("proud");
    this.engine.emit("spark", 4);
    Sound.play("proud");
    if (allDone) {
      State.stateOverride = "finished";
      window.setTimeout(() => Sound.play("done"), 250);
      if (this.finishTimer != null) window.clearTimeout(this.finishTimer);
      this.finishTimer = window.setTimeout(() => {
        if (State.stateOverride === "finished") State.stateOverride = null;
        State.notify();
      }, 2600);
    }
    State.notify();
  }

  private talk(seconds: number) {
    this.engine.talking = true;
    if (this.talkTimer != null) window.clearTimeout(this.talkTimer);
    this.talkTimer = window.setTimeout(() => {
      this.engine.talking = false;
      this.engine.triggerEmote("happy", 1.4);
      this.ensureRunning();
    }, seconds * 1000);
    this.ensureRunning();
  }

  // ── Reminders ───────────────────────────────────────────────────────────────

  private showReminder(t: Task) {
    Reminder.task = t;
    State.isPinned = true;
    State.stateOverride = "approval";
    Sound.play("reminder");
    void Bridge.log(`reminder ${t.time ? timeLabel(t.time) : ""} ${t.id}`);
    this.alert("reminder");
  }

  private closeReminder() {
    Reminder.task = null;
    if (State.stateOverride === "approval") State.stateOverride = null;
    State.isPinned = false;
    this.fsm.pinned = false;
    State.view = State.defaultView();
    showNext(this.reminderHooks);
    if (!Reminder.task) this.collapse();
    State.notify();
  }

  private showNotice(n: NonNullable<typeof State.notice>) {
    State.notice = n;
    State.isPinned = true;
    Sound.play("reminder");
    this.engine.triggerEmote("surprised", 1);
    this.alert("notice");
  }

  private showRecap() {
    if (Focus.active || (State.mode === "expanded" && State.isPinned)) return;
    this.engine.triggerEmote("happy", 1.6);
    Sound.play("greet");
    this.alert("recap");
  }

  /** OK on a notice, recap or pause card: next card if one waits, else compact. */
  private closeCard() {
    State.notice = null;
    State.isPinned = false;
    this.fsm.pinned = false;
    State.view = State.defaultView();
    showNext(this.reminderHooks);
    if (!(State.mode === "expanded" && State.isPinned)) this.collapse();
    State.notify();
  }

  // ── Focus ───────────────────────────────────────────────────────────────────

  startFocus(minutes: number) {
    Focus.start(minutes);
    PauseInfo.minutes = minutes;
    this.engine.calm = true;
    this.engine.triggerEmote("yawn");
    Sound.play("blip");
    State.isPinned = false;
    this.fsm.pinned = false;
    if (this.focusTimer != null) window.clearInterval(this.focusTimer);
    this.focusTimer = window.setInterval(() => {
      if (Focus.remainingMs() <= 0) this.stopFocus(true);
      else State.notify();
    }, 1000);
    this.collapse();
    State.notify();
  }

  /** End of the session: `natural` → chime and "Pause !", else just stop. */
  stopFocus(natural: boolean) {
    if (this.focusTimer != null) window.clearInterval(this.focusTimer);
    this.focusTimer = null;
    const held = Focus.stop();
    this.engine.calm = false;
    PauseInfo.held = held.length;
    if (held.length) {
      const first = held.slice(0, 3).map((n) => n.body).join(" · ");
      void notify("Pendant ta concentration", held.length > 1 ? `${held.length} rappels : ${first}` : `${held[0].title} : ${held[0].body}`);
    }
    if (natural) {
      Sound.play("chime");
      this.engine.triggerEmote("happy", 1.6);
      State.isPinned = true;
      this.alert("pause");
    } else {
      showNext(this.reminderHooks);
    }
    State.notify();
  }

  // ── Welcome, updates, notes ─────────────────────────────────────────────────

  showWelcome() {
    State.isPinned = true;
    this.engine.greet(false);
    this.alert("welcome");
  }

  private saveWelcome(firstName: string, url: string) {
    State.settings = { ...State.settings, firstName, maisonUrl: url };
    void Bridge.saveSettings(State.settings);
    this.wantKeyboard(false);
    this.engine.triggerEmote("happy");
    this.engine.emit("spark", 6);
    Sound.play("done");
    State.isPinned = false;
    this.fsm.pinned = false;
    this.setView("overview");
  }

  private unpinAndCollapse() {
    this.wantKeyboard(false);
    State.isPinned = false;
    this.fsm.pinned = false;
    this.collapse();
  }

  /** A new version is waiting: say it gently (not pinned, it closes on its own). */
  showUpdate() {
    if (!Updates.pending) return;
    Updates.status = "idle";
    this.engine.triggerEmote("surprised", 1);
    window.setTimeout(() => this.engine.triggerEmote("happy", 1.6), 900);
    Sound.play("greet");
    this.alert("update");
  }

  private async installUpdate() {
    const u = Updates.pending;
    if (!u || Updates.status === "installing") return;
    Updates.status = "installing";
    Updates.progress = null;
    State.isPinned = true;
    this.fsm.pinned = true;
    State.stateOverride = "working";
    State.notify();
    try {
      await u.install((p) => {
        Updates.progress = p;
        State.notify();
      });
    } catch (err) {
      Updates.status = "error";
      Updates.error = String(err).replace(/^Error:\s*/, "");
      State.stateOverride = null;
      State.isPinned = false;
      this.fsm.pinned = false;
      Sound.play("error");
      State.notify();
    }
  }

  /** A short message in the island. */
  note(message: string) {
    State.noteMessage = message;
    this.alert("note");
  }

  // ── File drop ───────────────────────────────────────────────────────────────

  private onDragDrop(e: { type: string; paths?: string[] }) {
    if (State.paused) return;
    switch (e.type) {
      case "enter":
      case "over": {
        if (State.fileDragOver) return;
        State.fileDragOver = true;
        if (State.view !== "upload") State.droppedFile = null;
        this.engine.anticipate(true);
        Sound.play("hover");
        this.alert("upload");
        break;
      }
      case "leave": {
        if (!State.fileDragOver) return;
        State.fileDragOver = false;
        this.engine.anticipate(false);
        // The island stays open: the drag session is still alive.
        State.notify();
        break;
      }
      case "drop": {
        State.fileDragOver = false;
        const path = e.paths?.[0];
        if (!path) {
          this.engine.anticipate(false);
          this.setView(State.defaultView());
          return;
        }
        this.catchFile(path);
        break;
      }
    }
  }

  /**
   * Nooky catches the file. The copy into the inbox runs in the background, so
   * a slow disk never stalls the animation.
   */
  catchFile(path: string) {
    const name = path.split(/[\\/]/).pop() || "fichier";
    State.fileDragOver = false;
    State.droppedText = null;
    State.droppedFile = { name, path };
    State.chatHistory = [];
    void Bridge.chatReset();

    if (State.view !== "upload" || State.mode !== "expanded") this.alert("upload");
    this.engine.dropReaction();
    Sound.play("drop");
    State.uploadProgress = 0;
    this.dropAt = performance.now();
    this.ingestDone = false;
    if (this.dropTimer != null) window.clearTimeout(this.dropTimer);
    this.dropTimer = window.setTimeout(() => {
      this.dropTimer = null;
      if (State.view === "upload") this.setView("uploading");
    }, CATCH_S * 1000);
    this.ensureRunning();

    void Bridge.ingestFile(path)
      .then((file) => {
        State.droppedFile = { name: file.name, path: file.path };
        this.ingestDone = true;
        State.notify();
      })
      .catch((err) => {
        if (this.dropTimer != null) window.clearTimeout(this.dropTimer);
        State.noteMessage = String(err).replace(/^Error:\s*/, "");
        State.droppedFile = null;
        this.engine.triggerEmote("annoyed");
        this.setView("note");
        Sound.play("error");
      });
  }

  /** Text dropped on the island: "Que veux-tu que j'en fasse ?". */
  catchText(text: string) {
    State.droppedFile = null;
    State.droppedText = text.slice(0, 20_000);
    State.chatHistory = [];
    void Bridge.chatReset();
    this.engine.dropReaction();
    Sound.play("drop");
    this.alert("choose");
  }

  /** Drives the little progress bar Nooky rides, then shows the choose card. */
  private stepUpload(nowMs: number) {
    if (State.view !== "uploading") return;
    const t = (nowMs - this.dropAt) / 1000 - CATCH_S;
    const p = Ease.inOut(clamp(t / BAR_S, 0, 1));
    const shown = this.ingestDone ? p : Math.min(p, 0.9);
    if (Math.abs(shown - State.uploadProgress) > 0.002) {
      State.uploadProgress = shown;
      State.notify();
    }
    if (shown >= 1 && t > BAR_S + 0.35) {
      Sound.play("done");
      this.engine.triggerEmote("happy");
      this.setView("choose");
    }
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  private targetSize(): { w: number; h: number; r: number } {
    const { w, h } = islandSize(State.mode, State.view, State.chatHistory.length);
    const r = State.mode === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER;
    return { w, h, r };
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = Math.min(this.radius.value, hh / 2);
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.borderRadius = `0 0 ${r}px ${r}px`;
    this.islandEl.style.transform = `translateX(-50%)`;
    this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;

    const rect = { x: (PANEL_W - w) / 2, y: 0, w, h: hh };
    const p = this.pushedRect;
    if (Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /** Island rect in window coordinates (origin top-left of the 720×320 window). */
  private islandRect(): { x: number; y: number; w: number; h: number } {
    const w = this.width.value;
    const hh = this.height.value;
    return { x: (PANEL_W - w) / 2, y: 0, w, h: hh };
  }

  // ── Window collapse (hidden → wake strip on Windows; slow poll on macOS) ───

  private updateWindowCollapsed() {
    if (this.collapseTimer != null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    if (State.mode === "hidden") {
      // Let the island finish retracting, then drop the window to the wake strip.
      this.collapseTimer = window.setTimeout(() => {
        this.collapseTimer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        void Bridge.setCollapsed(true);
      }, 420);
    } else if (this.collapsed) {
      this.collapsed = false;
      void Bridge.setCollapsed(false);
    }
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private wireInput() {
    // The wake strip is the only thing the OS can hit while the island is hidden (Windows).
    this.wakeStrip.addEventListener("mouseenter", () => {
      Sound.resume();
      if (State.mode === "hidden") this.fsm.mouseEntered();
    });

    window.setInterval(() => State.notify(), 6_000);
    window.addEventListener("mousemove", () => {
      if (State.sleepy) {
        State.lastActivity = performance.now();
        this.engine.triggerEmote("surprised", 1);
        State.notify();
      } else State.lastActivity = performance.now();
    });
    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      if (State.mode !== "expanded") {
        this.fsm.click();
        return;
      }
      if (this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.engine.slap();
      }
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && State.mode === "expanded" && !State.isPinned) this.collapse();
      State.lastActivity = performance.now();
    });

    void onDragDrop((e) => this.onDragDrop(e));

    // Text dragged from another app (a selection): the webview's own drop
    // event. Files go through Tauri's drag-and-drop above.
    this.islandEl.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("text/plain") && !e.dataTransfer.types.includes("Files")) e.preventDefault();
    });
    this.islandEl.addEventListener("drop", (e) => {
      const text = e.dataTransfer?.getData("text/plain") ?? "";
      if (!text.trim() || e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      this.catchText(text);
    });

    // Outside Tauri (plain browser) drive the cursor from DOM events.
    if (!IS_TAURI) this.followPageCursor();
  }

  /**
   * Takes the cursor from the page's own mouse events instead of Rust's poll
   * (Wayland, and the browser dev harness).
   */
  followPageCursor() {
    window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    window.addEventListener("mouseout", (e) => {
      if (e.relatedTarget == null) this.onCursor(-10_000, -10_000);
    });
  }

  /** Cursor in window-logical coordinates. */
  onCursor(x: number, y: number) {
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

    // Hidden in a notch, only the notch itself wakes the island: a wide margin
    // would catch the cursor on its way to a menu-bar icon next to it.
    const margin = State.mode === "hidden" && Geo.hasNotch ? 2 : HIT_MARGIN;
    const inIsland =
      x >= rect.x - margin && x <= rect.x + rect.w + margin &&
      y >= rect.y - margin && y <= rect.y + rect.h + margin;

    if (inIsland && !this.wasInIsland) {
      if (this.fsm.state === "greet") this.greeting.hover();
      this.fsm.mouseEntered();
      this.homeCollapseAt = null;
    }
    if (!inIsland && this.wasInIsland) {
      this.fsm.mouseLeft();
      if (this.fsm.state === "home" && !State.isPinned) {
        this.homeCollapseAt = performance.now() + State.settings.autoCloseInterval * 1000;
      }
    }
    this.wasInIsland = inIsland;

    // Hovering Nooky for a while → love.
    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    if (this.botHovering) {
      const d = Math.hypot(x - this.botHoverStart.x, y - this.botHoverStart.y);
      if (d > 40) {
        this.botHoverStart = { x, y };
        this.scheduleLove();
      }
    }

    this.ensureRunning();
  }

  private isBotHit(x: number, y: number): boolean {
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value;
    const cy = rect.y + this.botCy.value;
    const radius = (this.botSize.value * 0.6) / 2 * 1.15;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  private botHoverIn(x: number, y: number) {
    if (performance.now() / 1000 - this.lastLoveTime < 6) return;
    this.botHoverStart = { x, y };
    this.engine.blink();
    this.engine.tgEs = 1.08;
    Sound.play("hover");
    this.scheduleLove();
  }

  private scheduleLove() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = window.setTimeout(() => {
      this.botHoverTimer = null;
      if (!this.botHovering || State.stateOverride != null) return;
      if (performance.now() / 1000 - this.lastLoveTime < 6) return;
      this.lastLoveTime = performance.now() / 1000;
      this.engine.triggerEmote("love");
      Sound.play("love");
    }, 2000);
  }

  private cancelBotHover() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = null;
    this.engine.tgEs = 1;
  }

  /** Three slaps → dizzy + confused view for 3.3 s, then back. */
  private handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.alert("confused");
    if (this.confusedRecovery != null) window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      if (State.stateOverride === "dizzy") State.stateOverride = null;
      this.engine.setState(State.effectiveState);
      if (State.view === "confused") {
        const fallback = State.defaultView();
        this.setView(this.prevViewBeforeConfused === "confused" ? fallback : this.prevViewBeforeConfused);
      }
      this.engine.triggerEmote("happy");
    }, 3300);
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(0.05, Math.max(0, (nowMs - this.lastFrame) / 1000));
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    }
    this.drawBot(dt);

    this.views.get(State.view)?.tick?.(nowMs);
    this.stepUpload(nowMs);
    this.updateCountdown(nowMs);

    // Nothing is drawn while the island is hidden, so nothing may keep the loop
    // alive either; geometry still has to finish retracting.
    const settling = this.width.animating || this.height.animating || this.radius.animating;
    const busy = State.mode === "hidden"
      ? settling
      : settling ||
        !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
        greetingActive || this.engine.busy || State.view === "uploading" ||
        (State.mode === "expanded" && this.homeCollapseAt != null);

    if (busy) {
      requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  private updateBotTargets() {
    const p = botPosition(State.mode, State.view, this.height.value, State.uploadProgress);
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    const visible = p.opacity > 0 && !greetingActive;
    this.botCanvas.style.opacity = visible ? "1" : "0";

    if (State.mode === "expanded" && State.view !== "uploading" && !greetingActive) {
      const d = p.diameter;
      const color = botGlowColor(State.effectiveState, modeAccent().hex);
      this.botGlow.style.display = "block";
      this.botGlow.style.width = `${d * 2.2}px`;
      this.botGlow.style.height = `${d * 2.2}px`;
      this.botGlow.style.left = `${this.botCx.value - d * 1.1}px`;
      this.botGlow.style.top = `${this.botCy.value - d * 1.1}px`;
      this.botGlow.style.background = `radial-gradient(circle, ${color} 0%, transparent 62%)`;
      this.botGlow.style.opacity = String(botGlowOpacity(State.effectiveState));
    } else {
      this.botGlow.style.display = "none";
    }
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvasPx !== w) {
      this.canvasPx = w;
      this.botCanvas.width = Math.round(w * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      this.botCanvas.style.width = `${w}px`;
      this.botCanvas.style.height = `${hCss}px`;
    }
    this.botCanvas.style.left = `${this.botCx.value - w / 2}px`;
    this.botCanvas.style.top = `${this.botCy.value - BOT_OVERHANG / 2 - hCss / 2}px`;

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    this.engine.floatOn = State.mode === "expanded" && State.view !== "uploading" && State.view !== "greeting";
    this.engine.particleOverhang = BOT_OVERHANG;
    this.engine.groundTint = modeAccent().rgb;
    this.engine.lookX = this.lookX();
    this.engine.lookY = this.lookY();
    this.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hCss);
    if (State.mode === "hidden" && this.botCanvas.style.opacity === "0") return;
    this.engine.draw(ctx, w, hCss);
  }

  /** Eyes follow the cursor — tanh of the distance to Nooky. */
  private lookX(): number {
    const rect = this.islandRect();
    const botScreenX = rect.x + this.botCx.value;
    return Math.tanh((State.mouse.x - botScreenX) / 260);
  }

  private lookY(): number {
    return -Math.tanh((State.mouse.y - this.botCy.value) / 200);
  }

  private updateCountdown(nowMs: number) {
    if (State.mode !== "expanded" || State.isPinned || this.homeCollapseAt == null) {
      this.countdown.style.width = "0px";
      return;
    }
    const autoClose = State.settings.autoCloseInterval;
    const windowS = Math.min(10, autoClose * 0.6);
    const remaining = (this.homeCollapseAt - nowMs) / 1000;
    if (remaining < 0) this.homeCollapseAt = null;
    this.countdown.style.width =
      remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px";
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────

  private syncDom() {
    const expanded = State.mode === "expanded";
    const accent = modeAccent();
    const rootStyle = document.documentElement.style;
    if (rootStyle.getPropertyValue("--accent") !== accent.hex) {
      rootStyle.setProperty("--accent", accent.hex);
      rootStyle.setProperty("--accent-rgb", accent.rgb.join(","));
    }
    this.islandEl.dataset.mode = Mode.current();
    const greetingActive = expanded && State.view === "greeting";

    this.contentEl.style.opacity = expanded && !greetingActive ? "1" : "0";
    this.contentEl.style.pointerEvents = expanded && !greetingActive ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }

    // Keyboard: the chat takes it when opened (you came to type); the tasks
    // view only when its field is clicked. Leaving them gives it back.
    if (this.lastSyncedView !== State.view) {
      const prev = this.lastSyncedView;
      this.lastSyncedView = State.view;
      if (State.view === "prompt" && expanded) {
        this.wantKeyboard(true);
        window.setTimeout(() => this.views.get("prompt")?.focus?.(), 120);
      } else if (prev && KEYBOARD_VIEWS.has(prev)) {
        this.wantKeyboard(false);
      }
    }

    this.syncCompact();
    this.engine.setState(State.effectiveState);
  }

  /** Compact island: today's count in the right wing, the next task in the middle when there is no notch. */
  private syncCompact() {
    const show = State.mode === "compact";
    this.compactInfo.style.opacity = show ? "1" : "0";
    this.compactInfo.classList.toggle("notch", Geo.hasNotch);
    const focusing = Focus.active;
    this.compactInfo.classList.toggle("focus", focusing);
    if (!focusing) this.engine.focusRing = -1;
    if (!show) return;
    if (focusing) {
      const min = Focus.remainingMin();
      this.compactCount.textContent = `${min} min`;
      this.compactCount.classList.remove("all");
      this.compactNext.textContent = Geo.hasNotch ? "" : "Concentration";
      (this.focusBar.firstChild as HTMLElement).style.width = `${(Focus.progress() * 100).toFixed(2)}%`;
      this.engine.focusRing = Focus.progress();
      return;
    }
    const mode = Mode.current();
    const p = Tasks.progress(undefined, mode);
    this.compactCount.textContent = p.total ? `${p.done}/${p.total}` : "";
    this.compactCount.classList.toggle("all", p.total > 0 && p.done === p.total);
    const next = Tasks.lists(undefined, mode).open[0];
    // The reduced text rotates: next task, next meeting, unread mail. A meeting under 15 min takes over.
    const items: string[] = [];
    if (next) items.push(`${next.time ? `${timeLabel(next.time)} · ` : ""}${next.title}`);
    const meet = nextMeeting(Tasks.events());
    if (meet) items.push(meet.min <= 15 ? `Réunion dans ${Math.max(0, meet.min)} min · ${meet.e.title}` : `${timeLabel(meet.e.time!)} · ${meet.e.title}`);
    const unread = Tasks.unreadMails().length;
    if (unread) items.push(`${unread} mail${unread > 1 ? "s" : ""} non lu${unread > 1 ? "s" : ""}`);
    const urgent = !!meet && meet.min <= 15;
    const shown = urgent ? items[next ? 1 : 0] : items[Math.floor(Date.now() / 6000) % Math.max(1, items.length)];
    this.compactNext.textContent = !Geo.hasNotch && shown ? shown : "";
    this.compactNext.classList.toggle("urgent", urgent);
  }

  /** Applies settings coming from Rust at boot or from the settings window. */
  applySettings() {
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    State.notify();
  }

  get panelSize() {
    return { w: PANEL_W, h: PANEL_H };
  }

  // ── Dev harness (browser only) ──────────────────────────────────────────────

  /** Forces a state for screenshots and tests: #greeting, #compact, #peek… */
  devForce(what: string) {
    switch (what) {
      case "compact":
      case "peek":
        this.fsm.forcePetit();
        break;
      case "hidden":
        this.fsm.forceHidden();
        break;
      case "drop":
        this.alert("upload");
        State.fileDragOver = true;
        this.engine.anticipate(true);
        State.notify();
        break;
      case "confused":
        this.handleDizzy();
        break;
      case "welcome":
        this.showWelcome();
        break;
      case "drop-catch":
        this.catchFile("/Users/moi/Documents/Compte rendu septembre.pdf");
        break;
      case "drop-text":
        this.catchText("Bonjour, pouvez-vous m'envoyer le devis d'ici jeudi ? Il faudrait aussi caler une réunion la semaine prochaine pour le planning.");
        break;
      case "focus":
        this.startFocus(25);
        break;
      case "pause":
        PauseInfo.held = 2;
        State.isPinned = true;
        this.alert("pause");
        break;
      case "recap":
        this.showRecap();
        break;
      case "notice":
        this.showNotice({ label: "Abonnement", title: "Netflix : renouvellement dans 3 jours", sub: "13,49 € par mois. Garde-le ou résilie-le à temps.", view: "subs" });
        break;
      default:
        this.alert(what as IslandViewName);
    }
  }
}
