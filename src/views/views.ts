// Island views. The view/host plumbing and the card/button styling are adapted
// from Coucou by Louis Raillé (MIT License, see LICENSE-COUCOU-MIT); the views
// themselves (overview, Ma journée, reminder, morning, the "Plus" views…) are
// Nooky's.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { State, hello, maisonUrl } from "../core/state";
import { DynamicHeights, washRGBA, type BotEmoteName, type IslandViewName, type Wash } from "../core/layout";
import { Mode } from "../core/mode";
import { ACCENT, nextBoundary } from "../core/hours";
import { Focus } from "../core/focus";
import { Bridge } from "../core/bridge";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { buildNotice, buildPause, buildRecap, buildUpdate, buildWelcome } from "./cards";
import { buildAgenda, buildMail, buildShopping, buildSubs, buildWatch } from "./lists";
import { buildBriefs } from "./briefs";
import { Tasks, type CaptureResult } from "../tasks/store";
import { carriedLabel, type Task } from "../tasks/oplog";
import { dayKey, dayName, timeLabel, JOURS } from "../tasks/parse";
import { morningSummary } from "../tasks/reminders";
import { ruleLabel, type Rule } from "../tasks/routines";
import { firstLine, SLOTS } from "../tasks/briefs";

export type QuickKind = "summary" | "reply" | "translate" | "tasks";

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  openUrl(url: string): void;
  toggleSound(): void;
  openSettingsWindow(): void;
  blip(): void;
  /** The island takes the keyboard (a text field was clicked) or gives it back. */
  wantKeyboard(on: boolean): void;
  emote(e: BotEmoteName): void;
  /** A task was just ticked. `allDone` → "Journée bouclée !". */
  taskChecked(allDone: boolean): void;
  /** Nooky reads an answer out for `seconds`, then looks happy. */
  talk(seconds: number): void;
  /** Reminder card answers. */
  reminderDone(): void;
  reminderSnooze(): void;
  reminderLater(): void;
  /** Welcome card: save the prénom and the lien de la maison. */
  saveWelcome(firstName: string, maisonUrl: string): void;
  dismissWelcome(): void;
  installUpdate(): void;
  dismissUpdate(): void;
  /** Header chip: pro ⇄ perso until the next boundary. */
  toggleMode(): void;
  startFocus(minutes: number): void;
  stopFocus(): void;
  /** OK on a notice / recap / pause card. */
  closeCard(): void;
  /** Quick action on a dropped file or text. */
  askAbout(kind: QuickKind): void;
  /** A view's content changed its height. */
  heightChanged(): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

export function card(wash: Wash, cls: string, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: `card${wash ? " wash" : ""}${cls ? ` ${cls}` : ""}` }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

export function btn(label: string, kind: "primary" | "secondary" | "ghost", onClick: () => void, icon?: string): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: (e: Event) => { e.stopPropagation(); onClick(); } },
    icon ? svg(icon, 12, icon === ICONS.check ? { stroke: 2.6 } : {}) : null,
    h("span", { text: label }),
  );
}

export function linkBtn(label: string, onClick: () => void, cls = ""): HTMLElement {
  return h("button", { class: `linkbtn${cls ? ` ${cls}` : ""}`, text: label, onclick: (e: Event) => { e.stopPropagation(); onClick(); } });
}

export function progressBar(): { el: HTMLElement; set(done: number, total: number): void } {
  const fill = h("i");
  const el = h("div", { class: "pbar" }, fill);
  return {
    el,
    set(done, total) {
      fill.style.width = total ? `${Math.round((100 * done) / total)}%` : "0%";
      el.classList.toggle("complete", total > 0 && done === total);
    },
  };
}

export function countText(done: number, total: number): string {
  if (!total) return "rien de prévu";
  return `${done}/${total} faite${done > 1 ? "s" : ""}`;
}

export function todayLabel(d = new Date()): string {
  const s = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "short" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A text field that takes the keyboard only when clicked; Enter submits. */
export function textField(actions: ViewActions, placeholder: string, onSubmit: (v: string) => void, cls = "tk-input"): HTMLInputElement {
  const input = h("input", { type: "text", class: cls, placeholder, spellcheck: "false", maxlength: "300" }) as HTMLInputElement;
  input.addEventListener("pointerdown", () => actions.wantKeyboard(true));
  input.addEventListener("keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === "Escape") {
      input.blur();
      actions.wantKeyboard(false);
    } else if (k === "Enter") {
      e.preventDefault();
      const v = input.value.trim();
      if (v) {
        input.value = "";
        onSubmit(v);
      }
    }
    e.stopPropagation();
  });
  return input;
}

