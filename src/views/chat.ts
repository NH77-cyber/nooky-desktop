// Chat with Claude. The bubble/typing/input layout is adapted from Coucou by
// Louis Raillé (MIT License, see LICENSE-COUCOU-MIT); quick capture, the free
// bridge through the maison (no API key), the quick actions on a dropped file
// or text and Nooky's thinking → talking → happy are Nooky's.
//
// With an API key, questions go straight to Claude (Rust side, the key never
// leaves the keychain). Without one, they go through the shared folder:
// ask-<deviceId>-<ms>.json → the maison answers in answer-<id>.json
// (SYNC-FORMAT.md §4).

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { renderMarkdown } from "./md";
import { Bridge, type ChatContext } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, maisonUrl, type ChatMessage } from "../core/state";
import { Mode } from "../core/mode";
import { Tasks, type CaptureResult } from "../tasks/store";
import { dayName, timeLabel } from "../tasks/parse";
import type { QuickKind, ViewActions, ViewHost } from "./views";

let nextId = 1;

/** No answer from the maison after this long: say it is probably closed. */
const BRIDGE_TIMEOUT_MS = 3 * 60_000;
/** With an API key as a safety net, don't wait that long for the maison. */
const BRIDGE_FALLBACK_MS = 45_000;

/** The question being answered by the maison, kept so the API key can take over if needed. */
let pendingFallback: { query: string; quick: QuickKind | null } | null = null;

const QUICK: Record<QuickKind, { label: string; prompt: string }> = {
  summary: { label: "Résumer", prompt: "Résume ce contenu en quelques points clairs." },
  reply: { label: "Répondre", prompt: "Rédige une réponse courte et chaleureuse à ce message, prête à envoyer." },
  translate: { label: "Traduire en anglais", prompt: "Traduis ce contenu en anglais, en gardant le ton." },
  tasks: {
    label: "Extraire les tâches",
    prompt: "Extrais les tâches à faire de ce contenu : une par ligne, chaque ligne commençant par « - », sans autre texte. Ajoute « demain » ou une heure seulement si le contenu le dit.",
  },
};

function bubble(message: ChatMessage, actions: ViewActions): HTMLElement {
  if (message.role === "user") {
    return h("div", { class: "chat-row user" }, h("div", { class: "bubble", text: message.content }));
  }
  if (message.role === "note") {
    const note = h("div", { class: "reply note" }, h("span", { text: message.content }));
    if (message.action) {
      const a = message.action;
      note.append(h("button", {
        class: "linkbtn note-act",
        text: a.label,
        onclick: (e: Event) => { e.stopPropagation(); a.run(); },
      }));
    }
    return h("div", { class: "chat-row" }, note);
  }
  const reply = h("div", { class: "reply" });
  if (message.markdown) reply.append(renderMarkdown(message.content, 80, (u) => actions.openUrl(u)));
  else reply.textContent = message.content;
  return h("div", { class: "chat-row" }, reply);
}

function typingDots(): HTMLElement {
  return h("div", { class: "chat-row" }, h("div", { class: "typing" }, h("i"), h("i"), h("i")));
}

/** The chip showing what the question is about (a dropped file or text). */
function contextChip(label: string): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

// ── The conversation (module level, so the drop card can start one) ─────────

let act: ViewActions | null = null;
let heightChanged: () => void = () => {};
let sending = false;

function push(role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}) {
  State.chatHistory.push({ id: nextId++, role, content, ...extra });
}

function done() {
  State.notify();
  heightChanged();
}

function undoAction(r: CaptureResult): ChatMessage["action"] {
  return {
    label: "Annuler",
    run: () => {
      void Tasks.undo(r);
      push("note", "C'est annulé.");
      done();
    },
  };
}

