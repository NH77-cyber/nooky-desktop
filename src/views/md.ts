// Minimal markdown for briefs and bridge answers: **bold**, "- " bullets,
// "# " headings and [links](https://…), built as DOM (never as HTML, so a
// brief can't inject anything). Nooky Desktop — original code.

import { h } from "./dom";

export function renderMarkdown(text: string, maxLines = 40, openUrl?: (url: string) => void): HTMLElement {
  const box = h("div", { class: "md" });
  let list: HTMLElement | null = null;
  const inline = (line: string, into: HTMLElement) => {
    for (const p of line.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g)) {
      if (!p) continue;
      const link = p.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      if (p.startsWith("**") && p.endsWith("**") && p.length > 4) into.append(h("b", { text: p.slice(2, -2) }));
      else if (link) {
        const a = h("span", { class: "md-link", text: link[1], title: link[2] });
        a.addEventListener("click", (e) => { e.stopPropagation(); openUrl?.(link[2]); });
        into.append(a);
      } else into.append(document.createTextNode(p));
    }
  };
  for (const raw of text.split(/\r?\n/).slice(0, maxLines)) {
    const line = raw.trim();
    if (!line) {
      list = null;
      continue;
    }
    if (/^[-•*]\s+/.test(line)) {
      if (!list) {
        list = h("ul");
        box.append(list);
      }
      const li = h("li");
      inline(line.replace(/^[-•*]\s+/, ""), li);
      list.append(li);
    } else if (/^#{1,4}\s+/.test(line)) {
      list = null;
      const p = h("p", { class: "md-h" });
      inline(line.replace(/^#+\s+/, "").replace(/\*\*/g, ""), p);
      box.append(p);
    } else {
      list = null;
      const p = h("p");
      inline(line, p);
      box.append(p);
    }
  }
  return box;
}
