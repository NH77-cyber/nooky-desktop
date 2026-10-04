// The welcome card (first launch: prénom + lien de la maison), the update
// card, the evening recap, the end-of-focus "Pause !" card and the notice card
// (subscriptions, trials, agenda). Nooky Desktop — original code.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { State } from "../core/state";
import { Updates } from "../core/updates";
import { timeLabel } from "../tasks/parse";
import { recapSummary } from "../tasks/reminders";
import { firstLine } from "../tasks/briefs";
import { btn, card, type ViewActions, type ViewHost } from "./views";

export function buildWelcome(actions: ViewActions): ViewHost {
  const name = h("input", {
    type: "text", class: "field", placeholder: "Ton prénom", maxlength: "40", spellcheck: "false",
  }) as HTMLInputElement;
  const link = h("input", {
    type: "text", class: "field", placeholder: "Lien de la maison (facultatif)", spellcheck: "false",
  }) as HTMLInputElement;
  const err = h("div", { class: "wc-err" });
  const submit = () => {
    const url = link.value.trim();
    if (url && !/^https?:\/\/\S+$/i.test(url)) {
      err.textContent = "Le lien doit commencer par https://";
      return;
    }
    err.textContent = "";
    actions.saveWelcome(name.value.trim(), url);
  };
  for (const input of [name, link]) {
    input.addEventListener("pointerdown", () => actions.wantKeyboard(true));
    input.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") submit();
      e.stopPropagation();
    });
  }
  const body = h(
    "div",
    { class: "stack wc" },
    h("div", { class: "title", text: "Bienvenue ! Moi, c'est Nooky." }),
    h("div", { class: "sub", text: "Comment tu t'appelles ? Tout ça se change ensuite dans les Réglages." }),
    h("div", { class: "wc-row" }, name, link),
    err,
    h("div", { class: "actions" },
      btn("C'est parti", "primary", submit, ICONS.check),
      btn("Plus tard", "ghost", () => actions.dismissWelcome()),
    ),
  );
  return {
    el: h("div", { class: "view" }, card("violet", "", body)),
    sync() {
      if (document.activeElement !== name && !name.value) name.value = State.settings.firstName ?? "";
      if (document.activeElement !== link && !link.value) link.value = State.settings.maisonUrl ?? "";
    },
  };
}

export function buildUpdate(actions: ViewActions): ViewHost {
  const title = h("div", { class: "title" });
  const sub = h("div", { class: "sub" });
  const installBtn = btn("Installer et relancer", "primary", () => actions.installUpdate(), ICONS.arrowUp);
  const laterBtn = btn("Plus tard", "ghost", () => actions.dismissUpdate());
  const row = h("div", { class: "actions" }, installBtn, laterBtn);
  const bar = h("div", { class: "pbar up-bar" }, h("i"));
  const body = h("div", { class: "stack" }, title, sub, bar, row);
  return {
    el: h("div", { class: "view" }, card("violet", "", body)),
    sync() {
      const u = Updates.pending;
      title.textContent = u ? `Nouvelle version de Nooky (${u.version})` : "Nooky est à jour";
      const installing = Updates.status === "installing";
      if (installing) {
        sub.textContent = Updates.progress == null
          ? "Je télécharge la mise à jour…"
          : `Je télécharge la mise à jour… ${Math.round(Updates.progress * 100)} %`;
      } else if (Updates.status === "error") {
        sub.textContent = `La mise à jour n'a pas marché : ${Updates.error ?? "erreur inconnue"}`;
      } else {
        sub.textContent = `Tu as la version ${Updates.current || "actuelle"}. Tes tâches et tes réglages ne bougent pas.`;
      }
      bar.style.display = installing ? "" : "none";
      (bar.firstChild as HTMLElement).style.width = `${Math.round((Updates.progress ?? 0.1) * 100)}%`;
      row.style.display = installing ? "none" : "";
      installBtn.style.display = u ? "" : "none";
    },
  };
}

// ── Evening recap ─────────────────────────────────────────────────────────────

