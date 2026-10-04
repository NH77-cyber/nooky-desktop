// The "Plus" views: Courses, Abonnements, Agenda, À suivre, Courrier.
// Nooky Desktop — original code (layout shared with Ma journée).

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { State } from "../core/state";
import { Tasks } from "../tasks/store";
import { dayKey, dayName, parseTask, timeLabel } from "../tasks/parse";
import {
  EVENT_KIND_LABEL, WATCH_KIND_LABEL, daysUntil, effectiveRenewal, euros, eventKind, monthlyTotal,
  parseWatch, shortDate, upcoming, whenLabel,
} from "../tasks/records";
import { feedbackLine, linkBtn, listCard, textField, type ViewActions, type ViewHost } from "./views";

/** "Retirer" that asks once ("Retirer ?") before it acts. */
function armedRemover(rebuild: () => void) {
  let armed: string | null = null;
  let timer: number | null = null;
  return {
    is: (id: string) => armed === id,
    button(id: string, run: () => void, label = "Retirer") {
      const on = armed === id;
      return linkBtn(on ? `${label} ?` : label, () => {
        if (armed === id) {
          armed = null;
          run();
        } else {
          armed = id;
          if (timer != null) window.clearTimeout(timer);
          timer = window.setTimeout(() => { armed = null; rebuild(); }, 3000);
        }
        rebuild();
      }, on ? "warn" : "");
    },
  };
}

function addRow(input: HTMLInputElement, onAdd: () => void): HTMLElement {
  const add = h("button", { class: "send-btn", title: "Ajouter", type: "button" }, svg(ICONS.plus, 11));
  add.addEventListener("click", (e) => { e.stopPropagation(); onAdd(); });
  return h("div", { class: "tk-add" }, input, add);
}

// ── Courses ───────────────────────────────────────────────────────────────────

export function buildShopping(actions: ViewActions): ViewHost {
  const count = h("span", { class: "tk-count" });
  const fb = feedbackLine();
  const list = h("ul", { class: "tk-list shop" });
  const clearBtn = linkBtn("", () => { void Tasks.clearShoppingDone(); actions.blip(); });
  const submit = async (v: string) => {
    const r = await Tasks.capture(/^\+?\s*courses?\b/i.test(v) ? v : `courses : ${v}`);
    if (r) {
      actions.emote("wink");
      fb.say(`${r.summary}.`, r);
    }
  };
  const input = textField(actions, "Ajouter… (lait, pain et beurre)", (v) => void submit(v));
  const lc = listCard("shopping", [h("b", { text: "Courses" }), count, h("span", { class: "grow" }), fb.el],
    addRow(input, () => { const v = input.value.trim(); if (v) { input.value = ""; void submit(v); } }),
    h("div", { class: "tk-scroll" }, list),
    h("div", { class: "foot" }, clearBtn),
  );
  let key = "";
  return {
    el: lc.el,
    sync() {
      const items = Tasks.shopping();
      const k = JSON.stringify(items.map((s) => [s.key, s.label, s.done]));
      if (k === key) return;
      key = k;
      const left = items.filter((s) => !s.done).length;
      const done = items.length - left;
      count.textContent = items.length ? `${left} à acheter` : "";
      clear(list);
      if (!items.length) list.append(h("li", { class: "empty", text: "La liste est vide. Tape « lait, pain » ici, ou « courses : … » partout ailleurs." }));
      for (const s of items) {
        list.append(h("li", { class: `task${s.done ? " done" : ""}` },
          h("button", {
            class: `chk${s.done ? " on" : ""}`,
            title: s.done ? "Remettre dans la liste" : "Dans le panier",
            onclick: (e: Event) => { e.stopPropagation(); void Tasks.toggleShopping(s.key); actions.blip(); },
          }, s.done ? svg(ICONS.check, 9, { stroke: 3.2 }) : null),
          h("span", { class: "tt", text: s.label, title: s.label }),
        ));
      }
      clearBtn.textContent = done ? `Vider les cochés (${done})` : "";
      clearBtn.style.display = done ? "" : "none";
    },
  };
}

// ── Abonnements ───────────────────────────────────────────────────────────────

