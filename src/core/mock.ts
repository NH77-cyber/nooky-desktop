// Dev-only stand-in for the Rust side, used when the island runs in a plain
// browser (`npm run dev`). Tasks live in localStorage as a fake sync folder
// with two device files, so the op-log, carry-over, reminders and the morning
// summary can all be tried and screenshotted without Tauri.
// Never used inside the app (see USE_MOCK in bridge.ts). Nooky Desktop — original code.

import { DEFAULT_SETTINGS } from "./state";
import { compact, createOp, editOp, putOp, type Op } from "../tasks/oplog";
import { addDays, dayKey, toDate, JOURS } from "../tasks/parse";

const KEY = "nooky-mock-folder-v2";
const OWN = "ops-macbook-pro-dev7k2p.json";
const OTHER = "ops-pc-bureau-x4q9.json";
const DEV = OWN.slice(4, -5);

type Folder = Record<string, string>;

function hm(h: number, m = 0) {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** That time of that day — or, if it is still to come, a moment just before now
 *  (same order), so the seed never sits in the future and loses no edit. */
function at(day: string, h: number, m = 0): Date {
  const [y, mo, d] = day.split("-").map(Number);
  const t = new Date(y, mo - 1, d, h, m);
  if (t.getTime() < Date.now() - 3600e3) return t;
  return new Date(Date.now() - 3600e3 + (h * 60 + m) * 1000);
}

/** A believable (made-up) day, written as ops by two devices, the maison and a scheduled task. */
function seed(): Folder {
  const today = dayKey();
  const y1 = addDays(today, -1);
  const y2 = addDays(today, -2);
  const tomorrow = addDays(today, 1);
  const own: Op[] = [];
  const other: Op[] = [];
  const maison: Op[] = [];
  const task: Op[] = [];
  const mk = (list: Op[], title: string, day: string, time: string | null, when: Date, tiroir: "pro" | "perso" = "pro") => {
    const op = createOp({ title, day, time, tiroir }, when);
    list.push(op);
    return op.key!;
  };
  const put = (list: Op[], coll: string, key: string, set: Op["set"], when: Date) => list.push(putOp(coll, key, set, when));
  mk(other, "Envoyer le compte rendu de réunion", y2, null, at(y2, 9, 10));
  mk(own, "Répondre à Camille sur le planning", y1, null, at(y1, 17, 40));
  const client = mk(own, "Relancer le client pour le devis", today, hm(14), at(today, 8, 2));
  mk(other, "Point budget avec l'équipe", today, hm(16, 30), at(today, 8, 15));
  mk(own, "Commander le gâteau d'anniversaire", today, null, at(today, 8, 20), "perso");
  mk(own, "Réserver le restaurant pour samedi", today, hm(19), at(today, 8, 21), "perso");
  mk(other, "Rappeler le garage", today, null, at(today, 8, 22), "perso");
  const prez = mk(other, "Préparer la présentation d'automne", today, hm(9, 30), at(today, 7, 50));
  other.push(editOp(prez, { done: true, doneAt: at(today, 9, 41).toISOString() }, at(today, 9, 41)));
  mk(own, "Vérifier les factures du mois", addDays(today, 1), hm(10), at(today, 8, 30));
  mk(own, "Préparer la négociation annuelle", addDays(today, 3), null, at(today, 8, 31));
  // An edit from the other device after ours: last writer wins.
  other.push(editOp(client, { title: "Relancer le client pour le devis 2027" }, at(today, 8, 40)));
  const gone = mk(own, "Tâche supprimée (test)", today, null, at(today, 8, 0));
  own.push(editOp(gone, { deleted: true }, at(today, 8, 1)));

  // Routines: two daily ones and the "Sac de demain" (tomorrow's weekday, so it shows).
  const dow = (k: string) => toDate(k).getDay() || 7;
  put(own, "routines", "rmeteo", { title: "Arroser les plantes", tiroir: "perso", rule: { freq: "daily" }, time: null, kind: "task", active: true }, at(y2, 8));
  put(own, "routines", "rstandup", { title: "Point d'équipe", tiroir: "pro", rule: { freq: "weekly", days: [dow(today)] }, time: hm(9), kind: "task", active: true }, at(y2, 8, 1));
  put(maison, "routines", "rpiscine", { title: `Piscine (${JOURS[toDate(tomorrow).getDay()]})`, tiroir: "perso", rule: { freq: "weekly", days: [dow(tomorrow)] }, time: null, kind: "sac", active: true }, at(y2, 8, 2));
  put(maison, "routines", "rgouter", { title: "Goûter", tiroir: "perso", rule: { freq: "daily" }, time: null, kind: "sac", active: true }, at(y2, 8, 3));
  put(maison, "routines", "rcarnet", { title: "Carnet de liaison signé", tiroir: "perso", rule: { freq: "weekly", days: [dow(tomorrow)] }, time: null, kind: "sac", active: true }, at(y2, 8, 4));
  // Today's watering was already ticked on the PC.
  put(other, "tasks", `r_rmeteo_${today.replace(/-/g, "")}`, { title: "Arroser les plantes", tiroir: "perso", day: today, origDay: today, time: null, done: true, doneAt: at(today, 8, 5).toISOString(), createdAt: at(today, 8, 5).toISOString(), routine: "rmeteo" }, at(today, 8, 5));

  // Shopping, subscriptions, agenda, watch list (written by the maison).
  ["Lait", "Pain", "Beurre", "Pommes", "Café"].forEach((label, i) =>
    put(maison, "shopping", `s${i}`, { label, done: label === "Beurre", doneAt: label === "Beurre" ? at(today, 8).toISOString() : null }, at(y1, 18, i)));
  const day = (n: number) => addDays(today, n);
  put(maison, "subs", "anetflix", { name: "Netflix", price: 13.49, cycle: "monthly", nextRenewal: day(2), trialEnd: null, category: "streaming" }, at(y2, 9));
  put(maison, "subs", "aspotify", { name: "Spotify", price: 11.12, cycle: "monthly", nextRenewal: day(17), trialEnd: null, category: "streaming" }, at(y2, 9, 1));
  put(maison, "subs", "apsplus", { name: "PS Plus", price: 71.99, cycle: "yearly", nextRenewal: day(64), trialEnd: null, category: "jeux" }, at(y2, 9, 2));
  put(maison, "subs", "adisney", { name: "Disney+", price: 9.99, cycle: "monthly", nextRenewal: day(9), trialEnd: day(8), category: "streaming" }, at(y2, 9, 3));
  put(task, "events", "e1", { title: "Réunion parents d'élèves", date: day(3), time: hm(18), kind: "ecole", remindDaysBefore: 1 }, at(y1, 7));
  put(task, "events", "e2", { title: "Anniversaire de Léa", date: day(6), time: null, kind: "anniv", remindDaysBefore: 3 }, at(y1, 7, 1));
  put(task, "events", "e3", { title: "Dentiste", date: day(9), time: hm(17, 30), kind: "rdv", remindDaysBefore: 1 }, at(y1, 7, 2));
  put(task, "events", "e4", { title: "Sortie scolaire au musée", date: day(1), time: hm(8, 30), kind: "ecole", remindDaysBefore: 1 }, at(y1, 7, 3));
  put(task, "events", "e5", { title: "Dans trois semaines (hors fenêtre)", date: day(21), time: null, kind: "autre", remindDaysBefore: 1 }, at(y1, 7, 4));
  put(maison, "watch", "w1", { title: "The Bear", kind: "serie", platform: "Disney+", note: "saison 4" }, at(y2, 20));
  put(maison, "watch", "w2", { title: "Zelda", kind: "jeu", platform: "Switch", note: "" }, at(y2, 20, 1));
  put(maison, "watch", "w3", { title: "Dune : deuxième partie", kind: "film", platform: "", note: "" }, at(y2, 20, 2));
  put(maison, "prefs", "main", { prenom: "", proHours: { days: [1, 2, 3, 4, 5], start: "08:30", end: "18:30" }, platforms: ["PS5", "Switch"], streaming: ["Netflix", "Disney+"], schoolZone: "C", eveningRecap: "18:00" }, at(y2, 7));
  put(own, "mailread", "m3", { read: true }, at(y1, 9));

  const now = new Date();
  const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
  const brief = (slot: string, label: string, title: string, text: string, items: object[], mails: object[] = [], ago = 2 * 3600e3) =>
    JSON.stringify({ slot, updatedAt: iso(ago), updatedLabel: label, title, text, items, mails });
  const ms = now.getTime();
  return {
    [OWN]: JSON.stringify({ version: 2, writer: OWN.slice(4, -5), device: "MacBook Pro", ops: own }, null, 1),
    [OTHER]: JSON.stringify({ version: 1, device: "PC-BUREAU", ops: other }, null, 1),
    [`ops-maison-${ms - 86400e3}.json`]: JSON.stringify({ version: 2, writer: "maison-k2", ops: maison.slice(0, 8) }),
    [`ops-maison-${ms - 3600e3}.json`]: JSON.stringify({ version: 2, writer: "maison-k2", ops: maison.slice(8) }),
    [`ops-task-agenda-${ms - 7200e3}.json`]: JSON.stringify({ version: 2, writer: "task-agenda", ops: task }),
    // Ignored by the fold: a Drive conflict copy and a half-synced file.
    "ops-pc-bureau-x4q9 (1).json": JSON.stringify({ version: 1, device: "x", ops: [createOp({ title: "NE DOIT PAS APPARAÎTRE", day: today, time: null })] }),
    "ops-tablette-broken.json": '{"version":1,"device":"Tablette","ops":[{"id":"x"',
    "brief-morning.json": brief("morning", "ce matin, 8 h 40", "Ta journée",
      "**3 choses à retenir** ce matin :\n- **Météo** : grand soleil, 21 °C cet après-midi\n- **Agenda** : deux réunions avant midi\n- Pense au **devis** à relancer à 14 h",
      [{ title: "Les nouveautés IA de la semaine en cinq points", url: "https://example.com/1", meta: "Le Journal Tech · aujourd'hui" },
        { title: "Trois idées pour des réunions plus courtes", url: "https://example.com/2", meta: "Organisation" }],
      [{ from: "Comptabilité", subject: "Factures de septembre à valider", url: "https://example.com/mail/1" }], 1.5 * 3600e3),
    "brief-veille.json": brief("veille", "ce matin, 8 h", "Daily Prog",
      "## Programmatique\n- Les enchères **first-price** se généralisent sur la CTV\n- Un nouveau standard d'identité en test chez deux SSP",
      [{ title: "CTV : les CPM reculent au troisième trimestre", url: "https://example.com/3", meta: "AdTech Daily · 2 oct." },
        { title: "Retail media : la mesure incrémentale devient la norme", url: "https://example.com/4", meta: "Media Weekly · 1 oct." }], [], 2 * 3600e3),
    "brief-veille (1).json": brief("veille", "hier, 8 h", "Ancienne veille (ne doit pas s'afficher)", "vieux", [], [], 26 * 3600e3),
    "brief-leisure.json": brief("leisure", "jeudi soir", "Loisirs",
      "- **The Bear** : la saison 4 arrive mercredi sur Disney+\n- **Zelda** en promo à -30 % sur Switch jusqu'à dimanche",
      [{ title: "Les sorties ciné de la semaine", url: "https://example.com/5", meta: "Cinéma" }], [], 3 * 86400e3),
    "mail-m1.json": JSON.stringify({ id: "m1", at: iso(3600e3), from: "Rappels", title: "Facture fournisseur : écart de 120 € à vérifier", body: "La facture de septembre dépasse le bon de commande de 120 €. À vérifier avant vendredi.", important: true }),
    "mail-m2.json": JSON.stringify({ id: "m2", at: iso(2 * 3600e3), from: "Daily Prog", title: "Veille du jour prête (4 nouveautés)", body: "Ouvre l'onglet Veille dans Briefs.", important: false }),
    "mail-m3.json": JSON.stringify({ id: "m3", at: iso(26 * 3600e3), from: "Maison", title: "Déjà lu hier", body: "", important: false }),
    "mail-old.json": JSON.stringify({ id: "old", at: iso(40 * 86400e3), from: "Maison", title: "Trop vieux (plus de 30 jours)", body: "", important: false }),
  };
}

function load(): Folder {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Folder;
  } catch {
    /* fall through */
  }
  const f = seed();
  save(f);
  return f;
}

