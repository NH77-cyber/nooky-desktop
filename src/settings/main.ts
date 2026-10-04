// Settings window — you, rhythm and leisure (synced prefs), Claude key and
// model, sync folder, sounds, startup, about.
// Adapted from Coucou by Louis Raillé (MIT License, see LICENSE-COUCOU-MIT).

import "./settings.css";
import { emit } from "@tauri-apps/api/event";
import { Bridge, IS_TAURI, onEvent, pickFolder, type SyncInfo } from "../core/bridge";
import { DEFAULT_SETTINGS, MODELS, type Settings } from "../core/state";
import { h, clear } from "../views/dom";
import { fold, putOp } from "../tasks/oplog";
import { toPrefs, type Prefs } from "../tasks/records";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";
let os = "";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

const keychainName = () =>
  os === "macos" ? "le Trousseau macOS" : os === "windows" ? "le Gestionnaire d'identification Windows" : "le trousseau du système";

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    el.setAttribute("aria-pressed", String(next));
    onChange(next);
  });
  return el;
}

function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#34d399" : "#f4505e"}` });
}

function notice(kind: "ok" | "err" | "warn", text: string): HTMLElement {
  return h("div", { class: `notice ${kind}`, text });
}

// ── Synced prefs (coll "prefs", key "main") ─────────────────────────────────
//
// Shared with the maison and the scheduled tasks through the sync folder.

let prefs: Prefs = toPrefs(undefined);

async function loadPrefs() {
  const snap = await Bridge.syncReadAll();
  if (snap) prefs = toPrefs(fold(snap.files).colls.get("prefs")?.get("main"));
}

async function savePrefs(set: Partial<Prefs>): Promise<string | null> {
  prefs = { ...prefs, ...set };
  try {
    await Bridge.syncAppend([putOp("prefs", "main", { ...set })]);
    // The island re-reads the folder right away.
    if (IS_TAURI) await emit("sync-changed");
    return null;
  } catch (err) {
    return `Pas enregistré : ${String(err)}`;
  }
}

const DAYS = ["L", "M", "M", "J", "V", "S", "D"];
const DAY_TITLES = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

function status(): { el: HTMLElement; show(err: string | null): void } {
  const el = h("span", { class: "hint small" });
  return {
    el,
    show(err) {
      el.textContent = err ?? "Enregistré.";
      el.style.color = err ? "#ff8d97" : "";
      window.setTimeout(() => { el.textContent = ""; }, 2500);
    },
  };
}

function timeInput(value: string, onChange: (v: string) => void): HTMLInputElement {
  const el = h("input", { type: "time", value, style: "width:96px" }) as HTMLInputElement;
  el.addEventListener("change", () => {
    if (/^\d{2}:\d{2}$/.test(el.value)) onChange(el.value);
  });
  return el;
}

const listText = (v: string[]) => v.join(", ");
const parseList = (v: string) => [...new Set(v.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean))].slice(0, 20);