export function buildSubs(actions: ViewActions): ViewHost {
  const total = h("span", { class: "tk-count" });
  const fb = feedbackLine();
  const list = h("ul", { class: "tk-list subs" });
  let key = "";
  const rm = armedRemover(() => { key = ""; State.notify(); });
  const submit = async (v: string) => {
    const r = await Tasks.capture(/^\+?\s*abo/i.test(v) ? v : `abo ${v}`);
    if (r?.capture.kind === "sub") {
      actions.emote("wink");
      fb.say(`${r.summary}.`, r);
    } else {
      if (r) void Tasks.undo(r);
      fb.say("Écris le nom, le prix et le jour : « Netflix 13,49 le 12 ».");
    }
  };
  const input = textField(actions, "Netflix 13,49 le 12 · par an · essai jusqu'au 20/11", (v) => void submit(v));
  const lc = listCard("subs", [h("b", { text: "Abonnements" }), total, h("span", { class: "grow" }), fb.el],
    addRow(input, () => { const v = input.value.trim(); if (v) { input.value = ""; void submit(v); } }),
    h("div", { class: "tk-scroll" }, list),
  );
  return {
    el: lc.el,
    sync() {
      const today = dayKey();
      const subs = Tasks.subs().map((s) => ({ s, next: effectiveRenewal(s, today) })).sort((a, b) => a.next.localeCompare(b.next));
      const k = JSON.stringify([today, subs.map(({ s, next }) => [s.key, s.name, s.price, s.cycle, next, s.trialEnd, rm.is(s.key)])]);
      if (k === key) return;
      key = k;
      total.textContent = subs.length ? `≈ ${euros(monthlyTotal(subs.map((x) => x.s)))} par mois` : "";
      clear(list);
      if (!subs.length) list.append(h("li", { class: "empty", text: "Aucun abonnement. Ajoute-les ici ou tape « abo Netflix 13,49 le 12 » dans le chat." }));
      for (const { s, next } of subs) {
        const d = daysUntil(next, today);
        const tags = h("span", { class: "tags" },
          s.category !== "autre" ? h("span", { class: "tag", text: s.category }) : null,
          h("span", { class: `tag${d <= 3 ? " soon" : ""}`, text: `renouv. ${whenLabel(next, today)}` }),
        );
        if (s.trialEnd && s.trialEnd >= today) {
          const dt = daysUntil(s.trialEnd, today);
          tags.append(h("span", { class: `tag${dt <= 3 ? " soon" : " trial"}`, text: `essai → ${shortDate(s.trialEnd)}` }));
        }
        list.append(h("li", { class: `task sub-row${rm.is(s.key) ? " armed" : ""}` },
          h("span", { class: "tt", text: s.name, title: s.name }),
          tags,
          h("span", { class: "price", text: `${euros(s.price)}${s.cycle === "yearly" ? " /an" : ""}` }),
          h("span", { class: "ta" }, rm.button(s.key, () => void Tasks.removeSub(s.key))),
        ));
      }
    },
  };
}

// ── Agenda ────────────────────────────────────────────────────────────────────

export function buildAgenda(actions: ViewActions): ViewHost {
  const sub = h("span", { class: "tk-count", text: "14 prochains jours" });
  const fb = feedbackLine();
  const list = h("div", { class: "ag-list" });
  let key = "";
  const rm = armedRemover(() => { key = ""; State.notify(); });
  const submit = async (v: string) => {
    const p = parseTask(v);
    if (!p.title) return;
    const kind = eventKind(p.title);
    const k = await Tasks.addEvent({ title: p.title, date: p.day, time: p.time, kind, remindDaysBefore: kind === "anniv" ? 3 : 1 });
    actions.emote("wink");
    fb.say(`Noté ${dayName(p.day)}${p.time ? ` à ${timeLabel(p.time)}` : ""}.`, { capture: { kind: "shopping", items: [] }, summary: "", targets: [{ coll: "events", key: k }] });
  };
  const input = textField(actions, "Anniversaire de Léa le 12/11 · dentiste mardi 17h", (v) => void submit(v));
  const lc = listCard("agenda", [h("b", { text: "Agenda" }), sub, h("span", { class: "grow" }), fb.el],
    addRow(input, () => { const v = input.value.trim(); if (v) { input.value = ""; void submit(v); } }),
    h("div", { class: "tk-scroll" }, list),
  );
  return {
    el: lc.el,
    sync() {
      const today = dayKey();
      const evs = upcoming(Tasks.events(), today, 14);
      const k = JSON.stringify([today, evs.map((e) => [e.key, e.title, e.date, e.time, e.location, rm.is(e.key)])]);
      if (k === key) return;
      key = k;
      clear(list);
      if (!evs.length) {
        list.append(h("div", { class: "empty", text: "Rien dans les 14 prochains jours. La maison peut aussi en ajouter (école, anniversaires…)." }));
        return;
      }
      let day = "";
      let ul: HTMLElement | null = null;
      for (const e of evs) {
        if (e.date !== day) {
          day = e.date;
          const d = new Date(`${e.date}T12:00:00`);
          const raw = d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
          const long = raw.charAt(0).toUpperCase() + raw.slice(1);
          const rel = dayName(e.date, today);
          const near = rel === "aujourd'hui" || rel === "demain";
          list.append(h("div", { class: "ag-day" }, h("b", { text: near ? rel.charAt(0).toUpperCase() + rel.slice(1) : long }),
            near ? h("span", { text: raw }) : null));
          ul = h("ul", { class: "tk-list" });
          list.append(ul);
        }
        ul!.append(h("li", { class: `task${rm.is(e.key) ? " armed" : ""}` },
          h("span", { class: "ag-time", text: e.time ? timeLabel(e.time) : "" }),
          h("span", { class: "tt", text: e.location ? `${e.title} · ${e.location}` : e.title, title: e.title }),
          h("span", { class: "tags" }, EVENT_KIND_LABEL[e.kind] ? h("span", { class: `tag ev-${e.kind}`, text: EVENT_KIND_LABEL[e.kind] }) : null),
          h("span", { class: "ta" }, rm.button(e.key, () => void Tasks.removeEvent(e.key))),
        ));
      }
    },
  };
}