/** "+ texte", "courses : …", "abo …": written straight away, with an "Annuler". */
async function tryCapture(query: string): Promise<boolean> {
  const r = await Tasks.capture(query, { requirePlus: true });
  if (!r) {
    if (query.startsWith("+")) {
      push("user", query);
      push("note", "Écris la tâche après le « + », par exemple : + relancer le client demain 14h");
      done();
      return true;
    }
    return false;
  }
  push("user", query);
  const c = r.capture;
  const text = c.kind === "task" && !c.repeat
    ? `Noté pour ${dayName(c.day)}${c.time ? ` à ${timeLabel(c.time)}` : ""} : ${c.title}.`
    : `${r.summary}.`;
  push("note", text, { action: undoAction(r) });
  act?.emote("wink");
  Sound.play("proud");
  done();
  return true;
}

/** Extra context for Claude: date, mode, open tasks (+ prénom from the synced prefs when the local one is empty). */
function extraContext(): string {
  let s = Tasks.contextForChat();
  const prenom = Tasks.prefs.prenom;
  if (!(State.settings.firstName ?? "").trim() && prenom) s = `L'utilisateur s'appelle ${prenom}.\n${s}`;
  return s;
}

/** After an "Extraire les tâches" answer: offer to add the "- " lines as tasks. */
function offerTasks(text: string) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[-•*]\s+\S/.test(l)).map((l) => l.replace(/^[-•*]\s+/, "").replace(/\*\*/g, ""));
  if (!lines.length) return;
  push("note", `${lines.length} tâche${lines.length > 1 ? "s" : ""} trouvée${lines.length > 1 ? "s" : ""}.`, {
    action: {
      label: `Les ajouter à ma journée`,
      run: async () => {
        const added: CaptureResult[] = [];
        for (const l of lines.slice(0, 20)) {
          const r = await Tasks.capture(l, { tiroir: Mode.current() });
          if (r) added.push(r);
        }
        push("note", `${added.length} tâche${added.length > 1 ? "s" : ""} ajoutée${added.length > 1 ? "s" : ""}.`, {
          action: {
            label: "Annuler",
            run: () => {
              for (const r of added) void Tasks.undo(r);
              push("note", "C'est annulé.");
              done();
            },
          },
        });
        act?.emote("proud");
        done();
      },
    },
  });
}

async function viaKey(query: string, context: ChatContext | null, quick: QuickKind | null) {
  sending = true;
  State.stateOverride = "thinking";
  done();
  try {
    const reply = await Bridge.chatSend(query, context, extraContext());
    push("assistant", reply.text);
    if (quick === "tasks") offerTasks(reply.text);
    State.stateOverride = null;
    act?.talk(Math.min(4.5, 0.8 + reply.text.length / 90));
    Sound.play("done");
  } catch (err) {
    State.stateOverride = null;
    push("note", String(err).replace(/^Error:\s*/, ""));
    Sound.play("error");
    act?.emote("annoyed");
  } finally {
    sending = false;
    done();
  }
}

let pendingQuick: QuickKind | null = null;

async function viaBridge(text: string, quick: QuickKind | null, canFallback = false) {
  const history = State.chatHistory
    .filter((m): m is ChatMessage & { role: "user" | "assistant" } => m.role === "user" || m.role === "assistant")
    .slice(0, -1)
    .slice(-6)
    .map((m) => ({ role: m.role, content: m.content }));
  try {
    const id = await Bridge.syncAsk({ at: new Date().toISOString(), tiroir: Mode.current(), text, history });
    State.pendingAsk = { id, since: Date.now(), closedNoted: false };
    pendingQuick = quick;
    pendingFallback = canFallback ? { query: text, quick } : null;
    push("note", "Nooky transmet ta question à la maison…");
    State.stateOverride = "thinking";
  } catch (err) {
    push("note", `Je n'ai pas pu transmettre ta question : ${String(err).replace(/^Error:\s*/, "")}`);
    act?.emote("annoyed");
  }
  done();
}

