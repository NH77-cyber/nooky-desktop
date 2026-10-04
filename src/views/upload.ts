// File drop: the drop zone, the little progress bar Nooky rides, and the
// "what do I do with it" card. The card/bar styling is adapted from Coucou by
// Louis Raillé (MIT License); there is no box and no swallowing here — Nooky
// catches the file with a big squash and a wide-open mouth (engine.dropReaction).

import { h, clear } from "./dom";
import { State } from "../core/state";
import type { QuickKind, ViewActions, ViewHost } from "./views";

/** Dashed rounded rect drawn as SVG so the dashes can march. */
function dashedFrame(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const el = document.createElementNS(ns, "svg");
  el.setAttribute("class", "drop-frame");
  el.setAttribute("preserveAspectRatio", "none");
  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("x", "0.75");
  rect.setAttribute("y", "0.75");
  rect.setAttribute("width", "calc(100% - 1.5px)");
  rect.setAttribute("height", "calc(100% - 1.5px)");
  rect.setAttribute("rx", "20");
  rect.setAttribute("fill", "none");
  rect.setAttribute("stroke-width", "1.5");
  rect.setAttribute("stroke-dasharray", "6 5");
  el.append(rect);
  return el;
}

export function buildUpload(): ViewHost {
  const frame = dashedFrame();
  const title = h("div", { class: "drop-title", text: "Dépose ton fichier ici" });
  const sub = h("div", { class: "sub", text: "PDF, image, texte ou code : je le lis et tu me poses ta question." });
  const tags = h("div", { class: "drop-tags" }, ...["PDF", "Images", "Texte", "Code"].map((t) => h("span", { text: t })));
  const card = h("div", { class: "card drop-card" }, frame, h("div", { class: "drop-body" }, title, sub, tags));
  const el = h("div", { class: "view" }, card);
  return {
    el,
    sync() {
      card.classList.toggle("over", State.fileDragOver);
      title.textContent = State.fileDragOver
        ? "Lâche-le, je l'attrape !"
        : State.droppedFile ? "Attrapé !" : "Dépose ton fichier ici";
    },
  };
}

export function buildUploading(): ViewHost {
  const label = h("span", { class: "up-name" });
  const percent = h("span", { class: "up-pct" });
  const fill = h("div", { class: "up-fill" });
  const glow = h("div", { class: "up-glow" });
  const card = h(
    "div",
    { class: "card up-card" },
    h("div", { class: "up-row" }, label, percent),
    h("div", { class: "up-track" }, fill, glow),
  );
  const el = h("div", { class: "view" }, card);
  return {
    el,
    sync() {
      const done = State.uploadProgress >= 0.995;
      const name = State.droppedFile?.name ?? "ton fichier";
      label.textContent = done ? `✓  ${name}` : `Je range ${name}…`;
      label.classList.toggle("done", done);
      percent.textContent = done ? "" : `${Math.round(State.uploadProgress * 100)} %`;
      const w = State.uploadProgress * 526;
      fill.style.width = `${w}px`;
      glow.style.transform = `translateX(${Math.max(0, w - 14)}px)`;
      glow.style.opacity = State.uploadProgress > 0.01 ? "1" : "0";
      card.classList.toggle("done", done);
    },
  };
}

export function buildChoose(actions: ViewActions): ViewHost {
  const title = h("div", { class: "title", text: "Que veux-tu que j'en fasse ?" });
  const what = h("div", { class: "sub ch-what" });
  const quick = (label: string, kind: QuickKind) =>
    h("button", { class: "btn secondary", text: label, onclick: (e: Event) => { e.stopPropagation(); actions.askAbout(kind); } });
  const row = h(
    "div",
    { class: "actions wrap" },
    quick("Résumer", "summary"),
    quick("Répondre", "reply"),
    quick("Traduire en anglais", "translate"),
    quick("Extraire les tâches", "tasks"),
  );
  const row2 = h(
    "div",
    { class: "actions" },
    h("button", {
      class: "btn ghost",
      text: "Autre question",
      onclick: (e: Event) => { e.stopPropagation(); actions.setView("prompt"); },
    }),
    h("button", {
      class: "btn ghost",
      text: "Annuler",
      onclick: (e: Event) => {
        e.stopPropagation();
        State.droppedFile = null;
        State.droppedText = null;
        actions.setView(State.defaultView());
      },
    }),
  );
  const el = h("div", { class: "view" }, h("div", { class: "card wash" }, h("div", { class: "stack choose" }, title, what, row, row2)));
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(52,211,153,0.3)");
  return {
    el,
    sync() {
      clear(what);
      if (State.droppedText) {
        const t = State.droppedText.replace(/\s+/g, " ").trim();
        what.append(h("b", { text: "Ton texte" }), document.createTextNode(` · « ${t.length > 60 ? `${t.slice(0, 60)}…` : t} »`));
      } else {
        what.append(h("b", { text: State.droppedFile?.name ?? "Ton fichier" }), document.createTextNode(" est prêt."));
      }
    },
  };
}