function rhythmSection(): HTMLElement {
  const st = status();
  const days = h("div", { class: "days" });
  const paintDays = () => {
    clear(days);
    DAYS.forEach((label, i) => {
      const d = i + 1;
      const on = prefs.proHours.days.includes(d);
      const b = h("button", { class: on ? "day on" : "day", text: label, title: DAY_TITLES[i] });
      b.addEventListener("click", async () => {
        const next = on ? prefs.proHours.days.filter((x) => x !== d) : [...prefs.proHours.days, d].sort();
        st.show(await savePrefs({ proHours: { ...prefs.proHours, days: next } }));
        paintDays();
      });
      days.append(b);
    });
  };
  paintDays();
  const start = timeInput(prefs.proHours.start, async (v) => st.show(await savePrefs({ proHours: { ...prefs.proHours, start: v } })));
  const end = timeInput(prefs.proHours.end, async (v) => st.show(await savePrefs({ proHours: { ...prefs.proHours, end: v } })));
  const recap = timeInput(prefs.eveningRecap, async (v) => st.show(await savePrefs({ eveningRecap: v })));

  const listField = (value: string[], placeholder: string, key: "platforms" | "streaming") => {
    const f = h("input", { type: "text", placeholder, spellcheck: "false", style: "flex:1 1 auto;min-width:0" }) as HTMLInputElement;
    f.value = listText(value);
    f.addEventListener("change", async () => st.show(await savePrefs({ [key]: parseList(f.value) } as Partial<Prefs>)));
    return f;
  };
  const zone = h("select", {}) as HTMLSelectElement;
  for (const [v, l] of [["", "—"], ["A", "Zone A"], ["B", "Zone B"], ["C", "Zone C"]]) zone.append(h("option", { value: v, text: l }));
  zone.value = prefs.schoolZone;
  zone.addEventListener("change", async () => st.show(await savePrefs({ schoolZone: zone.value as Prefs["schoolZone"] })));

  const city = h("input", { type: "text", placeholder: "ex. ta ville", spellcheck: "false", style: "flex:1 1 auto;min-width:0" }) as HTMLInputElement;
  city.value = prefs.ville;
  city.addEventListener("change", async () => st.show(await savePrefs({ ville: city.value.trim() })));

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Rythme et loisirs" })),
    h("div", { class: "hint", text: "Partagé avec la maison et les tâches planifiées, via le dossier de synchronisation." }),
    h("div", { class: "row" }, h("label", { text: "Heures pro" }), days),
    h("div", { class: "row" }, h("label", { text: "" }), h("span", { class: "hint", text: "de" }), start, h("span", { class: "hint", text: "à" }), end),
    h("div", { class: "hint small", text: "Pendant ces heures Nooky passe en mode pro (ambre), sinon en perso (menthe). Le bouton en haut de l'île bascule à la main jusqu'au prochain changement." }),
    h("div", { class: "row" }, h("label", { text: "Récap du soir" }), recap, h("span", { class: "hint", text: "les jours de travail" })),
    h("div", { class: "col" }, h("label", { text: "Mes plateformes de jeu" }), listField(prefs.platforms, "PS5, Switch, PC…", "platforms")),
    h("div", { class: "col" }, h("label", { text: "Mes services de streaming" }), listField(prefs.streaming, "Netflix, Disney+…", "streaming")),
    h("div", { class: "row" }, h("label", { text: "Zone scolaire" }), zone),
    h("div", { class: "row" }, h("label", { text: "Ville (météo)" }), city, h("span", { class: "hint", text: "vide = pas de météo" }), st.el),
  );
}

// ── Toi ───────────────────────────────────────────────────────────────────────

function textSetting(
  label: string, value: string, placeholder: string,
  onSave: (v: string) => string | null, multiline = false,
): HTMLElement {
  const field = (multiline
    ? h("textarea", { rows: "4", placeholder, spellcheck: "true" })
    : h("input", { type: "text", placeholder, spellcheck: "false" })) as HTMLInputElement | HTMLTextAreaElement;
  field.value = value;
  field.style.cssText = "flex:1 1 auto;min-width:0";
  const status = h("span", { class: "hint small" });
  field.addEventListener("change", () => {
    const err = onSave(field.value.trim());
    status.textContent = err ?? "Enregistré.";
    status.style.color = err ? "#ff8d97" : "";
    window.setTimeout(() => { status.textContent = ""; }, 2500);
  });
  return h("div", { class: multiline ? "col" : "row" }, h("label", { text: label }), field, status);
}

function youSection(): HTMLElement {
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Toi" })),
    textSetting("Ton prénom", settings.firstName ?? "", "Pour « Bonjour … ! »", (v) => {
      settings.firstName = v.slice(0, 40);
      void save();
      // The maison and the scheduled tasks greet you too.
      if (settings.firstName !== prefs.prenom) void savePrefs({ prenom: settings.firstName });
      return null;
    }),
    textSetting("Ce que Nooky doit savoir sur toi", settings.aboutMe ?? "",
      "Ton métier, tes projets, comment tu aimes qu'on te réponde… (envoyé à Claude avec tes questions)",
      (v) => {
        settings.aboutMe = v.slice(0, 4000);
        void save();
        return null;
      }, true),
    textSetting("Lien de la maison", settings.maisonUrl ?? "", "https://…", (v) => {
      if (v && !/^https?:\/\/\S+$/i.test(v)) return "Le lien doit commencer par https://";
      settings.maisonUrl = v;
      void save();
      return null;
    }),
    h("div", { class: "hint", text: "Sans lien, le bouton « Ouvrir la maison » n'apparaît pas." }),
  );
}