/** Called on every sync: an answer arrived, or the maison is taking too long. */
function checkBridge() {
  const p = State.pendingAsk;
  if (!p) return;
  const a = Tasks.answers.get(p.id);
  if (a) {
    State.pendingAsk = null;
    const fb = pendingFallback;
    pendingFallback = null;
    if (a.needsWeb && fb && State.hasApiKey) {
      // The free path can't know recent facts: let the API key answer instead.
      pendingQuick = null;
      push("note", "Cette question demande internet : j'utilise ta clé API.");
      void viaKey(fb.query, null, fb.quick);
      return;
    }
    if (a.needsWeb && !State.hasApiKey) {
      push("note", "Cette réponse n'est peut-être pas à jour : pour les questions qui demandent internet, ajoute une clé API.",
        { action: { label: "Ajouter une clé", run: () => act?.openSettingsWindow() } });
    }
    push("assistant", a.text, { markdown: true });
    if (pendingQuick === "tasks") offerTasks(a.text);
    pendingQuick = null;
    if (State.stateOverride === "thinking") State.stateOverride = null;
    act?.talk(Math.min(4.5, 0.8 + a.text.length / 90));
    Sound.play("done");
    if (State.view !== "prompt" || State.mode !== "expanded") act?.setView("prompt");
    done();
    return;
  }
  const waitMs = pendingFallback ? BRIDGE_FALLBACK_MS : BRIDGE_TIMEOUT_MS;
  if (!p.closedNoted && Date.now() - p.since > waitMs) {
    p.closedNoted = true;
    const fb = pendingFallback;
    pendingFallback = null;
    if (fb && State.hasApiKey) {
      pendingQuick = null;
      push("note", "La maison ne répond pas : j'utilise ta clé API.");
      void viaKey(fb.query, null, fb.quick);
      return;
    }
    if (State.stateOverride === "thinking") State.stateOverride = null;
    const url = maisonUrl();
    push("note", "La maison ne répond pas. Ouvre-la dans ton navigateur : elle répond dès qu'elle est ouverte, même en arrière-plan. Tu peux aussi ajouter une clé API.",
      url ? { action: { label: "Ouvrir la maison", run: () => act?.openUrl(url) } } : { action: { label: "Ajouter une clé", run: () => act?.openSettingsWindow() } });
    act?.emote("yawn");
    done();
  }
}

/** One question: capture first, then Claude (key) or the maison (bridge). */
export async function ask(query: string, opts: { quick?: QuickKind; context?: ChatContext | null; shown?: string } = {}) {
  if (sending) return;
  if (!opts.quick && (await tryCapture(query))) return;
  State.hasApiKey = (await Bridge.secretPresent("anthropic-api-key")) ?? State.hasApiKey;
  Sound.play("send");
  push("user", opts.shown ?? query);
  const file = State.droppedFile;
  const firstTurn = !State.chatHistory.some((m) => m.role === "assistant");
  const context = opts.context !== undefined ? opts.context : firstTurn && file ? { kind: "file" as const, name: file.name, path: file.path } : null;
  // The maison can only be reached through the shared Drive folder: a device on a local-only folder has no way to ask it.
  const bridgeReachable = Tasks.info?.mode !== "local";
  // Files and images need the API key; so does a device that can't reach the maison. Everything else goes free first.
  if (State.hasApiKey && (context || !bridgeReachable)) {
    await viaKey(query, context, opts.quick ?? null);
    return;
  }
  if (!bridgeReachable) {
    push("note", "Cet ordinateur n'est pas relié à ton Google Drive, donc je ne peux pas joindre la maison. Installe Google Drive pour ordinateur (ou choisis le dossier Nooky dans les Réglages), ou ajoute une clé API.",
      { action: { label: "Ouvrir les Réglages", run: () => act?.openSettingsWindow() } });
    act?.emote("annoyed");
    done();
    return;
  }
  if (State.pendingAsk && !State.pendingAsk.closedNoted) {
    push("note", "J'attends encore la réponse de la maison à ta question précédente.");
    done();
    return;
  }
  await viaBridge(query, opts.quick ?? null, State.hasApiKey);
}