/** "Noté…" feedback with an optional "Annuler" (writes deleted: true). */
export function feedbackLine(): { el: HTMLElement; say(text: string, undo?: CaptureResult): void } {
  const text = h("span", { class: "fb-text" });
  const undoBtn = h("button", { class: "linkbtn fb-undo", text: "Annuler" });
  const el = h("div", { class: "tk-feedback" }, text, undoBtn);
  let timer: number | null = null;
  let current: CaptureResult | undefined;
  undoBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (current) void Tasks.undo(current);
    current = undefined;
    text.textContent = "Annulé.";
    undoBtn.style.display = "none";
  });
  return {
    el,
    say(t, undo) {
      current = undo;
      text.textContent = t;
      undoBtn.style.display = undo ? "" : "none";
      el.classList.add("on");
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => el.classList.remove("on"), undo ? 6000 : 3200);
    },
  };
}

/** The list layout: a side column for Nooky, a head, then the content. */
export function listCard(cls: string, head: HTMLElement[], ...body: HTMLElement[]): { el: HTMLElement; side: HTMLElement } {
  const side = h("div", { class: "tk-side" });
  const main = h("div", { class: "tk-main" }, h("div", { class: "tk-head" }, ...head), ...body);
  return { el: h("div", { class: `view ${cls}` }, card(null, "tk-card", side, main)), side };
}

interface RowOpts {
  kind: "open" | "done" | "later";
  today: string;
  withActions: boolean;
  armed: boolean;
  onToggle(t: Task): void;
  onTomorrow?(t: Task): void;
  onRemove?(t: Task): void;
}

/** One task line: round checkbox, title, tags, and (in Ma journée) Demain / Retirer. */
export function taskRow(t: Task, o: RowOpts): HTMLElement {
  const carried = o.kind === "open" ? carriedLabel(t, o.today) : "";
  const check = h(
    "button",
    {
      class: `chk${t.done ? " on" : ""}`,
      title: t.done ? "Remettre à faire" : "Marquer comme faite",
      onclick: (e: Event) => { e.stopPropagation(); o.onToggle(t); },
    },
    t.done ? svg(ICONS.check, 9, { stroke: 3.2 }) : null,
  );
  const tags = h("span", { class: "tags" });
  if (t.time && o.kind !== "done") tags.append(h("span", { class: "tag time", text: timeLabel(t.time) }));
  if (o.kind === "later") tags.append(h("span", { class: "tag", text: dayName(t.day, o.today) }));
  if (carried) tags.append(h("span", { class: "tag late", text: carried }));
  if (t.routine) tags.append(h("span", { class: "tag rep", title: "Routine" }, svg(ICONS.repeat, 9)));
  if (Mode.showAll || o.kind !== "open") {
    if (t.tiroir !== Mode.current()) tags.append(h("span", { class: `tag ${t.tiroir}`, text: t.tiroir }));
  }
  const row = h(
    "li",
    { class: `task${t.done ? " done" : ""}${carried ? " carried" : ""}` },
    check,
    h("span", { class: "tt", text: t.title, title: t.title }),
    tags,
  );
  if (o.withActions) {
    const acts = h("span", { class: "ta" });
    if (o.kind === "open" && o.onTomorrow && !t.routine) {
      acts.append(linkBtn("Demain", () => o.onTomorrow!(t)));
    }
    if (o.onRemove) {
      acts.append(linkBtn(o.armed ? (t.routine ? "Pas aujourd'hui ?" : "Retirer ?") : t.routine ? "Pas aujourd'hui" : "Retirer", () => o.onRemove!(t), o.armed ? "warn" : ""));
    }
    row.append(acts);
    if (o.armed) row.classList.add("armed");
  }
  return row;
}

export function checkTask(actions: ViewActions, t: Task) {
  const wasDone = t.done;
  void Tasks.setDone(t.id, !wasDone);
  if (!wasDone) {
    const p = Tasks.progress(dayKey(), Mode.showAll ? null : Mode.current());
    actions.taskChecked(p.total > 0 && p.done === p.total);
  } else {
    actions.blip();
  }
}

/** Is it "Sac de demain" time (from 17:00)? */
export const sacTime = (d = new Date()) => d.getHours() >= 17;