function save(f: Folder) {
  try {
    localStorage.setItem(KEY, JSON.stringify(f));
  } catch {
    /* private mode: memory only */
  }
}

function local(key: string): unknown {
  try {
    const raw = localStorage.getItem(`nooky-mock-local:${key}`);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

const listeners = new Map<string, Set<(p: unknown) => void>>();
let version = 0;

const params = new URLSearchParams(location.search);
const geometry = params.has("notch")
  ? { hasNotch: true, notchW: Number(params.get("notch")) || 185, notchH: 32 }
  : { hasNotch: false, notchW: 184, notchH: 32 };

export const Mock = {
  notified: [] as { title: string; body: string }[],

  /** Wipes the fake folder (used by tests via `?reset`). */
  reset() {
    localStorage.removeItem(KEY);
    for (const k of Object.keys(localStorage)) if (k.startsWith("nooky-mock-local:")) localStorage.removeItem(k);
  },

  on(name: string, handler: (p: unknown) => void) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(handler);
    return () => listeners.get(name)?.delete(handler);
  },

  emit(name: string, payload: unknown) {
    for (const h of listeners.get(name) ?? []) h(payload);
  },

  async call(cmd: string, args: Record<string, unknown> = {}, throwing = false): Promise<unknown> {
    switch (cmd) {
      case "boot": {
        const stored = local("settings") as Record<string, unknown> | null;
        // `?name=Camille`: a prénom for screenshots of the greeting.
        const name = params.get("name");
        return {
          settings: { ...DEFAULT_SETTINGS, ...(stored ?? {}), ...(name ? { firstName: name } : {}) },
          screen: { x: 0, y: 0, width: 1512, height: 982, scale: 2 },
          geometry,
          version: "dev",
          cursorPoll: false,
          os: "browser",
        };
      }
      case "save_settings":
        localStorage.setItem("nooky-mock-local:settings", JSON.stringify(args.settings));
        Mock.emit("settings-changed", args.settings);
        return null;
      case "reposition":
        return geometry;
      case "sync_info":
        return {
          dir: "/Users/moi/Library/CloudStorage/GoogleDrive-moi@example.com/Mon Drive/Nooky",
          mode: "drive",
          detected: "/Users/moi/Library/CloudStorage/GoogleDrive-moi@example.com/Mon Drive/Nooky",
          deviceId: OWN.slice(4, -5),
          deviceName: "MacBook Pro",
          ownFile: OWN,
          customError: null,
        };
      case "sync_set_dir":
        return Mock.call("sync_info");
      case "sync_stamp": {
        const f = load();
        return `mock|${version}|${Object.entries(f).map(([k, v]) => `${k}:${v.length}`).join("|")}`;
      }
      case "sync_read_all": {
        const f = load();
        const pick = (pre: string) => Object.entries(f).filter(([k]) => k.startsWith(pre)).map(([file, json]) => ({ file, json }));
        return {
          stamp: String(version),
          files: pick("ops-"),
          briefs: pick("brief-"),
          mails: pick("mail-"),
          answers: pick(`answer-${DEV}-`),
          brief: f["brief.json"] ?? null,
          mailbox: f["mailbox.json"] ?? null,
        };
      }
      case "sync_ask": {
        const f = load();
        const id = `${DEV}-${Date.now()}`;
        f[`ask-${id}.json`] = JSON.stringify({ id, device: "MacBook Pro", ...(args.ask as object) });
        save(f);
        version++;
        // The pretend maison answers after a moment (unless ?maison=off).
        if (!params.has("maison")) {
          window.setTimeout(() => {
            const g = load();
            g[`answer-${id}.json`] = JSON.stringify({
              id, at: new Date().toISOString(),
              text: "Voici ce que je te propose :\n- **Relance** le client avec un récap en trois lignes\n- Propose un point de **15 min** jeudi\n\nJe te prépare le mail ?",
            });
            save(g);
            version++;
          }, Number(params.get("answerMs") ?? 2500));
        }
        return id;
      }
      case "sync_cleanup_bridge":
        return 0;
      case "caught_text": {
        const p = String(args.path);
        if (/\.(txt|md|csv)$/i.test(p)) return "Bonjour, peux-tu m'envoyer le devis d'ici jeudi ? Merci !";
        if (throwing) throw new Error("ce n'est pas un fichier texte");
        return null;
      }
      case "sync_append": {
        const f = load();
        const doc = f[OWN] ? JSON.parse(f[OWN]) : { version: 2, writer: DEV, device: "MacBook Pro", ops: [] };
        doc.version = 2;
        doc.writer = DEV;
        const ids = new Set((doc.ops as Op[]).map((o) => o.id));
        for (const op of args.ops as Op[]) if (!ids.has(op.id)) doc.ops.push(op);
        if (doc.ops.length > 2000) doc.ops = compact(doc.ops);
        f[OWN] = JSON.stringify(doc, null, 1);
        save(f);
        version++;
        return doc.ops.length;
      }
      case "local_get":
        return local(String(args.key));
      case "local_set":
        localStorage.setItem(`nooky-mock-local:${String(args.key)}`, JSON.stringify(args.value));
        return null;
      case "secret_present":
        return localStorage.getItem("nooky-mock-key") === "1";
      case "secret_set":
        localStorage.setItem("nooky-mock-key", args.value ? "1" : "0");
        return null;
      case "secret_clear":
        localStorage.removeItem("nooky-mock-key");
        return null;
      case "chat_send": {
        await new Promise((r) => setTimeout(r, 1400));
        const q = String(args.query);
        if (/erreur/i.test(q)) {
          if (throwing) throw new Error("Claude API 401 : clé invalide (simulation).");
          return null;
        }
        return {
          text:
            "Bien sûr ! Je te propose de relancer avec un récap en trois lignes et une date de rendez-vous. " +
            "Tu veux que je te prépare le mail ?",
        };
      }
      case "chat_reset":
        return null;
      case "ingest_file": {
        const path = String(args.path);
        return { name: path.split(/[\\/]/).pop() || "fichier", path, size: 1234 };
      }
      default:
        return null;
    }
  },
};