// ── Claude ────────────────────────────────────────────────────────────────────

function claudeSection(hasKey: boolean): HTMLElement {
  const dot = statusDot(hasKey);
  const state = h("div", { class: "hint" });
  const field = h("input", {
    type: "password",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const saveBtn = h("button", { class: "primary", text: "Enregistrer" });
  const clearBtn = h("button", { class: "danger", text: "Retirer" });
  const feedback = h("div", {});

  function paint(present: boolean) {
    dot.style.background = present ? "#34d399" : "#f4505e";
    state.textContent = present
      ? `Clé enregistrée dans ${keychainName()}. Elle ne touche jamais le disque.`
      : "Sans clé, Nooky gère ta journée et tes rappels ; la clé débloque le chat avec Claude.";
    field.placeholder = present ? "••••••••••••  (enregistrée)" : "sk-ant-…";
    clearBtn.style.display = present ? "" : "none";
  }

  async function refresh() {
    paint((await Bridge.secretPresent("anthropic-api-key")) ?? false);
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet("anthropic-api-key", value);
      field.value = "";
      feedback.append(notice("ok", "C'est enregistré."));
      await refresh();
      await save(); // lets the island notice the key
    } catch (err) {
      feedback.append(notice("err", `Impossible d'enregistrer : ${String(err)}`));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear("anthropic-api-key");
      feedback.append(notice("ok", "Clé retirée."));
      await refresh();
      await save();
    } catch (err) {
      feedback.append(notice("err", `Impossible de retirer la clé : ${String(err)}`));
    }
  });

  const model = h("select", {}) as HTMLSelectElement;
  for (const [id, label] of MODELS) model.append(h("option", { value: id, text: label }));
  if (!MODELS.some(([id]) => id === settings.model)) {
    model.append(h("option", { value: settings.model, text: settings.model }));
  }
  model.value = settings.model;
  model.addEventListener("change", () => {
    settings.model = model.value;
    void save();
  });

  paint(hasKey);

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "Claude" })),
    state,
    h("div", { class: "row" }, h("label", { text: "Clé API" }), field, saveBtn, clearBtn),
    h("div", { class: "row" }, h("label", { text: "Modèle" }), model),
    h("div", {
      class: "hint",
      html: "Crée une clé sur <b>console.anthropic.com</b> (API Keys) et fixe une limite de dépense mensuelle dans Billing.",
    }),
    feedback,
  );
}

// ── Sync folder ───────────────────────────────────────────────────────────────