/** Quick action on the dropped file or text (Résumer, Répondre, Traduire, Extraire les tâches). */
export async function askAbout(kind: QuickKind) {
  const q = QUICK[kind];
  const text = State.droppedText;
  const file = State.droppedFile;
  State.chatHistory = [];
  void Bridge.chatReset();
  act?.setView("prompt");
  State.hasApiKey = (await Bridge.secretPresent("anthropic-api-key")) ?? State.hasApiKey;
  if (text) {
    await ask(`${q.prompt}\n\nTexte :\n${text}`, { quick: kind, context: null, shown: `${q.label} · ton texte` });
    return;
  }
  if (!file) return;
  if (State.hasApiKey) {
    await ask(q.prompt, { quick: kind, context: { kind: "file", name: file.name, path: file.path }, shown: `${q.label} · ${file.name}` });
    return;
  }
  // Bridge: only the text of small text files can travel.
  try {
    const content = await Bridge.caughtText(file.path);
    await ask(`${q.prompt}\n\nFichier « ${file.name} » :\n${content}`, { quick: kind, context: null, shown: `${q.label} · ${file.name}` });
  } catch (err) {
    push("user", `${q.label} · ${file.name}`);
    push("note", `Sans clé API, je ne peux transmettre à la maison que le texte des fichiers texte de 20 Ko au plus (${String(err).replace(/^Error:\s*/, "")}). Ajoute une clé API pour les PDF, les images et les gros fichiers.`,
      { action: { label: "Ajouter une clé", run: () => act?.openSettingsWindow() } });
    act?.emote("annoyed");
    done();
  }
}

export function buildPrompt(actions: ViewActions, onHeightChange: () => void): ViewHost {
  act = actions;
  heightChanged = onHeightChange;
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const nokeyText = h("span", { text: "Je passe d'abord par la maison (gratuit, elle doit être ouverte). Une clé API sert de secours." });
  const nokey = h(
    "div",
    { class: "nokey" },
    nokeyText,
    h("button", { class: "linkbtn", text: "Ajouter une clé", onclick: (e: Event) => { e.stopPropagation(); actions.openSettingsWindow(); } }),
  );
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Pose ta question… (« + » tâche, « courses : », « abo »)",
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: "Envoyer" }, svg(ICONS.arrowUp, 11));
  const bar = h("div", { class: "chat-bar" }, input, send);

  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card wash chat-card" }, h("div", { class: "chat-body" }, chipRow, nokey, log, bar)),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(150,160,190,0.22)");

  let renderedKey = "";
  window.setInterval(() => {
    if (State.pendingAsk) checkBridge();
  }, 5000);

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    input.value = "";
    await ask(query);
    input.focus();
  }

  send.addEventListener("click", (e) => {
    e.stopPropagation();
    void submit();
  });
  input.addEventListener("pointerdown", () => actions.wantKeyboard(true));
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      void submit();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });

  return {
    el,
    sync() {
      checkBridge();
      const file = State.droppedFile;
      const wantChip = State.droppedText ? "Ton texte" : file?.name ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) chipRow.append(contextChip(wantChip));
      }
      nokey.style.display = State.hasApiKey || State.chatHistory.length ? "none" : "";

      const thinking = State.stateOverride === "thinking";
      const key = `${State.chatHistory.length}:${thinking}`;
      if (key !== renderedKey) {
        renderedKey = key;
        clear(log);
        for (const m of State.chatHistory) log.append(bubble(m, actions));
        if (thinking) log.append(typingDots());
        log.scrollTop = log.scrollHeight;
      }

      input.placeholder = State.chatHistory.length === 0
        ? "Pose ta question… (« + » tâche, « courses : », « abo »)"
        : "Continue…";
      input.disabled = sending;
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
// Chat with Claude. The bubble/typing/input layout is adapted from Coucou by
// Louis Raillé (MIT License, see LICENSE-COUCOU-MIT); quick capture, the free
// bridge through the maison (no API key), the quick actions on a dropped file
// or text and Nooky's thinking → talking → happy are Nooky's.
//
// With an API key, questions go straight to Claude (Rust side, the key never
// leaves the keychain). Without one, they go through the shared folder:
// ask-<deviceId>-<ms>.json → the maison answers in answer-<id>.json
// (SYNC-FORMAT.md §4).

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { renderMarkdown } from "./md";
import { Bridge, type ChatContext } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, maisonUrl, type ChatMessage } from "../core/state";
import { Mode } from "../core/mode";
import { Tasks, type CaptureResult } from "../tasks/store";
import { dayName, timeLabel } from "../tasks/parse";
import type { QuickKind, ViewActions, ViewHost } from "./views";

let nextId = 1;