// ── À suivre ──────────────────────────────────────────────────────────────────

export function buildWatch(actions: ViewActions): ViewHost {
  const count = h("span", { class: "tk-count" });
  const fb = feedbackLine();
  const list = h("ul", { class: "tk-list" });
  let key = "";
  const rm = armedRemover(() => { key = ""; State.notify(); });
  const submit = async (v: string) => {
    const p = parseWatch(v, [...Tasks.prefs.platforms, ...Tasks.prefs.streaming]);
    if (!p) return;
    const k = await Tasks.addWatch(p);
    actions.emote("wink");
    fb.say(`${p.title} : ${WATCH_KIND_LABEL[p.kind]}${p.platform ? `, ${p.platform}` : ""}.`, { capture: { kind: "shopping", items: [] }, summary: "", targets: [{ coll: "watch", key: k }] });
  };
  const input = textField(actions, "The Bear série Disney+ · Zelda jeu Switch · Dune film", (v) => void submit(v));
  const lc = listCard("watch", [h("b", { text: "À suivre" }), count, h("span", { class: "grow" }), fb.el],
    addRow(input, () => { const v = input.value.trim(); if (v) { input.value = ""; void submit(v); } }),
    h("div", { class: "tk-scroll" }, list),
  );
  return {
    el: lc.el,
    sync() {
      const items = Tasks.watch();
      const k = JSON.stringify(items.map((w) => [w.key, w.title, w.kind, w.platform, rm.is(w.key)]));
      if (k === key) return;
      key = k;
      count.textContent = items.length ? `${items.length}` : "";
      clear(list);
      if (!items.length) list.append(h("li", { class: "empty", text: "Tes envies de jeux, séries et films. Le brief loisirs du jeudi s'en sert pour les promos et les sorties." }));
      for (const w of items) {
        list.append(h("li", { class: `task${rm.is(w.key) ? " armed" : ""}` },
          h("span", { class: "rep-ico" }, svg(ICONS.bookmark, 10)),
          h("span", { class: "tt", text: w.title, title: w.note || w.title }),
          h("span", { class: "tags" },
            h("span", { class: `tag wk-${w.kind}`, text: WATCH_KIND_LABEL[w.kind] }),
            w.platform ? h("span", { class: "tag", text: w.platform }) : null),
          h("span", { class: "ta" }, rm.button(w.key, () => void Tasks.removeWatch(w.key))),
        ));
      }
    },
  };
}

// ── Courrier ──────────────────────────────────────────────────────────────────

export function buildMail(actions: ViewActions): ViewHost {
  const count = h("span", { class: "tk-count" });
  const allRead = linkBtn("Tout marquer lu", () => { void Tasks.markRead(Tasks.unreadMails().map((m) => m.id)); actions.blip(); });
  const list = h("ul", { class: "mail-list" });
  let open: string | null = null;
  let key = "";
  const lc = listCard("mail", [h("b", { text: "Courrier" }), count, h("span", { class: "grow" }), allRead],
    h("div", { class: "tk-scroll" }, list),
  );
  return {
    el: lc.el,
    sync() {
      const mails = Tasks.mails;
      const k = JSON.stringify([open, mails.map((m) => [m.id, m.title, Tasks.isRead(m)])]);
      if (k === key) return;
      key = k;
      const unread = Tasks.unreadMails().length;
      count.textContent = unread ? `${unread} non lu${unread > 1 ? "s" : ""}` : mails.length ? "tout est lu" : "";
      allRead.style.display = unread ? "" : "none";
      clear(list);
      if (!mails.length) list.append(h("li", { class: "empty", text: "Pas de courrier ces 30 derniers jours. Les messages de la maison et des tâches planifiées arrivent ici." }));
      for (const m of mails) {
        const read = Tasks.isRead(m);
        const when = m.at ? new Date(m.at) : null;
        const whenText = when && !Number.isNaN(when.getTime())
          ? (dayKey(when) === dayKey() ? `${when.getHours()}h${String(when.getMinutes()).padStart(2, "0")}` : when.toLocaleDateString("fr-FR", { day: "numeric", month: "short" }))
          : "";
        const li = h("li", { class: `mail-row${read ? " read" : ""}${m.important ? " important" : ""}${open === m.id ? " open" : ""}` },
          h("div", { class: "mr-line" },
            h("i", { class: "mr-dot" }),
            h("span", { class: "mr-from", text: m.from || "Maison" }),
            h("span", { class: "mr-title", text: m.title, title: m.title }),
            h("span", { class: "mr-when", text: whenText })),
          open === m.id && m.body ? h("div", { class: "mr-body", text: m.body }) : null,
        );
        li.addEventListener("click", (e) => {
          e.stopPropagation();
          open = open === m.id ? null : m.id;
          if (!read) void Tasks.markRead([m.id]);
          key = "";
          State.notify();
        });
        list.append(li);
      }
    },
  };
}
