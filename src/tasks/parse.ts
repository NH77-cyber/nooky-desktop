// Dates and the little French task parser ("relancer le client demain 14h").
// Nooky Desktop — original code (same rules as the web "maison").

export const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" in local time. */
export const dayKey = (d: Date = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const toDate = (k: string) => {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
};

export const addDays = (k: string, n: number) => {
  const d = toDate(k);
  d.setDate(d.getDate() + n);
  return dayKey(d);
};

export const daysBetween = (from: string, to: string) =>
  Math.round((toDate(to).getTime() - toDate(from).getTime()) / 864e5);

export const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

/** "HH:MM" now. */
export const nowHM = (d: Date = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** "14:30" → "14h30", "09:00" → "9h". */
export function timeLabel(t: string): string {
  const [h, m] = t.split(":");
  return `${Number(h)}h${m === "00" ? "" : m}`;
}

export function dayName(k: string, today = dayKey()): string {
  if (k === today) return "aujourd'hui";
  if (k === addDays(today, 1)) return "demain";
  if (k === addDays(today, -1)) return "hier";
  const d = toDate(k);
  const diff = daysBetween(today, k);
  if (diff > 1 && diff < 7) return JOURS[d.getDay()];
  return d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
}

export interface ParsedTask {
  title: string;
  day: string;
  time: string | null;
}

/**
 * Understands "demain", "après-demain", weekday names ("lundi", "ce jeudi",
 * "vendredi prochain"), dates ("le 12/11", "12/11/2027") and times ("14h",
 * "14h30", "14:30", "à 9h", "vers 18h").
 * Whatever is left becomes the title, with a capital letter.
 */
export function parseTask(raw: string, now: Date = new Date()): ParsedTask {
  let s = ` ${String(raw || "").trim()} `;
  const today = dayKey(now);
  let day = today;
  let time: string | null = null;

  const dm = s.match(/\s(?:pour\s)?(?:le\s)?(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?=\s)/);
  if (dm && Number(dm[1]) >= 1 && Number(dm[1]) <= 31 && Number(dm[2]) >= 1 && Number(dm[2]) <= 12) {
    let k = `${dm[3] ?? now.getFullYear()}-${pad(Number(dm[2]))}-${pad(Number(dm[1]))}`;
    if (!dm[3] && k < today) k = `${now.getFullYear() + 1}-${pad(Number(dm[2]))}-${pad(Number(dm[1]))}`;
    day = k;
    s = s.replace(dm[0], " ");
  } else if (/\saprès-demain\s/i.test(s)) {
    day = addDays(today, 2);
    s = s.replace(/\s(?:pour\s)?après-demain(?=\s)/i, " ");
  } else if (/\sdemain\s/i.test(s)) {
    day = addDays(today, 1);
    s = s.replace(/\s(?:pour\s)?demain(?=\s)/i, " ");
  } else {
    const m = s.match(/\s(?:pour\s|ce\s)?(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)(?:\sprochain)?(?=\s)/i);
    if (m) {
      let diff = (JOURS.indexOf(m[1].toLowerCase()) - now.getDay() + 7) % 7;
      if (diff === 0) diff = 7;
      day = addDays(today, diff);
      s = s.replace(m[0], " ");
    }
  }

  const tm = s.match(/\s(?:à|a|vers)?\s?(\d{1,2})\s?[h:](\d{2})?(?=\s)/i);
  if (tm) {
    const h = Number(tm[1]);
    const mi = Number(tm[2] || 0);
    if (h < 24 && mi < 60) {
      time = `${pad(h)}:${pad(mi)}`;
      s = s.replace(tm[0], " ");
    }
  }

  let title = s.replace(/\s+/g, " ").trim().replace(/^[-–•+]\s*/, "");
  title = title.charAt(0).toUpperCase() + title.slice(1);
  return { title, day, time };
}
