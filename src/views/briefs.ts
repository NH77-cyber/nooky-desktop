// Briefs: one tab per brief slot present (Ce matin, Veille, Ce soir, Semaine,
// Mois, Loisirs) — the text as simple markdown, the items with their links and
// the mails it points at. Nooky Desktop — original code.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { renderMarkdown } from "./md";
import { Tasks } from "../tasks/store";
import { SLOTS, type Slot } from "../tasks/briefs";
import { Briefs, listCard, type ViewActions, type ViewHost } from "./views";
import { State } from "../core/state";

export function buildBriefs(actions: ViewActions): ViewHost {
  const tabs = h("div", { class: "br-tabs" });
  const when = h("span", { class: "tk-count br-when" });
  const body = h("div", { class: "br-scroll" });
  const lc = listCard("brief", [tabs, h("span", { class: "grow" }), when], body);
  let slot: Slot | null = null;
  let key = "";
  return {
    el: lc.el,
    sync() {
      const present = SLOTS.filter((s) => Tasks.briefs.has(s.slot));
      if (!slot || !Tasks.briefs.has(slot)) {
        // Open on the newest one.
        slot = Tasks.newestBrief()?.slot ?? present[0]?.slot ?? null;
      }
      const b = slot ? Tasks.briefs.get(slot)! : null;
      const k = JSON.stringify([slot, present.map((s) => s.slot), b?.file, b?.updatedAt, Briefs.seen]);
      if (State.view === "brief" && slot) Briefs.markSeen(slot);
      if (k === key) return;
      key = k;
      clear(tabs);
      for (const s of present) {
        const br = Tasks.briefs.get(s.slot)!;
        const fresh = (br.updatedAt ?? "") > (Briefs.seen[s.slot] ?? "");
        tabs.append(h("button", {
          class: `br-tab${s.slot === slot ? " on" : ""}`,
          onclick: (e: Event) => { e.stopPropagation(); slot = s.slot; actions.blip(); key = ""; State.notify(); },
        }, h("span", { text: s.label }), fresh && s.slot !== slot ? h("i", { class: "br-new" }) : null));
      }
      when.textContent = b?.updatedLabel ? b.updatedLabel : "";
      clear(body);
      if (!b) {
        tabs.append(h("b", { class: "br-title", text: "Briefs" }));
        body.append(h("div", {
          class: "empty",
          text: "Rien pour l'instant. Les briefs (matin, veille, soir, semaine, mois, loisirs) arrivent ici dès que les tâches planifiées les ont préparés.",
        }));
        return;
      }
      if (b.title) body.append(h("div", { class: "br-head", text: b.title }));
      if (b.text) body.append(renderMarkdown(b.text, 60, (u) => actions.openUrl(u)));
      if (b.items.length) {
        body.append(h("div", { class: "br-h", text: "À lire" }));
        const ul = h("ul", { class: "br-news" });
        for (const it of b.items.slice(0, 20)) {
          const li = h("li", {},
            h("span", { class: "tt", text: it.title, title: it.title }),
            it.meta ? h("span", { class: "src", text: it.meta }) : null,
          );
          if (it.url) {
            li.classList.add("link");
            li.append(svg(ICONS.arrowUpRight, 9));
            li.addEventListener("click", (e) => { e.stopPropagation(); actions.openUrl(it.url); });
          }
          ul.append(li);
        }
        body.append(ul);
      }
      if (b.mails.length) {
        body.append(h("div", { class: "br-h", text: `Mails (${b.mails.length})` }));
        const ul = h("ul", { class: "br-news mail" });
        for (const m of b.mails.slice(0, 20)) {
          const li = h("li", {},
            h("span", { class: "src", text: m.from || "—" }),
            h("span", { class: "tt", text: m.subject, title: m.subject }),
          );
          if (m.url) {
            li.classList.add("link");
            li.append(svg(ICONS.arrowUpRight, 9));
            li.addEventListener("click", (e) => { e.stopPropagation(); actions.openUrl(m.url); });
          }
          ul.append(li);
        }
        body.append(ul);
      }
    },
  };
}