/** The little "Sac de demain" checklist (tomorrow's kind "sac" routines). */
export function sacChips(actions: ViewActions, items: Task[]): HTMLElement {
  const row = h("div", { class: "sac-row" }, h("span", { class: "sac-label" }, svg(ICONS.bag, 11), h("span", { text: "Sac de demain" })));
  for (const t of items) {
    row.append(h("button", {
      class: `sac-chip${t.done ? " on" : ""}`,
      title: t.done ? "Prêt" : "À préparer",
      onclick: (e: Event) => {
        e.stopPropagation();
        void Tasks.setDone(t.id, !t.done);
        if (!t.done) actions.emote("happy");
        actions.blip();
      },
    }, h("i", { class: "sac-box" }, t.done ? svg(ICONS.check, 8, { stroke: 3.4 }) : null), h("span", { text: t.title })));
  }
  return row;
}

/** Natural height of a flex column's visible children (with `gap` between them). */
export function contentHeight(col: HTMLElement, gap: number): number {
  let total = 0;
  let n = 0;
  for (const c of Array.from(col.children) as HTMLElement[]) {
    if (c.style.display === "none" || !c.offsetHeight) continue;
    total += c.offsetHeight;
    n++;
  }
  return total + Math.max(0, n - 1) * gap;
}

// ── Header ────────────────────────────────────────────────────────────────────

const MORE_VIEWS: { view: IslandViewName; label: string; icon: string }[] = [
  { view: "shopping", label: "Courses", icon: ICONS.cart },
  { view: "subs", label: "Abonnements", icon: ICONS.card },
  { view: "agenda", label: "Agenda", icon: ICONS.calendar },
  { view: "watch", label: "À suivre", icon: ICONS.bookmark },
  { view: "mail", label: "Courrier", icon: ICONS.mail },
];

export function buildHeader(actions: ViewActions): ViewHost {
  const tab = (title: string, icon: string, v: IslandViewName) =>
    h("button", { class: "tab", title, onclick: (e: Event) => { e.stopPropagation(); closeMenu(); go(v); } }, svg(icon, 13));
  const tabHome = tab("Accueil", ICONS.house, "overview");
  const tabTasks = tab("Ma journée", ICONS.list, "tasks");
  const tabChat = tab("Chat", ICONS.bubble, "prompt");
  const tabBrief = tab("Briefs", ICONS.sun, "brief");
  const briefDot = h("i", { class: "tab-dot" });
  tabBrief.append(briefDot);
  const moreIcon = h("span", { class: "more-icon" });
  const moreDot = h("i", { class: "tab-dot" });
  const tabMore = h("button", { class: "tab", title: "Plus", onclick: (e: Event) => { e.stopPropagation(); toggleMenu(); } }, moreIcon, moreDot);

  const menu = h("div", { class: "more-menu" });
  const menuItems = MORE_VIEWS.map((m) => {
    const count = h("span", { class: "mm-count" });
    const item = h("button", {
      class: "mm-item",
      onclick: (e: Event) => { e.stopPropagation(); closeMenu(); go(m.view); },
    }, svg(m.icon, 12), h("span", { text: m.label }), count);
    menu.append(item);
    return { ...m, item, count };
  });

  const modeChip = h("button", {
    class: "mode-chip",
    onclick: (e: Event) => { e.stopPropagation(); actions.toggleMode(); },
  });
  const gearBtn = h("button", { title: "Réglages", onclick: () => actions.openSettingsWindow() }, svg(ICONS.gear, 14));
  const soundBtn = h("button", { title: "Sons", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));
  const collapseBtn = h("button", { title: "Réduire", onclick: () => actions.collapse() }, svg(ICONS.chevronUp, 16));

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }
  function toggleMenu() {
    menu.classList.toggle("open");
    actions.blip();
  }
  function closeMenu() {
    menu.classList.remove("open");
  }
  document.addEventListener("mousedown", (e) => {
    if (!menu.contains(e.target as Node) && e.target !== tabMore) closeMenu();
  });

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabTasks, tabChat, tabBrief, tabMore),
    menu,
    h("div", { class: "header-actions" }, modeChip, gearBtn, soundBtn, collapseBtn),
  );

  let soundKey = "";
  let moreKey: string | null = null;
  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "morning" || v === "recap");
      tabTasks.classList.toggle("on", v === "tasks");
      tabChat.classList.toggle("on", v === "prompt");
      tabBrief.classList.toggle("on", v === "brief");
      briefDot.style.display = Briefs.hasNew() ? "" : "none";
      const more = MORE_VIEWS.find((m) => m.view === v);
      tabMore.classList.toggle("on", !!more);
      const unreadMail = Tasks.unreadMails().length;
      moreDot.style.display = unreadMail && !more ? "" : "none";
      const mk = `${more?.view ?? ""}`;
      if (mk !== moreKey) {
        moreKey = mk;
        clear(moreIcon);
        moreIcon.append(svg(more ? more.icon : ICONS.ellipsis, 13));
        tabMore.title = more ? `Plus · ${more.label}` : "Plus";
      }
      for (const m of menuItems) {
        m.item.classList.toggle("on", m.view === v);
        const n = m.view === "mail" ? unreadMail : m.view === "shopping" ? Tasks.shopping().filter((s) => !s.done).length : 0;
        m.count.textContent = n ? String(n) : "";
      }
      if (!State.mode || State.mode !== "expanded") closeMenu();

      const mode = Mode.current();
      const until = nextBoundary(Mode.hours);
      modeChip.textContent = ACCENT[mode].label;
      modeChip.className = `mode-chip ${mode}${Mode.manual ? " manual" : ""}`;
      const hm = `${until.getHours()}h${String(until.getMinutes()).padStart(2, "0")}`;
      modeChip.title = `Mode ${mode}${Mode.manual ? " (choisi à la main)" : ""} jusqu'à ${hm} — clic pour passer en ${mode === "pro" ? "perso" : "pro"}`;

      const sk = String(State.settings.soundEnabled);
      if (sk !== soundKey) {
        soundKey = sk;
        clear(soundBtn);
        soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
      }
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };
}

