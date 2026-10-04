// Quick capture — what a line typed in the island means. Pure functions only.
// Nooky Desktop — original code.
//
// The parser stays small on purpose. Understood, in this order:
//
//   courses : lait, pain et beurre     → 3 shopping items       (also "+courses lait", "+ courses : …")
//   abo Netflix 13,49 le 12            → subscription, monthly, renews on the next 12th
//   abo PS Plus 71,99 par an le 3      → yearly ("par an", "/an")
//   abo Max 9,99 essai jusqu'au 20/11  → with a trial end ("essai 20", "essai jusqu'au 20/11")
//   + relancer le client demain 14h    → task (dates and times as parseTask)
//   + piscine chaque mardi 17h         → routine (see parseRepeat)
//   + sac : goûter tous les jours      → "Sac de demain" routine
//
// In Ma journée the "+" is optional (everything typed there is a task unless it
// is a shopping or subscription line); in the chat it is required, so
// questions still go to Claude.

import { addDays, dayKey, pad, parseTask, toDate } from "./parse";
import { parseRepeat, type Rule } from "./routines";

export type SubCategory = "jeux" | "streaming" | "autre";

export type Capture =
  | { kind: "task"; title: string; day: string; time: string | null; repeat: Rule | null; sac: boolean }
  | { kind: "shopping"; items: string[] }
  | {
      kind: "sub"; name: string; price: number; cycle: "monthly" | "yearly";
      nextRenewal: string; trialEnd: string | null; category: SubCategory;
    };

const STREAMING = ["netflix", "disney", "prime video", "amazon prime", "canal", "max", "hbo", "apple tv", "paramount",
  "spotify", "deezer", "crunchyroll", "youtube", "molotov", "ocs", "arte", "dazn", "salto", "france.tv"];
const GAMES = ["ps plus", "playstation", "psn", "game pass", "xbox", "nintendo", "switch online", "ubisoft", "ea play",
  "steam", "geforce now", "humble", "apple arcade"];

export function subCategory(name: string, extra: { streaming?: string[]; platforms?: string[] } = {}): SubCategory {
  const n = name.toLowerCase();
  const has = (list: string[]) => list.some((w) => w && n.includes(w.toLowerCase()));
  if (has(GAMES) || has(extra.platforms ?? [])) return "jeux";
  if (has(STREAMING) || has(extra.streaming ?? [])) return "streaming";
  return "autre";
}

/** The next date on day-of-month `d` from `today` (today included), clamped to short months. */
export function nextMonthDay(d: number, today: string): string {
  const t = toDate(today);
  const mk = (y: number, m: number) => {
    const last = new Date(y, m + 1, 0).getDate();
    return dayKey(new Date(y, m, Math.min(d, last)));
  };
  const thisMonth = mk(t.getFullYear(), t.getMonth());
  return thisMonth >= today ? thisMonth : mk(t.getFullYear(), t.getMonth() + 1);
}

/** "20/11" or "20" → the next such date from today. */
function nextDate(dd: number, mm: number | null, today: string): string | null {
  if (!(dd >= 1 && dd <= 31)) return null;
  if (mm == null) return nextMonthDay(dd, today);
  if (!(mm >= 1 && mm <= 12)) return null;
  const t = toDate(today);
  let k = `${t.getFullYear()}-${pad(mm)}-${pad(dd)}`;
  if (k < today) k = `${t.getFullYear() + 1}-${pad(mm)}-${pad(dd)}`;
  return k;
}

export function splitItems(s: string): string[] {
  return s
    .split(/\s*(?:,|;|\bet\b|\+|\n)\s*/i)
    .map((x) => x.trim().replace(/[.]+$/, ""))
    .filter(Boolean)
    .map((x) => x.charAt(0).toUpperCase() + x.slice(1))
    .slice(0, 30);
}

