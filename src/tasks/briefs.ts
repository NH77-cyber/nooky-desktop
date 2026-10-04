// Briefs (brief-<slot>.json) and mail (mail-<id>.json) — SYNC-FORMAT.md §2–3.
// Pure functions only. Nooky Desktop — original code.
//
// Both kinds of files are written by the scheduled tasks as NEW files (the
// claude.ai Drive connector cannot rewrite one), so a folder may briefly hold
// two briefs of the same slot, or Drive duplicates such as
// "brief-morning (1).json": we read them all and keep, per slot, the one with
// the newest updatedAt; mail is deduplicated by id. The legacy v1 files
// brief.json / mailbox.json are still read when present.

export type Slot = "morning" | "veille" | "evening" | "weekly" | "monthly" | "leisure";

/** Tab order and labels in the Briefs view. */
export const SLOTS: { slot: Slot; label: string }[] = [
  { slot: "morning", label: "Ce matin" },
  { slot: "veille", label: "Veille" },
  { slot: "evening", label: "Ce soir" },
  { slot: "weekly", label: "Semaine" },
  { slot: "monthly", label: "Mois" },
  { slot: "leisure", label: "Loisirs" },
];

const SLOT_SET = new Set<string>(SLOTS.map((s) => s.slot));

export interface BriefItem {
  title: string;
  url: string;
  meta: string;
}

export interface BriefMail {
  from: string;
  subject: string;
  url: string;
}

export interface Brief {
  slot: Slot;
  updatedAt: string | null;
  updatedLabel: string;
  title: string;
  text: string;
  items: BriefItem[];
  mails: BriefMail[];
  file: string;
}

export interface Mail {
  id: string;
  at: string;
  from: string;
  title: string;
  body: string;
  important: boolean;
  /** Marked read in a legacy mailbox.json (v1). */
  legacyRead: boolean;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const objs = (v: unknown) => (Array.isArray(v) ? v : []).filter((i): i is Record<string, unknown> => !!i && typeof i === "object");
const httpUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : "");

function parseJson(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** "brief-morning.json", "brief-morning (1).json", "brief-morning-1730000.json" → "morning". */
export function slotFromName(file: string): Slot | null {
  const m = file.match(/^brief-([a-z]+)/i);
  const s = m?.[1].toLowerCase() ?? "";
  return SLOT_SET.has(s) ? (s as Slot) : null;
}

export function parseBrief(file: string, text: string | null): Brief | null {
  const v = parseJson(text);
  if (!v) return null;
  const slotRaw = str(v.slot).toLowerCase();
  const slot = (SLOT_SET.has(slotRaw) ? slotRaw : slotFromName(file)) as Slot | null;
  if (!slot) return null;
  return {
    slot,
    updatedAt: str(v.updatedAt) || null,
    updatedLabel: str(v.updatedLabel),
    title: str(v.title),
    text: str(v.text),
    items: objs(v.items).map((i) => ({ title: str(i.title), url: httpUrl(str(i.url)), meta: str(i.meta) })).filter((i) => i.title),
    mails: objs(v.mails).map((m) => ({ from: str(m.from), subject: str(m.subject), url: httpUrl(str(m.url)) })).filter((m) => m.subject),
    file,
  };
}

/** A v1 brief.json, read as the "morning" brief. */
export function parseLegacyBrief(text: string | null): Brief | null {
  const v = parseJson(text);
  if (!v) return null;
  return {
    slot: "morning",
    updatedAt: str(v.updatedAt) || null,
    updatedLabel: str(v.updatedLabel),
    title: "Ce matin",
    text: str(v.brief),
    items: objs(v.items)
      .map((i) => ({ title: str(i.title), url: httpUrl(str(i.url)), meta: [str(i.source) || str(i.cat), str(i.date)].filter(Boolean).join(" · ") }))
      .filter((i) => i.title),
    mails: [],
    file: "brief.json",
  };
}

const time = (iso: string | null) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** The newest brief per slot. */
export function pickBriefs(files: { file: string; json: string }[], legacy: string | null = null): Map<Slot, Brief> {
  const out = new Map<Slot, Brief>();
  const all = files.map((f) => parseBrief(f.file, f.json)).filter((b): b is Brief => !!b);
  const old = parseLegacyBrief(legacy);
  if (old) all.push(old);
  for (const b of all) {
    const cur = out.get(b.slot);
    if (!cur || time(b.updatedAt) > time(cur.updatedAt) || (time(b.updatedAt) === time(cur.updatedAt) && b.file > cur.file)) {
      out.set(b.slot, b);
    }
  }
  return out;
}

function toMail(m: Record<string, unknown>, legacyRead = false): Mail | null {
  const id = str(m.id);
  const title = str(m.title);
  if (!id || !title) return null;
  return {
    id, at: str(m.at), from: str(m.from), title, body: str(m.body),
    important: m.important === true, legacyRead,
  };
}

/** Every mail of the last `days` days, newest first, one per id. */
export function parseMails(
  files: { file: string; json: string }[],
  legacyMailbox: string | null = null,
  now = new Date(),
  days = 30,
): Mail[] {
  const byId = new Map<string, Mail>();
  const add = (m: Mail | null) => {
    if (!m) return;
    const cur = byId.get(m.id);
    if (!cur || time(m.at) > time(cur.at)) byId.set(m.id, m);
  };
  for (const f of files) {
    const v = parseJson(f.json);
    if (v) add(toMail(v));
  }
  const legacy = parseJson(legacyMailbox);
  for (const m of objs(legacy?.messages)) add(toMail(m, m.read === true));
  const cutoff = now.getTime() - days * 864e5;
  return [...byId.values()]
    .filter((m) => !m.at || time(m.at) >= cutoff)
    .sort((a, b) => time(b.at) - time(a.at));
}

/** First meaningful line of a brief's text, without markdown — for the overview. */
export function firstLine(b: Brief): string {
  const lines = b.text.split(/\r?\n/)
    .map((raw) => raw.replace(/^[-•*]\s+/, "").replace(/\*\*/g, "").replace(/^#+\s*/, "").trim())
    .filter(Boolean);
  if (!lines.length) return b.items[0]?.title ?? b.title;
  // "3 choses à retenir :" → also show what follows.
  if (lines.length > 1 && (lines[0].endsWith(":") || lines[0].length < 18)) return `${lines[0].replace(/\s*:$/, "")} : ${lines[1]}`;
  return lines[0];
}