/** Which briefs were seen on this device ("new" dot on the Briefs tab). */
export const Briefs = {
  seen: {} as Record<string, string>,
  hasNew(): boolean {
    for (const b of Tasks.briefs.values()) if ((b.updatedAt ?? "") > (this.seen[b.slot] ?? "")) return true;
    return false;
  },
  markSeen(slot: string) {
    const b = Tasks.briefs.get(slot as never);
    if (!b?.updatedAt || this.seen[slot] === b.updatedAt) return;
    this.seen = { ...this.seen, [slot]: b.updatedAt };
    void Bridge.localSet("briefsSeen", this.seen);
  },
};

// ── Overview ──────────────────────────────────────────────────────────────────

function buildOverview(actions: ViewActions): ViewHost {
  const date = h("span", { class: "ov-date" });
  const count = h("span", { class: "ov-count" });
  const mailChip = h("button", { class: "chip-btn mail", onclick: (e: Event) => { e.stopPropagation(); actions.setView("mail"); } });
  const bar = progressBar();
  const list = h("ul", { class: "ov-list" });
  const sac = h("div", { class: "ov-sac" });
  const briefLine = h("button", { class: "ov-brief", onclick: (e: Event) => { e.stopPropagation(); actions.setView("brief"); } });

  const main = h("div", { class: "ov-main" },
    h("div", { class: "ov-head" }, date, count, h("span", { class: "grow" }), mailChip),
    bar.el,
    list,
    sac,
    briefLine,
  );

  const focusLabel = h("span", { class: "fx-label", text: "Concentration" });
  const f25 = btn("25 min", "secondary", () => actions.startFocus(25));
  const f50 = btn("50", "ghost", () => actions.startFocus(50));
  const focusRow = h("div", { class: "fx-row" }, f25, f50);
  const focusStop = btn("Arrêter", "ghost", () => actions.stopFocus());
  const focusBox = h("div", { class: "fx-box" }, focusLabel, focusRow, focusStop);
  const maisonBtn = btn("Ouvrir la maison", "ghost", () => {
    const url = maisonUrl();
    if (url) actions.openUrl(url);
  }, ICONS.arrowUpRight);
  const side = h("div", { class: "ov-actions" },
    focusBox,
    btn("Ma journée", "secondary", () => actions.setView("tasks"), ICONS.list),
    btn("Chat", "secondary", () => actions.setView("prompt"), ICONS.bubble),
    maisonBtn,
  );
  const el = h("div", { class: "view overview" }, card("soft", "ov-card", main, side));

  let key = "";
  let sacShown = false;
  let height = 222;
  DynamicHeights.overview = () => height;
  return {
    el,
    sync() {
      const today = dayKey();
      const mode = Mode.current();
      const { open, doneToday } = Tasks.lists(today, mode);
      const total = open.length + doneToday.length;
      const sacItems = sacTime() ? Tasks.sacFor() : [];
      const brief = Tasks.newestBrief();
      const unread = Tasks.unreadMails().length;
      const focusMin = Focus.active ? Focus.remainingMin() : 0;
      const k = JSON.stringify([today, mode, open.slice(0, 3).map((t) => [t.id, t.title, t.time, t.day, t.origDay, t.done]), open.length, doneToday.length,
        sacItems.map((t) => [t.id, t.done]), brief?.file, brief?.updatedAt, unread, Tasks.ready, maisonUrl(), focusMin]);
      if (k === key) return;
      key = k;
      maisonBtn.style.display = maisonUrl() ? "" : "none";
      date.textContent = todayLabel();
      count.textContent = countText(doneToday.length, total);
      bar.set(doneToday.length, total);
      clear(mailChip);
      mailChip.append(svg(ICONS.mail, 11), h("span", { text: `${unread} non lu${unread > 1 ? "s" : ""}` }));
      mailChip.style.display = unread ? "" : "none";
      clear(list);
      if (!Tasks.ready) {
        list.append(h("li", { class: "empty", text: "Je regarde ta journée…" }));
      } else if (!open.length) {
        list.append(h("li", {
          class: "empty",
          text: total ? "Tout est fait pour aujourd'hui. Bravo !" : `Rien de prévu côté ${mode}. Ajoute une tâche dans « Ma journée ».`,
        }));
      } else {
        for (const t of open.slice(0, 3)) {
          list.append(taskRow(t, { kind: "open", today, withActions: false, armed: false, onToggle: (x) => checkTask(actions, x) }));
        }
        const rest = open.length - 3;
        if (rest > 0) list.append(h("li", { class: "more-li" }, linkBtn(`+ ${rest} autre${rest > 1 ? "s" : ""}`, () => actions.setView("tasks"))));
      }
      clear(sac);
      const wasSac = sacShown;
      sacShown = sacItems.length > 0;
      if (sacShown) sac.append(sacChips(actions, sacItems));
      clear(briefLine);
      if (brief) {
        const label = SLOTS.find((s) => s.slot === brief.slot)?.label ?? "Brief";
        briefLine.append(svg(ICONS.sun, 11), h("b", { text: label }), h("span", { text: firstLine(brief) }));
      }
      briefLine.style.display = brief ? "" : "none";
      const focusing = Focus.active;
      focusLabel.textContent = focusing ? `Concentration · ${focusMin} min` : "Concentration";
      focusRow.style.display = focusing ? "none" : "";
      focusStop.style.display = focusing ? "" : "none";
      // The island grows with what there is to show (header 42 + card padding 22 + margins 12).
      const prev = height;
      height = Math.max(200, Math.min(300, Math.max(contentHeight(main, 6), contentHeight(side, 6)) + 42 + 22 + 12));
      if (wasSac !== sacShown || prev !== height) actions.heightChanged();
    },
  };
}