/** No answer from the maison after this long: say it is probably closed. */
const BRIDGE_TIMEOUT_MS = 3 * 60_000;

const QUICK: Record<QuickKind, { label: string; prompt: string }> = {
  summary: { label: "Résumer", prompt: "Résume ce contenu en quelques points clairs." },
  reply: { label: "Répondre", prompt: "Rédige une réponse courte et chaleureuse à ce message, prête à envoyer." },
  translate: { label: "Traduire en anglais", prompt: "Traduis ce contenu en anglais, en gardant le ton." },
  tasks: {
    label: "Extraire les tâches",
    prompt: "Extrais les tâches à faire de ce contenu : une par ligne, chaque ligne commençant par « - », sans autre texte. Ajoute « demain » ou une heure seulement si le contenu le dit.",
  },
};

function bubble(message: ChatMessage, actions: ViewActions): HTMLElement {
  if (message.role === "user") {
    return h("div", { class: "chat-row user" }, h("div", { class: "bubble", text: message.content }));
  }
  if (message.role === "note") {
    const note = h("div", { class: "reply note" }, h("span", { text: message.content }));
    if (message.action) {
      const a = message.action;
      note.append(h("button", {
        class: "linkbtn note-act",
        text: a.label,
        onclick: (e: Event) => { e.stopPropagation(); a.run(); },
      }));
    }
    return h("div", { class: "chat-row" }, note);
  }
  const reply = h("div", { class: "reply" });
  if (message.markdown) reply.append(renderMarkdown(message.content, 80, (u) => actions.openUrl(u)));
  else reply.textContent = message.content;
  return h("div", { class: "chat-row" }, reply);
}

function typingDots(): HTMLElement {
  return h("div", { class: "chat-row" }, h("div", { class: "typing" }, h("i"), h("i"), h("i")));
}

/** The chip showing what the question is about (a dropped file or text). */
function contextChip(label: string): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

// ── The conversation (module level, so the drop card can start one) ─────────

let act: ViewActions | null = null;
let heightChanged: () => void = () => {};
let sending = false;

function push(role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}) {
  State.chatHistory.push({ id: nextId++, role, content, ...extra });
}

function done() {
  State.notify();
  heightChanged();
}

function undoAction(r: CaptureResult): ChatMessage["action"] {
  return {
    label: "Annuler",
    run: () => {
      void Tasks.undo(r);
      push("note", "C'est annulé.");
      done();
    },
  };
}

/** "+ texte", "courses : …", "abo …": written straight away, with an "Annuler". */
async function tryCapture(query: string): Promise<boolean> {
  const r = await Tasks.capture(query, { requirePlus: true });
  if (!r) {
    if (query.startsWith("+")) {
      push("user", query);
      push("note", "Écris la tâche après le « + », par exemple : + relancer le client demain 14h");
      done();
      return true;
    }
    return false;
  }
  push("user", query);
  const c = r.capture;
  const text = c.kind === "task" && !c.repeat
    ? `Noté pour ${dayName(c.day)}${c.time ? ` à ${timeLabel(c.time)}` : ""} : ${c.title}.`
    : `${r.summary}.`;
  push("note", text, { action: undoAction(r) });
  act?.emote("wink");
  Sound.play("proud");
  done();
  return true;
}

/** Extra context for Claude: date, mode, open tasks (+ prénom from the synced prefs when the local one is empty). */
function extraContext(): string {
  let s = Tasks.contextForChat();
  const prenom = Tasks.prefs.prenom;
  if (!(State.settings.firstName ?? "").trim() && prenom) s = `L'utilisateur s'appelle ${prenom}.\n${s}`;
  return s;
}