export function parseCapture(
  raw: string,
  now = new Date(),
  opts: { requirePlus?: boolean; streaming?: string[]; platforms?: string[] } = {},
): Capture | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const today = dayKey(now);

  // Shopping.
  const shop = text.match(/^(?:\+\s*courses?\s*[:：]?|courses?\s*[:：])\s*(.+)$/is);
  if (shop) {
    const items = splitItems(shop[1]);
    if (items.length) return { kind: "shopping", items };
  }

  // Subscription.
  const sub = text.match(/^\+?\s*abo(?:nnement)?\s+(.+?)\s+(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:€|eur(?:os?)?)?(.*)$/i);
  if (sub) {
    const name = sub[1].trim().replace(/\s*:$/, "");
    const price = Math.round(Number(sub[2].replace(",", ".")) * 100) / 100;
    const tail = ` ${sub[3]} `;
    const cycle: "monthly" | "yearly" = /\s(?:par an|\/\s?an|annuel(?:le)?|l'an)\s/i.test(tail) ? "yearly" : "monthly";
    const trial = tail.match(/essai(?:\s+gratuit)?\s+(?:jusqu'?au\s+|fin\s+)?(\d{1,2})(?:\s*\/\s*(\d{1,2}))?/i);
    const trialEnd = trial ? nextDate(Number(trial[1]), trial[2] ? Number(trial[2]) : null, today) : null;
    const tailNoTrial = trial ? tail.replace(trial[0], " ") : tail;
    const le = tailNoTrial.match(/\sle\s+(\d{1,2})(?:er)?(?:\s*\/\s*(\d{1,2}))?\s/i);
    let nextRenewal: string;
    if (le) nextRenewal = nextDate(Number(le[1]), le[2] ? Number(le[2]) : null, today) ?? today;
    else {
      const d = toDate(today);
      nextRenewal = cycle === "yearly"
        ? dayKey(new Date(d.getFullYear() + 1, d.getMonth(), d.getDate()))
        : nextMonthDay(d.getDate(), addDays(today, 1));
    }
    if (name && price > 0) {
      return { kind: "sub", name: name.charAt(0).toUpperCase() + name.slice(1), price, cycle, nextRenewal, trialEnd, category: subCategory(name, opts) };
    }
  }

  // Task (or routine).
  const plus = text.startsWith("+");
  if (opts.requirePlus && !plus) return null;
  let body = text.replace(/^\+\s*/, "");
  let sac = false;
  const sacM = body.match(/^sac(?:\s+de\s+demain)?\s*[:：]\s*/i);
  if (sacM) {
    sac = true;
    body = body.slice(sacM[0].length);
  }
  const rep = parseRepeat(body, now);
  if (rep) body = rep.rest;
  const p = parseTask(body, now);
  if (!p.title) return null;
  return { kind: "task", title: p.title.slice(0, 200), day: p.day, time: p.time, repeat: rep?.rule ?? (sac ? { freq: "daily", workdaysOnly: true } : null), sac };
}

/** Short French summary of what was understood ("Ajouté aux courses : lait, pain"). */
export function captureSummary(c: Capture, ruleText?: string): string {
  switch (c.kind) {
    case "shopping":
      return `Ajouté aux courses : ${c.items.join(", ")}`;
    case "sub": {
      const price = c.price.toFixed(2).replace(".", ",");
      const [y, m, d] = c.nextRenewal.split("-");
      let s = `Abonnement ${c.name}, ${price} € ${c.cycle === "yearly" ? "par an" : "par mois"}, renouvellement le ${d}/${m}`;
      if (c.trialEnd) s += `, essai jusqu'au ${c.trialEnd.slice(8)}/${c.trialEnd.slice(5, 7)}`;
      void y;
      return s;
    }
    case "task":
      if (c.repeat) return `${c.sac ? "Sac de demain" : "Routine"} : ${c.title}${ruleText ? `, ${ruleText}` : ""}`;
      return c.title;
  }
}