// ── Ma journée ────────────────────────────────────────────────────────────────

type RepeatChoice = "none" | "daily" | "workdays" | "weekly" | "monthly";

function buildTasks(actions: ViewActions): ViewHost {
  const count = h("span", { class: "tk-count" });
  const filterBtn = h("button", { class: "filter-btn", onclick: (e: Event) => { e.stopPropagation(); Mode.showAll = !Mode.showAll; actions.blip(); rebuild(); } });
  const bar = progressBar();
  const fb = feedbackLine();
  let tiroirChoice: "pro" | "perso" | null = null;
  const tiroirBtn = h("button", {
    type: "button",
    class: "tiroir",
    title: "Pro ou perso",
    onclick: (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const cur = tiroirChoice ?? Mode.current();
      tiroirChoice = cur === "pro" ? "perso" : "pro";
      paintTiroir();
    },
  });
  const paintTiroir = () => {
    const t = tiroirChoice ?? Mode.current();
    tiroirBtn.textContent = ACCENT[t].label;
    tiroirBtn.className = `tiroir ${t}`;
  };

  // Repeat panel.
  let repeat: RepeatChoice = "none";
  let sac = false;
  const repBtn = h("button", { type: "button", class: "rep-btn", title: "Répéter" }, svg(ICONS.repeat, 12));
  const repSel = h("select", { class: "rep-sel" }) as HTMLSelectElement;
  for (const [v, l] of [["none", "Une fois"], ["daily", "Tous les jours"], ["workdays", "Jours ouvrés"], ["weekly", "Chaque…"], ["monthly", "Chaque mois le…"]]) {
    repSel.append(h("option", { value: v, text: l }));
  }
  const daySel = h("select", { class: "rep-sel" }) as HTMLSelectElement;
  for (let d = 1; d <= 7; d++) daySel.append(h("option", { value: String(d), text: JOURS[d % 7] }));
  daySel.value = String(new Date().getDay() || 7);
  const monthSel = h("select", { class: "rep-sel" }) as HTMLSelectElement;
  for (let d = 1; d <= 31; d++) monthSel.append(h("option", { value: String(d), text: String(d) }));
  monthSel.value = String(new Date().getDate());
  const sacBtn = h("button", { type: "button", class: "sac-toggle", title: "À préparer la veille au soir" }, svg(ICONS.bag, 11), h("span", { text: "Sac de demain" }));
  const repPanel = h("div", { class: "rep-panel" }, h("span", { class: "rep-label", text: "Répéter" }), repSel, daySel, monthSel, sacBtn);
  const paintRepeat = () => {
    daySel.style.display = repeat === "weekly" ? "" : "none";
    monthSel.style.display = repeat === "monthly" ? "" : "none";
    sacBtn.classList.toggle("on", sac);
    repBtn.classList.toggle("on", repeat !== "none" || sac);
  };
  let repOpen = false;
  repBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    repOpen = !repOpen;
    repPanel.classList.toggle("open", repOpen);
  });
  for (const s of [repSel, daySel, monthSel]) {
    s.addEventListener("pointerdown", (e) => { e.stopPropagation(); actions.wantKeyboard(true); });
    s.addEventListener("change", () => {
      repeat = repSel.value as RepeatChoice;
      paintRepeat();
    });
  }
  sacBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    sac = !sac;
    paintRepeat();
  });
  const chosenRule = (): Rule | null => {
    switch (repeat) {
      case "daily": return { freq: "daily" };
      case "workdays": return { freq: "daily", workdaysOnly: true };
      case "weekly": return { freq: "weekly", days: [Number(daySel.value)] };
      case "monthly": return { freq: "monthly", monthDay: Number(monthSel.value) };
      default: return null;
    }
  };

  const input = textField(actions, "Ajouter… (ex. relancer le client demain 14h, courses : lait)", (v) => void submit(v));
  const addBtn = h("button", { class: "send-btn", title: "Ajouter", type: "button" }, svg(ICONS.plus, 11));
  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const v = input.value.trim();
    if (v) {
      input.value = "";
      void submit(v);
    }
  });
  const form = h("div", { class: "tk-add" }, input, tiroirBtn, repBtn, addBtn);
  const banner = h("div", { class: "tk-banner", text: "Journée bouclée !" });
  const openList = h("ul", { class: "tk-list" });
  const sacBox = h("div", { class: "tk-sac" });
  const doneToggle = h("button", { class: "fold" });
  const doneList = h("ul", { class: "tk-list sub" });
  const laterToggle = h("button", { class: "fold" });
  const laterList = h("ul", { class: "tk-list sub" });
  const routToggle = h("button", { class: "fold" });
  const routList = h("ul", { class: "tk-list sub" });
  const folds = h("div", { class: "folds" }, doneToggle, laterToggle, routToggle);
  const scroll = h("div", { class: "tk-scroll" }, banner, openList, sacBox, folds, doneList, laterList, routList);
  const error = h("div", { class: "tk-error" });
  const syncBadge = h("div", { class: "sync-badge" });

  const lc = listCard("tasks", [h("b", { text: "Ma journée" }), count, filterBtn, h("span", { class: "grow" }), fb.el], bar.el, form, repPanel, scroll, error);
  lc.side.append(syncBadge);

  let showDone = false;
  let showLater = false;
  let showRout = false;
  let armed: string | null = null;
  let armTimer: number | null = null;
  let key = "";

  function rebuild() {
    key = "";
    State.notify();
  }

  /** An opened fold scrolls into view. */
  const reveal = (list: HTMLElement) => requestAnimationFrame(() => {
    if (list.style.display === "none") return;
    scroll.scrollTop = Math.max(0, folds.offsetTop - 4);
  });
  doneToggle.addEventListener("click", (e) => { e.stopPropagation(); showDone = !showDone; rebuild(); reveal(doneList); });
  laterToggle.addEventListener("click", (e) => { e.stopPropagation(); showLater = !showLater; rebuild(); reveal(laterList); });
  routToggle.addEventListener("click", (e) => { e.stopPropagation(); showRout = !showRout; rebuild(); reveal(routList); });

  const arm = (id: string, run: () => void) => {
    if (armed === id) {
      armed = null;
      run();
      actions.blip();
    } else {
      armed = id;
      if (armTimer != null) window.clearTimeout(armTimer);
      armTimer = window.setTimeout(() => { armed = null; rebuild(); }, 3000);
    }
    rebuild();
  };

  async function submit(v: string) {
    const rule = chosenRule();
    const r = await Tasks.capture(v, { tiroir: tiroirChoice ?? Mode.current(), repeat: rule, sac: sac || undefined });
    if (!r) return;
    actions.emote("wink");
    if (r.capture.kind === "task" && !r.capture.repeat) {
      const c = r.capture;
      fb.say(`Noté pour ${dayName(c.day)}${c.time ? ` à ${timeLabel(c.time)}` : ""}.`, r);
    } else {
      fb.say(`${r.summary}.`, r);
    }
    repeat = "none";
    sac = false;
    repSel.value = "none";
    repOpen = false;
    repPanel.classList.remove("open");
    paintRepeat();
  }

  paintTiroir();
  paintRepeat();

  return {
    el: lc.el,
    sync() {
      const today = dayKey();
      const mode = Mode.current();
      const filter = Mode.showAll ? null : mode;
      const { open, doneToday, later } = Tasks.lists(today, filter);
      const total = open.length + doneToday.length;
      const routines = Tasks.routines();
      const sacItems = sacTime() ? Tasks.sacFor() : [];
      const info = Tasks.info;
      const k = JSON.stringify([
        today, mode, Mode.showAll, showDone, showLater, showRout, armed, Tasks.ready, Tasks.error, info?.mode, tiroirChoice,
        open.map((t) => [t.id, t.title, t.time, t.day, t.origDay, t.tiroir]),
        doneToday.map((t) => t.id), later.map((t) => [t.id, t.title, t.day, t.time]),
        routines.map((r) => [r.key, r.title, r.kind, r.active]), sacItems.map((t) => [t.id, t.done]),
      ]);
      if (k === key) return;
      key = k;

      if (!tiroirChoice) paintTiroir();
      count.textContent = countText(doneToday.length, total);
      filterBtn.textContent = Mode.showAll ? "tout" : mode;
      filterBtn.className = `filter-btn ${Mode.showAll ? "all" : mode}`;
      filterBtn.title = Mode.showAll ? `Ne voir que le ${mode}` : "Tout voir (pro et perso)";
      bar.set(doneToday.length, total);
      banner.style.display = total > 0 && open.length === 0 ? "" : "none";

      const rowOpts = (kind: RowOpts["kind"], t: Task): RowOpts => ({
        kind, today, withActions: true, armed: armed === t.id,
        onToggle: (x) => checkTask(actions, x),
        onTomorrow: (x) => { void Tasks.tomorrow(x.id); actions.blip(); fb.say("Je te la remets demain."); },
        onRemove: (x) => arm(x.id, () => void Tasks.remove(x.id)),
      });

      clear(openList);
      if (!Tasks.ready) openList.append(h("li", { class: "empty", text: "Je lis le dossier de synchronisation…" }));
      else if (!open.length && !total) {
        openList.append(h("li", { class: "empty", text: `Rien côté ${filter ?? "pro ni perso"} aujourd'hui. « demain », « lundi », « 14h » ou « chaque mardi » sont compris.` }));
      }
      for (const t of open) openList.append(taskRow(t, rowOpts("open", t)));

      clear(sacBox);
      if (sacItems.length) sacBox.append(sacChips(actions, sacItems));

      folds.style.display = doneToday.length || later.length || routines.length ? "" : "none";
      doneToggle.style.display = doneToday.length ? "" : "none";
      doneToggle.textContent = `${showDone ? "▾" : "▸"} faites aujourd'hui (${doneToday.length})`;
      clear(doneList);
      doneList.style.display = showDone ? "" : "none";
      if (showDone) for (const t of doneToday) doneList.append(taskRow(t, rowOpts("done", t)));

      laterToggle.style.display = later.length ? "" : "none";
      laterToggle.textContent = `${showLater ? "▾" : "▸"} plus tard (${later.length})`;
      clear(laterList);
      laterList.style.display = showLater ? "" : "none";
      if (showLater) for (const t of later) laterList.append(taskRow(t, rowOpts("later", t)));

      routToggle.style.display = routines.length ? "" : "none";
      routToggle.textContent = `${showRout ? "▾" : "▸"} routines (${routines.length})`;
      clear(routList);
      routList.style.display = showRout ? "" : "none";
      if (showRout) {
        for (const r of routines) {
          const id = `routine:${r.key}`;
          routList.append(h("li", { class: `task routine${armed === id ? " armed" : ""}` },
            h("span", { class: "rep-ico" }, svg(r.kind === "sac" ? ICONS.bag : ICONS.repeat, 10)),
            h("span", { class: "tt", text: r.title, title: r.title }),
            h("span", { class: "tags" },
              h("span", { class: "tag", text: ruleLabel(r.rule) }),
              r.time ? h("span", { class: "tag time", text: timeLabel(r.time) }) : null,
              r.kind === "sac" ? h("span", { class: "tag", text: "sac" }) : null,
              h("span", { class: `tag ${r.tiroir}`, text: r.tiroir })),
            h("span", { class: "ta" }, linkBtn(armed === id ? "Arrêter ?" : "Arrêter", () => arm(id, () => void Tasks.removeRoutine(r.key)), armed === id ? "warn" : "")),
          ));
        }
      }

      error.textContent = Tasks.error ?? "";
      error.style.display = Tasks.error ? "" : "none";

      clear(syncBadge);
      if (info) {
        const label = info.mode === "drive" ? "Drive" : info.mode === "custom" ? "Dossier" : "Local";
        syncBadge.append(svg(info.mode === "local" ? ICONS.doc : ICONS.cloud, 11), h("span", { text: label }));
        syncBadge.title = info.mode === "local"
          ? "Google Drive introuvable : tes tâches restent sur cet appareil."
          : info.dir;
        syncBadge.classList.toggle("local", info.mode === "local");
      }
    },
    focus() {
      // Nothing: the keyboard is only taken when the field is clicked.
    },
  };
}