function syncSection(initial: SyncInfo | null): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:10px" });
  const section = h("section", {}, h("h2", {}, h("span", { text: "Dossier de synchronisation" })), body);

  function draw(info: SyncInfo | null, message?: HTMLElement) {
    clear(body);
    if (!info) {
      body.append(h("div", { class: "hint", text: "Lance Nooky pour voir le dossier utilisé." }));
      return;
    }
    const modeLabel = info.mode === "drive" ? "Google Drive" : info.mode === "custom" ? "Dossier choisi" : "Local (cet appareil)";
    body.append(
      h("div", { class: "row" },
        h("label", { text: "Utilisé" }),
        h("span", { class: `badge ${info.mode}`, text: modeLabel }),
      ),
      h("div", { class: "path", text: info.dir }),
    );
    if (info.mode === "local") {
      body.append(notice("warn",
        "Google Drive pour ordinateur est introuvable : tes tâches restent sur cet appareil. Installe-le et connecte-toi, puis relance Nooky pour partager ta liste entre le Mac et le PC."));
    } else {
      body.append(h("div", {
        class: "hint",
        text: "Chaque appareil écrit son propre fichier dans ce dossier et lit ceux des autres : ta liste est la même partout.",
      }));
    }
    if (info.customError) body.append(notice("err", `Le dossier choisi n'est pas utilisable : ${info.customError}`));

    const pick = h("button", { text: "Choisir un autre dossier…" });
    pick.addEventListener("click", async () => {
      const dir = await pickFolder("Dossier de synchronisation de Nooky");
      if (dir) await apply(dir);
    });
    const actions = h("div", { class: "row" }, pick);
    if (info.mode === "custom") {
      const back = h("button", { text: info.detected ? "Revenir à Google Drive" : "Revenir au dossier automatique" });
      back.addEventListener("click", () => void apply(null));
      actions.append(back);
    }
    body.append(actions);

    // A text field too, in case the picker can't reach the folder.
    const field = h("input", {
      type: "text",
      placeholder: os === "windows" ? "G:\\Mon Drive\\Nooky" : "/Users/…/Mon Drive/Nooky",
      style: "flex:1 1 auto;min-width:0",
      spellcheck: "false",
    }) as HTMLInputElement;
    const use = h("button", { text: "Utiliser" });
    use.addEventListener("click", () => {
      const v = field.value.trim();
      if (v) void apply(v);
    });
    body.append(h("details", {},
      h("summary", { text: "Coller un chemin" }),
      h("div", { class: "row", style: "margin-top:8px" }, field, use),
    ));
    body.append(h("div", { class: "hint small", text: `Cet appareil : ${info.deviceName} — fichier ${info.ownFile}` }));
    if (message) body.append(message);
  }

  async function apply(dir: string | null) {
    try {
      const info = await Bridge.syncSetDir(dir);
      settings.syncDir = dir;
      draw(info, notice("ok", "C'est noté, Nooky relit le dossier."));
    } catch (err) {
      draw(await Bridge.syncInfo(), notice("err", String(err)));
    }
  }

  draw(initial);
  return section;
}

// ── General ───────────────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "1", step: "0.05",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const autoClose = h("input", {
    type: "number", min: "5", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: os === "macos" ? "Écran avec l'encoche (sinon le principal)" : "Écran principal" }),
    h("option", { value: "cursor", text: "Écran sous la souris" }),
  );
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Général" })),
    h("div", { class: "row" },
      h("label", { text: "Sons" }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" },
      h("label", { text: "Fermeture auto" }),
      autoClose,
      h("span", { class: "hint", text: "secondes après avoir quitté Nooky" }),
    ),
    h("div", { class: "row" }, h("label", { text: "Écran" }), screen),
    h("div", { class: "row" },
      h("label", { text: "Lancer au démarrage" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
  );
}

function aboutSection(): HTMLElement {
  const check = h("button", { text: "Rechercher une mise à jour" });
  const status = h("span", { class: "hint" });
  check.addEventListener("click", async () => {
    if (!IS_TAURI) return;
    await emit("check-update");
    status.textContent = "Nooky te répond en haut de l'écran.";
  });
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "À propos" })),
    h("div", { class: "row" }, h("span", { text: `Nooky Desktop ${version}` }), check, status),
    h("div", { class: "hint", text: "Nooky cherche aussi tout seul une nouvelle version au démarrage puis toutes les 6 heures." }),
    h("div", { class: "hint", text: "Nooky est basé sur Coucou de Louis Raillé (licence MIT)." }),
    h("div", { class: "hint", text: "Aucune télémétrie. Les seules requêtes réseau vont à l'API Claude, quand tu discutes." }),
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
    os = boot.os;
  }
  const hasKey = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
  const info = await Bridge.syncInfo();
  await loadPrefs();
  // First run with a prénom already set locally: share it.
  if (!prefs.prenom && (settings.firstName ?? "").trim()) void savePrefs({ prenom: settings.firstName.trim() });

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Réglages de Nooky" })),
    youSection(),
    rhythmSection(),
    claudeSection(hasKey),
    syncSection(info),
    generalSection(),
    aboutSection(),
  );

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
  });
}

void main();