export function buildRecap(actions: ViewActions): ViewHost {
  const title = h("div", { class: "title", text: "Bilan du jour" });
  const line = h("div", { class: "sub" });
  const done = h("ul", { class: "rc-list" });
  const left = h("ul", { class: "rc-list left" });
  const tomorrow = h("div", { class: "rc-tomorrow" });
  const brief = h("button", { class: "ov-brief", onclick: (e: Event) => { e.stopPropagation(); actions.setView("brief"); } });
  const main = h("div", { class: "ov-main rc" }, title, line, h("div", { class: "rc-cols" }, done, left), tomorrow, brief);
  const side = h("div", { class: "ov-actions" },
    btn("Ma journée", "secondary", () => actions.setView("tasks"), ICONS.list),
    btn("Bonne soirée", "primary", () => actions.closeCard()),
  );
  let key = "";
  return {
    el: h("div", { class: "view" }, card("soft", "ov-card", main, side)),
    sync() {
      const r = recapSummary();
      const k = JSON.stringify([r.done.map((t) => t.id), r.remaining.map((t) => t.id), r.tomorrowFirst?.id, r.evening?.file]);
      if (k === key) return;
      key = k;
      const nd = r.done.length;
      const nl = r.remaining.length;
      line.textContent = nd || nl
        ? `${nd} faite${nd > 1 ? "s" : ""}${nl ? ` · ${nl} reste${nl > 1 ? "nt" : ""}, je ${nl > 1 ? "les" : "la"} remets à demain` : " · tout est fait, bravo !"}`
        : "Journée calme, rien n'était prévu.";
      clear(done);
      for (const t of r.done.slice(0, 3)) done.append(h("li", {}, h("i", { class: "rc-ok" }, svg(ICONS.check, 8, { stroke: 3.4 })), h("span", { text: t.title })));
      if (nd > 3) done.append(h("li", { class: "rc-more", text: `+ ${nd - 3}` }));
      clear(left);
      for (const t of r.remaining.slice(0, 3)) left.append(h("li", {}, h("i", { class: "rc-todo" }), h("span", { text: t.title })));
      if (nl > 3) left.append(h("li", { class: "rc-more", text: `+ ${nl - 3}` }));
      const tf = r.tomorrowFirst;
      tomorrow.textContent = tf ? `Demain, ${timeLabel(tf.time!)} : ${tf.title}` : "";
      tomorrow.style.display = tf ? "" : "none";
      clear(brief);
      if (r.evening) brief.append(svg(ICONS.sun, 11), h("b", { text: "Ce soir" }), h("span", { text: firstLine(r.evening) }));
      brief.style.display = r.evening ? "" : "none";
    },
  };
}

// ── End of focus ──────────────────────────────────────────────────────────────

export const PauseInfo = { minutes: 25, held: 0 };

export function buildPause(actions: ViewActions): ViewHost {
  const sub = h("div", { class: "sub" });
  const body = h("div", { class: "stack" },
    h("div", { class: "title", text: "Pause !" }),
    sub,
    h("div", { class: "actions" },
      btn("OK", "primary", () => actions.closeCard(), ICONS.check),
      btn("Encore 25 min", "secondary", () => actions.startFocus(25)),
    ),
  );
  return {
    el: h("div", { class: "view" }, card("green", "", body)),
    sync() {
      const held = PauseInfo.held;
      sub.textContent = `${PauseInfo.minutes} minutes de concentration, bravo. Lève-toi, bois un verre d'eau.`
        + (held ? ` ${held} rappel${held > 1 ? "s t'attendent" : " t'attend"}.` : "");
    },
  };
}

// ── Notice (subscription, trial, agenda) ──────────────────────────────────────

export function buildNotice(actions: ViewActions): ViewHost {
  const label = h("div", { class: "rm-label" });
  const title = h("div", { class: "title rm-title" });
  const sub = h("div", { class: "sub" });
  const body = h("div", { class: "stack rm" }, label, title, sub,
    h("div", { class: "actions" },
      btn("Voir", "primary", () => {
        const v = State.notice?.view ?? "overview";
        State.notice = null;
        actions.setView(v);
      }),
      btn("OK", "ghost", () => actions.closeCard()),
    ),
  );
  return {
    el: h("div", { class: "view" }, card("amber", "", body)),
    sync() {
      const n = State.notice;
      label.textContent = n?.label ?? "";
      title.textContent = n?.title ?? "";
      sub.textContent = n?.sub ?? "";
    },
  };
}