// ── Reminder ──────────────────────────────────────────────────────────────────

export const Reminder = { task: null as Task | null };

function buildReminder(actions: ViewActions): ViewHost {
  const label = h("div", { class: "rm-label" });
  const title = h("div", { class: "title rm-title" });
  const snooze = btn("Dans 30 min", "secondary", () => actions.reminderSnooze());
  const row = h("div", { class: "actions" },
    btn("Fait", "primary", () => actions.reminderDone(), ICONS.check),
    snooze,
    btn("Plus tard", "ghost", () => actions.reminderLater()),
  );
  const el = h("div", { class: "view" }, card("amber", "", h("div", { class: "stack rm" }, label, title, row)));
  return {
    el,
    sync() {
      const t = Reminder.task;
      label.textContent = t?.time ? `Rappel · ${timeLabel(t.time)}${t.routine ? " · routine" : ""}` : "Rappel";
      title.textContent = t?.title ?? "";
      snooze.style.display = t?.routine ? "none" : "";
    },
  };
}

// ── Morning ───────────────────────────────────────────────────────────────────

function buildMorning(actions: ViewActions): ViewHost {
  const helloEl = h("div", { class: "title mo-title" });
  const line = h("div", { class: "sub" });
  const list = h("ul", { class: "ov-list mo-list" });
  const briefBtn = btn("Le brief", "secondary", () => actions.setView("brief"), ICONS.sun);
  const side = h("div", { class: "ov-actions" },
    btn("Voir mes tâches", "primary", () => actions.setView("tasks"), ICONS.list),
    briefBtn,
    btn("OK", "ghost", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("soft", "ov-card", h("div", { class: "ov-main mo" }, helloEl, line, list), side));
  let key = "";
  return {
    el,
    sync() {
      const s = morningSummary();
      const k = JSON.stringify([s.line, s.first.map((t) => t.id), Tasks.briefs.size, Tasks.unreadMails().length, hello()]);
      if (k === key) return;
      key = k;
      helloEl.textContent = hello();
      line.textContent = s.line;
      clear(list);
      const today = dayKey();
      for (const t of s.first) list.append(taskRow(t, { kind: "open", today, withActions: false, armed: false, onToggle: (x) => checkTask(actions, x) }));
      briefBtn.style.display = Tasks.briefs.size || Tasks.unreadMails().length ? "" : "none";
    },
  };
}

// ── Note / confused ───────────────────────────────────────────────────────────

function buildNote(actions: ViewActions): ViewHost {
  const title = h("div", { class: "title note-text" });
  const row = h("div", { class: "actions" }, btn("OK", "secondary", () => actions.setView(State.defaultView())));
  const el = h("div", { class: "view" }, card("soft", "", h("div", { class: "stack note" }, title, row)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack note" },
    h("div", { class: "title", text: "Ouh là… tout tourne." }),
    h("div", { class: "sub", text: "Laisse-moi deux secondes." }),
  );
  return { el: h("div", { class: "view" }, card("pink", "", body)), sync() {} };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("tasks", buildTasks(actions));
  map.set("prompt", buildPrompt(actions, onChatHeightChange));
  map.set("reminder", buildReminder(actions));
  map.set("morning", buildMorning(actions));
  map.set("brief", buildBriefs(actions));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  map.set("note", buildNote(actions));
  map.set("confused", buildConfused());
  map.set("welcome", buildWelcome(actions));
  map.set("update", buildUpdate(actions));
  map.set("shopping", buildShopping(actions));
  map.set("subs", buildSubs(actions));
  map.set("agenda", buildAgenda(actions));
  map.set("watch", buildWatch(actions));
  map.set("mail", buildMail(actions));
  map.set("recap", buildRecap(actions));
  map.set("pause", buildPause(actions));
  map.set("notice", buildNotice(actions));
  return map;
}