/** After an "Extraire les tâches" answer: offer to add the "- " lines as tasks. */
function offerTasks(text: string) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[-•*]\s+\S/.test(l)).map((l) => l.replace(/^[-•*]\s+/, "").replace(/\*\*/g, ""));
  if (!lines.length) return;
  push("note", `${lines.length} tâche${lines.length > 1 ? "s" : ""} trouvée${lines.length > 1 ? "s" : ""}.`, {
    action: {
      label: `Les ajouter à ma journée`,
      run: async () => {
        const added: CaptureResult[] = [];
        for (const l of lines.slice(0, 20)) {
          const r = await Tasks.capture(l, { tiroir: Mode.current() });
          if (r) added.push(r);
        }
        push("note", `${added.length} tâche${added.length > 1 ? "s" : ""} ajoutée${added.length > 1 ? "s" : ""}.`, {
          action: {
            label: "Annuler",
            run: () => {
              for (const r of added) void Tasks.undo(r);
              push("note", "C'est annulé.");
              done();
            },
          },
        });
        act?.emote("proud");
        done();
      },
    },
  });
}

async function viaKey(query: string, context: ChatContext | null, quick: QuickKind | null) {
  sending = true;
  State.stateOverride = "thinking";
  done();
  try {
    const reply = await Bridge.chatSend(query, context, extraContext());
    push("assistant", reply.text);
    if (quick === "tasks") offerTasks(reply.text);
    State.stateOverride = null;
    act?.talk(Math.min(4.5, 0.8 + reply.text.length / 90));
    Sound.play("done");
  } catch (err) {
    State.stateOverride = null;
    push("note", String(err).replace(/^Error:\s*/, ""));
    Sound.play("error");
    act?.emote("annoyed");
  } finally {
    sending = false;
    done();
  }
}

let pendingQuick: QuickKind | null = null;

async function viaBridge(text: string, quick: QuickKind | null) {
  const history = State.chatHistory
    .filter((m): m is ChatMessage & { role: "user" | "assistant" } => m.role === "user" || m.role === "assistant")
    .slice(0, -1)
    .slice(-6)
    .map((m) => ({ role: m.role, content: m.content }));
  try {
    const id = await Bridge.syncAsk({ at: new Date().toISOString(), tiroir: Mode.current(), text, history });
    State.pendingAsk = { id, since: Date.now(), closedNoted: false };
    pendingQuick = quick;
    push("note", "Nooky transmet ta question à la maison…");
    State.stateOverride = "thinking";
  } catch (err) {
    push("note", `Je n'ai pas pu transmettre ta question : ${String(err).replace(/^Error:\s*/, "")}`);
    act?.emote("annoyed");
  }
  done();
}

/** Called on every sync: an answer arrived, or the maison is taking too long. */
function checkBridge() {
  const p = State.pendingAsk;
  if (!p) return;
  const a = Tasks.answers.get(p.id);
  if (a) {
    State.pendingAsk = null;
    push("assistant", a.text, { markdown: true });
    if (pendingQuick === "tasks") offerTasks(a.text);
    pendingQuick = null;
    if (State.stateOverride === "thinking") State.stateOverride = null;
    act?.talk(Math.min(4.5, 0.8 + a.text.length / 90));
    Sound.play("done");
    if (State.view !== "prompt" || State.mode !== "expanded") act?.setView("prompt");
    done();
    return;
  }
  if (!p.closedNoted && Date.now() - p.since > BRIDGE_TIMEOUT_MS) {
    p.closedNoted = true;
    if (State.stateOverride === "thinking") State.stateOverride = null;
    const url = maisonUrl();
    push("note", "La maison est fermée : ouvre-la pour que je puisse te répondre (ou ajoute une clé API).",
      url ? { action: { label: "Ouvrir la maison", run: () => act?.openUrl(url) } } : { action: { label: "Ajouter une clé", run: () => act?.openSettingsWindow() } });
    act?.emote("yawn");
    done();
  }
}

/** One question: capture first, then Claude (key) or the maison (bridge). */
export async function ask(query: string, opts: { quick?: QuickKind; context?: ChatContext | null; shown?: string } = {}) {
  if (sending) return;
  if (!opts.quick && (await tryCapture(query))) return;
  State.hasApiKey = (await Bridge.secretPresent("anthropic-api-key")) ?? State.hasApiKey;
  Sound.play("send");
  push("user", opts.shown ?? query);
  if (State.hasApiKey) {
    const file = State.droppedFile;
    const firstTurn = !State.chatHistory.some((m) => m.role === "assistant");
    const context = opts.context !== undefined ? opts.context : firstTurn && file ? { kind: "file" as const, name: file.name, path: file.path } : null;
    await viaKey(query, context, opts.quick ?? null);
  } else {
    if (State.pendingAsk && !State.pendingAsk.closedNoted) {
      push("note", "J'attends encore la réponse de la maison à ta question précédente.");
      done();
      return;
    }
    await viaBridge(query, opts.quick ?? null);
  }
}

/** Quick action on the dropped file or text (Résumer, Répondre, Traduire, Extraire les tâches). */
export async function askAbout(kind: QuickKind) {
  const q = QUICK[kind];
  const text = State.droppedText;
  const file = State.droppedFile;
  State.chatHistory = [];
  void Bridge.chatReset();
  act?.setView("prompt");
  State.hasApiKey = (await Bridge.secretPresent("anthropic-api-key")) ?? State.hasApiKey;
  if (text) {
    await ask(`${q.prompt}\n\nTexte :\n${text}`, { quick: kind, context: null, shown: `${q.label} · ton texte` });
    return;
  }
  if (!file) return;
  if (State.hasApiKey) {
    await ask(q.prompt, { quick: kind, context: { kind: "file", name: file.name, path: file.path }, shown: `${q.label} · ${file.name}` });
    return;
  }
  // Bridge: only the text of small text files can travel.
  try {
    const content = await Bridge.caughtText(file.path);
    await ask(`${q.prompt}\n\nFichier « ${file.name} » :\n${content}`, { quick: kind, context: null, shown: `${q.label} · ${file.name}` });
  } catch (err) {
    push("user", `${q.label} · ${file.name}`);
    push("note", `Sans clé API, je ne peux transmettre à la maison que le texte des fichiers texte de 20 Ko au plus (${String(err).replace(/^Error:\s*/, "")}). Ajoute une clé API pour les PDF, les images et les gros fichiers.`,
      { action: { label: "Ajouter une clé", run: () => act?.openSettingsWindow() } });
    act?.emote("annoyed");
    done();
  }
}

export function buildPrompt(actions: ViewActions, onHeightChange: () => void): ViewHost {
  act = actions;
  heightChanged = onHeightChange;
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const nokeyText = h("span", { text: "Sans clé API, je passe tes questions à la maison (gratuit, il faut qu'elle soit ouverte)." });
  const nokey = h(
    "div",
    { class: "nokey" },
    nokeyText,
    h("button", { class: "linkbtn", text: "Ajouter une clé", onclick: (e: Event) => { e.stopPropagation(); actions.openSettingsWindow(); } }),
  );
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Pose ta question… (« + » tâche, « courses : », « abo »)",
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: "Envoyer" }, svg(ICONS.arrowUp, 11));
  const bar = h("div", { class: "chat-bar" }, input, send);

  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card wash chat-card" }, h("div", { class: "chat-body" }, chipRow, nokey, log, bar)),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(150,160,190,0.22)");

  let renderedKey = "";
  window.setInterval(() => {
    if (State.pendingAsk) checkBridge();
  }, 5000);

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    input.value = "";
    await ask(query);
    input.focus();
  }

  send.addEventListener("click", (e) => {
    e.stopPropagation();
    void submit();
  });
  input.addEventListener("pointerdown", () => actions.wantKeyboard(true));
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      void submit();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });

  return {
    el,
    sync() {
      checkBridge();
      const file = State.droppedFile;
      const wantChip = State.droppedText ? "Ton texte" : file?.name ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) chipRow.append(contextChip(wantChip));
      }
      nokey.style.display = State.hasApiKey || State.chatHistory.length ? "none" : "";

      const thinking = State.stateOverride === "thinking";
      const key = `${State.chatHistory.length}:${thinking}`;
      if (key !== renderedKey) {
        renderedKey = key;
        clear(log);
        for (const m of State.chatHistory) log.append(bubble(m, actions));
        if (thinking) log.append(typingDots());
        log.scrollTop = log.scrollHeight;
      }

      input.placeholder = State.chatHistory.length === 0
        ? "Pose ta question… (« + » tâche, « courses : », « abo »)"
        : "Continue…";
      input.disabled = sending;
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
