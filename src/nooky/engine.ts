// Nooky — the little cloud that lives in the island ("nuage épuré").
//
// The engine contract (state names, emotes, slap → annoyed and three slaps →
// dizzy, blink, look-at-cursor, particles, the `busy` flag that lets the
// island stop its frame loop) follows Coucou by Louis Raillé — MIT License,
// Copyright (c) 2026 Louis Raillé, see LICENSE-COUCOU-MIT.
// The character itself — the three-lobed cloud, its ink eyes, its rare mouth,
// the arms that only come out to wave or to raise an alert, its colours,
// gestures and idle life — is Nooky's own design (Nooky Desktop, original
// artwork; reference page: nooky_nuage_epure.html).

import { clamp, lerp, Spring } from "../core/anim";
import { Sound } from "../core/sound";
import type { BotEmoteName, BotStateName } from "../core/layout";

// ── Types ─────────────────────────────────────────────────────────────────────

export type EyeShape = "rond" | "content" | "dodo" | "agace" | "mi" | "spirale" | "grand" | "clin";
export type MouthShape = "parle" | "o" | "sourire" | "moue" | "baille" | "plat";
/** Faint idle tint per weekday (Sun…Sat). */
const MOOD: readonly RGB[] = [
  [255, 190, 150], [150, 190, 255], [170, 235, 190], [255, 220, 150], [200, 170, 255], [255, 170, 200], [170, 225, 255],
];

export type Gesture = "coucou" | "bravo" | "etire" | "saut" | "clin" | "epaules" | "attrape" | "baille";
export type BadgeKind = "dots" | "bang" | "question";

/** RGB, 0…255. */
export type RGB = readonly [number, number, number];

interface StateCfg {
  /** Colour rising from the bottom of the body, or none. */
  tint: RGB | null;
  eye: EyeShape;
  /** Nooky has no mouth at rest: only some states open one. */
  mouth: MouthShape | null;
  badge: BadgeKind | null;
  /** Both arms up, shaking (alerts only). */
  arms?: boolean;
  bounces?: boolean;
  scans?: boolean;
  look?: readonly [number, number];
  tilt?: number;
  zz?: boolean;
  sleepy?: boolean;
  dizzy?: boolean;
  shake?: boolean;
}

interface Particle {
  k: "s" | "h" | "z" | "d";
  x: number; y: number; vx: number; vy: number;
  a: number; l: number; r: number;
}

// ── Palette ───────────────────────────────────────────────────────────────────

const INK = "#1c1e27";
const TOP = "#f6f6f9";
const BOT = "#b7bccb";
const HEART = "#e8798f";

const TINT = {
  alerte: [245, 166, 35] as RGB,
  content: [52, 211, 153] as RGB,
  reflechit: [139, 92, 246] as RGB,
  parle: [96, 165, 250] as RGB,
  dodo: [120, 130, 160] as RGB,
  etourdi: [236, 112, 170] as RGB,
};

/** The island's state names, drawn the Nooky way. */
export const BOT_STATES: Record<BotStateName, StateCfg> = {
  idle: { tint: null, eye: "rond", mouth: null, badge: null },
  working: { tint: TINT.parle, eye: "rond", mouth: null, badge: "dots" },
  thinking: { tint: TINT.reflechit, eye: "rond", mouth: null, badge: "dots", look: [0.5, 0.45], tilt: -0.1 },
  searching: { tint: TINT.parle, eye: "rond", mouth: null, badge: "dots", scans: true },
  approval: { tint: TINT.alerte, eye: "grand", mouth: "o", badge: "bang", arms: true, bounces: true },
  question: { tint: TINT.parle, eye: "rond", mouth: null, badge: "question", tilt: 0.14 },
  error: { tint: TINT.alerte, eye: "mi", mouth: null, badge: null, shake: true },
  finished: { tint: TINT.content, eye: "content", mouth: null, badge: null },
  ratelimit: { tint: TINT.alerte, eye: "mi", mouth: null, badge: null },
  sleeping: { tint: TINT.dodo, eye: "dodo", mouth: null, badge: null, zz: true, sleepy: true, look: [0, -0.12], tilt: 0.1 },
  dizzy: { tint: TINT.etourdi, eye: "spirale", mouth: null, badge: null, dizzy: true },
};

/** State → sound name played by the island when the state changes. */
export const STATE_SOUND: Partial<Record<BotStateName, string>> = {
  approval: "reminder", error: "error", finished: "done", dizzy: "dizzy",
};

// ── Small helpers ─────────────────────────────────────────────────────────────

const now = () => performance.now() / 1000;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const inOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export function hexToRGB(hex: string): RGB {
  const v = parseInt(hex.replace("#", ""), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const FONT = `ui-rounded, "SF Pro Rounded", system-ui, "Segoe UI Variable Text", "Segoe UI", sans-serif`;

/** The body: three soft lobes over a rounded base, in units of R. */
export const LOBES: readonly (readonly [number, number, number])[] = [
  [0, -0.32, 0.56], [-0.5, -0.02, 0.42], [0.5, -0.02, 0.42],
];
export const BASE = { x: -0.82, y: -0.02, w: 1.64, h: 0.6, r: 0.3 } as const;

/** Visual centre of the body relative to its origin, in units of R. */
export const CLOUD_CENTER_Y = -0.15;

/** Arms: capsules attached at the shoulders, drawn behind the body. */
const ARM = { len: 0.46, w: 0.16, sx: 0.86, sy: 0.26 } as const;

const IDLE_EVERY = 4.5;

// ── Engine ────────────────────────────────────────────────────────────────────

export class BotEngine {
  state: BotStateName = "idle";
  cfg: StateCfg = BOT_STATES.idle;

  // Gaze (yaw/pitch on the face sphere) and blink.
  yaw = 0;
  pitch = 0;
  private ty = 0;
  private tp = 0;
  open = 1;
  private nextBlink = now() + 2;
  private blinkAt = -9;

  // Body springs (Spring(response, damping): response = 1 / frequency).
  private sx = new Spring(1, 1 / 2.6, 0.38);
  private sy = new Spring(1, 1 / 2.6, 0.38);
  private oy = new Spring(0, 1 / 2.2, 0.45);
  private ox = new Spring(0, 1 / 3, 0.4);
  private tiltS = new Spring(0, 1 / 1.6, 0.6);
  private armVis = new Spring(0, 1 / 2.4, 0.5);
  private armL = new Spring(0.25, 1 / 2.4, 0.42);
  private armR = new Spring(0.25, 1 / 2.4, 0.42);
  private badgeS = new Spring(0, 0.3, 0.6);
  private float = 0;

  /** Focus progress 0…1 drawn as a ring around Nooky; -1 = off. */
  focusRing = -1;
  private tint: RGB = [0, 0, 0];
  private tintA = 0;
  private blush = 0;
  /** Eye scale: the island sets tgEs = 1.08 while the cursor rests on Nooky. */
  es = 1;
  tgEs = 1;

  eyeOverride: EyeShape | null = null;
  eyeOverrideUntil = 0;
  mouthOverride: MouthShape | null = null;
  mouthOverrideUntil = 0;
  private mouthStart = 0;

  gesture: Gesture | null = null;
  private gestureAt = 0;
  private badge: BadgeKind | null = null;

  private particles: Particle[] = [];
  private later: { at: number; fn: () => void }[] = [];
  private slapTimes: number[] = [];
  private loveUntil = 0;
  private lastHeart = 0;
  private lastZ = 0;
  private lookHold = 0;
  private glanceAt = 0;
  private lastLook = { x: 9, y: 9, at: now() };
  private nextIdle = now() + IDLE_EVERY;

  private t0 = now() - Math.random() * 5;
  private t = 0;
  private n = now();

  /** Extra canvas height above the body so particles can fly out without clipping. */
  particleOverhang = 0;
  /** Gentle float + idle life (hops, stretches…). The island turns it on when expanded. */
  floatOn = false;
  /** Mouth opens and closes while Nooky reads an answer out. */
  talking = false;
  /** A file is held over the island: wide eyes, round mouth. */
  anticipating = false;
  /** Focus mode: half-closed eyes, slow breathing, no idle life. */
  calm = false;
  /** Draw the ground shadow (off while the greeting's Nooky is still falling). */
  ground = true;
  /** Subtle colour of the ground shadow (pro / perso accent), or null. */
  groundTint: RGB | null = null;

  /** Cursor direction from the island, −1…1 each. */
  lookX = 0;
  lookY = 0;

  /** Fired when three slaps land inside 1.7 s (→ dizzy + confused view). */
  onDizzy: (() => void) | null = null;

  // ── Public API ──────────────────────────────────────────────────────────────

  setState(next: BotStateName, force = false) {
    if (this.state === next && !force) return;
    this.state = next;
    this.cfg = BOT_STATES[next];
    switch (next) {
      case "approval":
        this.kick(-0.25, 0.82, 1.14);
        break;
      case "finished":
        this.play("bravo");
        break;
      case "error":
      case "ratelimit":
        this.ox.velocity += 3.2;
        this.emit("sweat", 1);
        break;
      default:
        this.blink();
    }
  }

  setEye(e: EyeShape, seconds: number) {
    this.eyeOverride = e;
    this.eyeOverrideUntil = now() + seconds;
  }

  setMouth(m: MouthShape, seconds: number) {
    this.mouthOverride = m;
    this.mouthOverrideUntil = now() + seconds;
    this.mouthStart = now();
  }

  blink() {
    this.blinkAt = now();
  }

  /** A quick squash-and-stretch (springs released from a squashed pose). */
  squash(sy = 0.82, sx = 1.14) {
    this.sy.value = sy;
    this.sx.value = sx;
  }

  kick(oy: number, sy: number, sx: number) {
    this.oy.velocity += oy * -18;
    this.sy.value = sy;
    this.sx.value = sx;
  }

  /** Landing after the greeting's fall. */
  land() {
    this.sy.value = 0.72;
    this.sx.value = 1.26;
  }

  hop() {
    this.play("saut");
  }

  /** One of the reference gestures. */
  play(g: Gesture) {
    const n = now();
    this.gesture = g;
    this.gestureAt = n;
    switch (g) {
      case "saut":
        this.sy.value = 0.8;
        this.sx.value = 1.15;
        this.after(0.12, () => {
          this.oy.velocity -= 6.5;
          this.sy.value = 1.12;
          this.sx.value = 0.9;
        });
        break;
      case "clin":
        this.setEye("clin", 0.6);
        this.tiltS.velocity += 1.6;
        break;
      case "baille":
        this.setMouth("baille", 1.4);
        this.setEye("dodo", 1.4);
        break;
      case "bravo":
        this.setEye("content", 2.2);
        this.setMouth("sourire", 2.2);
        this.burst(6);
        break;
      case "coucou":
        this.setEye("content", 1.9);
        this.setMouth("sourire", 1.9);
        break;
      case "attrape":
        this.setMouth("o", 0.9);
        this.setEye("grand", 0.9);
        this.after(0.7, () => {
          this.sy.value = 0.72;
          this.sx.value = 1.25;
          this.setEye("content", 1.2);
          this.burst(4);
        });
        break;
      case "epaules":
        this.setMouth("plat", 1.3);
        this.setEye("mi", 1.3);
        break;
      case "etire":
        break;
    }
  }

  /** A poke. Two in a row: annoyed. Three within 1.7 s: dizzy. */
  slap() {
    this.interruptGreet();
    if (this.state === "dizzy") return;
    const t = now();
    this.slapTimes = this.slapTimes.filter((s) => t - s < 1.7);
    this.slapTimes.push(t);
    Sound.play("poke");
    this.squash();
    this.tiltS.velocity += rand(-2, 2);
    if (this.slapTimes.length >= 3) {
      this.slapTimes = [];
      this.onDizzy?.();
    } else {
      this.setEye("agace", 0.8);
      this.setMouth("moue", 0.8);
    }
  }

  /** Waves the right arm (the arms come out only for this and for alerts), happy eyes, smile. */
  greet(withSound = true) {
    this.play("coucou");
    this.oy.velocity += 1.4;
    if (withSound) this.after(0.25, () => Sound.play("greet"));
  }

  interruptGreet() {
    if (this.gesture === "coucou") this.gesture = null;
  }

  triggerEmote(emote: BotEmoteName, duration = 1.8) {
    const n = now();
    switch (emote) {
      case "love":
        // The hover hug: blush, happy eyes and a small heart.
        this.loveUntil = n + Math.max(1.2, duration);
        this.lastHeart = 0;
        this.setEye("content", Math.max(1.2, duration));
        break;
      case "surprised":
        this.setEye("grand", duration * 0.7);
        this.setMouth("o", duration * 0.7);
        this.kick(-0.3, 0.86, 1.1);
        break;
      case "proud":
        this.play("bravo");
        break;
      case "wink":
        this.play("clin");
        break;
      case "yawn":
        this.play("baille");
        break;
      case "happy":
        this.setEye("content", duration);
        break;
      case "annoyed":
        this.setEye("agace", 0.8);
        this.setMouth("moue", 0.8);
        break;
    }
  }

  /** A file lands on Nooky: big squash, round mouth, then happy eyes and sparks. */
  dropReaction() {
    this.anticipating = false;
    this.setMouth("o", 0.45);
    this.sy.value = 0.66;
    this.sx.value = 1.3;
    this.oy.velocity -= 3;
    this.burst(5);
    this.after(0.4, () => this.setEye("content", 1.4));
  }

  /** A file is held over the island. */
  anticipate(on: boolean) {
    this.anticipating = on;
    if (on) this.oy.velocity -= 2;
  }

  emit(type: "heart" | "star" | "spark" | "sweat" | "z", count: number) {
    if (type === "star" || type === "spark") {
      this.burst(count);
      return;
    }
    for (let i = 0; i < count; i++) {
      if (type === "heart") this.parts({ k: "h", x: rand(-0.3, 0.3), y: -0.8, vx: rand(-0.1, 0.1), vy: -0.35, a: -i * 0.2, l: 1.5, r: 0 });
      else if (type === "z") this.parts({ k: "z", x: 0.65, y: -0.55, vx: 0.15, vy: -0.33, a: -i * 0.4, l: 2.4, r: 0 });
      else this.parts({ k: "d", x: 0.62, y: -0.5, vx: 0.05, vy: 0.25, a: -i * 0.3, l: 1.1, r: 0 });
    }
  }

  /** True while anything is still moving — lets the island stop its frame loop. */
  get busy(): boolean {
    const n = this.n;
    const c = this.cfg;
    const springs = [this.sx, this.sy, this.oy, this.ox, this.tiltS, this.armVis, this.armL, this.armR, this.badgeS];
    return (
      this.floatOn || this.talking || this.anticipating ||
      this.gesture != null || this.particles.length > 0 || this.later.length > 0 ||
      !!(c.arms || c.bounces || c.scans || c.zz || c.dizzy) ||
      this.loveUntil > n || this.blush > 0.01 ||
      (this.eyeOverride != null && n < this.eyeOverrideUntil) ||
      (this.mouthOverride != null && n < this.mouthOverrideUntil) ||
      Math.abs(this.ty - this.yaw) > 0.003 || Math.abs(this.tp - this.pitch) > 0.003 ||
      Math.abs(this.tgEs - this.es) > 0.003 ||
      Math.abs((c.tint ? 0.5 : 0) - this.tintA) > 0.01 ||
      n - this.blinkAt < 0.2 ||
      springs.some((s) => !s.settled)
    );
  }

  // ── Update ──────────────────────────────────────────────────────────────────

  private after(seconds: number, fn: () => void) {
    this.later.push({ at: now() + seconds, fn });
  }

  private parts(p: Particle) {
    this.particles.push(p);
  }

  private burst(k: number) {
    for (let i = 0; i < k; i++) {
      this.parts({ k: "s", x: rand(-0.8, 0.8), y: rand(-0.95, -0.55), vx: rand(-0.15, 0.15), vy: rand(-0.45, -0.25), a: -i * 0.06, l: rand(0.9, 1.4), r: Math.random() * 6 });
    }
  }

  private tiny = false;

  update(dt: number) {
    const n = now();
    this.n = n;
    const t = n - this.t0;
    this.t = t;
    const c = this.cfg;
    const g = this.gesture;
    const gt = n - this.gestureAt;

    if (this.later.length) {
      const due = this.later.filter((l) => l.at <= n);
      this.later = this.later.filter((l) => l.at > n);
      for (const l of due) l.fn();
    }
    if (g && gt > 2.6) this.gesture = null;
    if (this.eyeOverride && n > this.eyeOverrideUntil) this.eyeOverride = null;
    if (this.mouthOverride && n > this.mouthOverrideUntil) this.mouthOverride = null;

    // Gaze: the cursor, the state's own look, or a random glance now and then.
    const moved = Math.abs(this.lookX - this.lastLook.x) > 0.01 || Math.abs(this.lookY - this.lastLook.y) > 0.01;
    if (moved) this.lastLook = { x: this.lookX, y: this.lookY, at: n };
    if (c.look) {
      this.ty = c.look[0] + this.lookX * 0.15;
      this.tp = c.look[1];
    } else if (c.scans) {
      this.ty = Math.sin(t * 2.6) * 0.6;
      this.tp = -0.06;
    } else if (c.dizzy) {
      this.ty = Math.sin(t * 9) * 0.3;
    } else if (this.calm) {
      this.ty = 0;
      this.tp = -0.1;
    } else if (!(this.lookHold > n)) {
      if (n - this.lastLook.at < 3 || !this.floatOn || this.tiny) {
        this.ty = clamp(this.lookX * 0.75, -0.7, 0.7);
        this.tp = clamp(this.lookY * 0.45, -0.45, 0.45);
      } else if (n > this.glanceAt) {
        const centre = Math.random() < 0.35;
        this.ty = centre ? 0 : rand(-0.6, 0.6);
        this.tp = centre ? 0 : rand(-0.3, 0.3);
        this.glanceAt = n + rand(1, 3);
      }
    }
    if (g === "etire" && gt < 2.4) {
      this.tp = 0.4;
      this.ty = 0;
    }
    const k = 1 - Math.pow(0.002, dt);
    this.yaw += (this.ty - this.yaw) * k;
    this.pitch += (this.tp - this.pitch) * k;
    this.es += (this.tgEs - this.es) * (1 - Math.pow(0.001, dt));

    // Blink.
    if (n > this.nextBlink) {
      if (!c.sleepy && !c.dizzy) this.blinkAt = n;
      this.nextBlink = n + (Math.random() < 0.22 ? 0.24 : rand(2.2, 5));
    }
    const d = n - this.blinkAt;
    this.open = d < 0.18 ? 1 - Math.sin((Math.PI * d) / 0.18) * 0.95 : 1;

    // Body: breathing, stretch, yawn, talking.
    const slow = c.sleepy || this.calm;
    let tsy = 1 + Math.sin(t * (slow ? 1.3 : 2)) * (slow ? 0.035 : 0.014);
    let tsx = 2 - tsy;
    if (g === "etire" && gt < 2.4) {
      const kk = gt < 0.9 ? inOut(gt / 0.9) : gt < 1.6 ? 1 : 1 - inOut((gt - 1.6) / 0.8);
      tsy = lerp(tsy, 1.16, kk);
      tsx = lerp(tsx, 0.9, kk);
    }
    if (g === "baille" && gt < 1.4) {
      const kk = Math.sin(Math.min(1, gt / 1.4) * Math.PI);
      tsy += kk * 0.08;
      tsx -= kk * 0.05;
    }
    if (this.talking) tsy += Math.abs(Math.sin(t * 9)) * 0.025;
    this.sx.target = tsx;
    this.sy.target = tsy;
    this.sx.step(dt);
    this.sy.step(dt);

    this.oy.target = c.bounces ? -Math.abs(Math.sin(t * 5.2)) * 0.09 : 0;
    if (g === "bravo" && gt < 2.2) this.oy.target = -Math.abs(Math.sin(gt * 7)) * 0.1;
    this.oy.step(dt);
    this.ox.target = 0;
    this.ox.step(dt);

    let tt = c.tilt ?? 0;
    if (g === "coucou" && gt < 1.9) tt = -0.06 + Math.sin(gt * 7.5) * 0.06;
    if (g === "epaules" && gt < 1.3) tt = Math.sin(gt * 5) * 0.08;
    if (c.dizzy) tt = Math.sin(t * 6) * 0.12;
    if (this.calm) tt = 0.06;
    this.tiltS.target = tt;
    this.tiltS.step(dt);

    const floatTarget = !this.floatOn ? 0 : slow ? Math.sin(t * 1.1) * 0.012 : Math.sin(t * 1.5) * 0.028;
    this.float += (floatTarget - this.float) * (1 - Math.pow(0.02, dt));

    // Arms: only for the greeting wave and for alerts.
    const showArms = (g === "coucou" && gt < 1.75) || !!c.arms;
    this.armVis.target = showArms && !this.tiny ? 1 : 0;
    this.armVis.step(dt);
    let L = 0.25 + Math.sin(t * 1.6) * 0.06;
    let Rr = 0.25 + Math.sin(t * 1.6 + 1) * 0.06;
    if (c.arms) {
      L = 2.2 + Math.sin(t * 14) * 0.18;
      Rr = 2.2 + Math.sin(t * 14 + 1) * 0.18;
    }
    if (g === "coucou" && gt < 1.9) Rr = 2.25 + Math.sin(gt * 13) * 0.42;
    this.armL.target = L;
    this.armR.target = Rr;
    this.armL.step(dt);
    this.armR.step(dt);

    // Badge.
    const wantBadge = this.tiny && c.badge !== "bang" ? null : c.badge;
    if (wantBadge !== this.badge) {
      if (this.badgeS.value < 0.05 || !this.badge) this.badge = wantBadge;
      this.badgeS.target = 0;
    } else {
      this.badgeS.target = wantBadge ? 1 : 0;
    }
    this.badgeS.step(dt);

    // State tint (the talking mouth borrows the "parle" blue).
    const tc = this.talking && !c.tint ? TINT.parle : c.tint;
    if (tc) {
      this.tint = tc;
      this.tintA += (0.5 - this.tintA) * 0.06;
    } else if (!this.tiny) {
      // Humeur du jour: a faint tint that changes with the weekday.
      this.tint = MOOD[new Date().getDay()];
      this.tintA += (0.22 - this.tintA) * 0.06;
    } else {
      this.tintA += (0 - this.tintA) * 0.06;
      if (this.tintA < 0.004) this.tintA = 0;
    }

    // Blush only during the love/hover hug and "bravo".
    const love = this.loveUntil > n;
    const blushing = love || (g === "bravo" && gt < 2);
    this.blush += ((blushing ? 1 : 0) - this.blush) * 0.06;
    if (!blushing && this.blush < 0.005) this.blush = 0;
    if (love && n - this.lastHeart > 1.2) {
      this.lastHeart = n;
      this.setEye("content", 1.2);
      this.emit("heart", 1);
    }
    if (c.zz && n - this.lastZ > 1.4) {
      this.lastZ = n;
      this.emit("z", 1);
    }

    // Idle life.
    if (this.floatOn && !this.tiny && n > this.nextIdle) {
      this.nextIdle = n + IDLE_EVERY;
      this.idle();
    }

    for (const p of this.particles) p.a += dt;
    this.particles = this.particles.filter((p) => p.a < p.l);
  }

  /** Small spontaneous lives while Nooky has nothing to do — all body and eyes, no arms. */
  private idle() {
    if (this.state !== "idle" || this.gesture || this.talking || this.anticipating || this.calm || this.eyeOverride) return;
    const r = Math.random();
    if (r < 0.22) this.play("saut");
    else if (r < 0.38) this.play("etire");
    else if (r < 0.52) this.play("clin");
    else if (r < 0.64) this.play("baille");
    else if (r < 0.74) this.play("epaules");
    else {
      this.lookHold = now() + 2;
      this.ty = -0.7;
      this.tp = 0;
      this.after(0.9, () => { this.ty = 0.7; });
      this.after(1.8, () => { this.ty = 0; });
    }
  }

  // ── Draw ────────────────────────────────────────────────────────────────────

  /**
   * Draws Nooky into a canvas of `W`×`H` CSS pixels (the caller has already
   * applied the DPR transform). The cloud is centred in the bottom `W`×`W`
   * square; `particleOverhang` pixels above it are left for particles.
   */
  draw(x: CanvasRenderingContext2D, W: number, H: number) {
    const R = W * 0.32;
    const tiny = R < 14;
    this.tiny = tiny;
    const n = this.n;
    const c = this.cfg;
    const cx = W / 2 + this.ox.value * R;
    const base = H / 2 + this.particleOverhang / 2 - CLOUD_CENTER_Y * R;
    const cy = base + (this.oy.value + this.float) * R;

    if (!tiny && this.focusRing >= 0) {
      x.save();
      x.lineWidth = Math.max(2, R * 0.07);
      x.lineCap = "round";
      x.strokeStyle = "rgba(255,255,255,.14)";
      x.beginPath();
      x.arc(cx, cy, R * 1.12, 0, Math.PI * 2);
      x.stroke();
      x.strokeStyle = "rgba(120,200,255,.9)";
      x.beginPath();
      x.arc(cx, cy, R * 1.12, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * this.focusRing);
      x.stroke();
      x.restore();
    }

    // Ground shadow (never in the notch), with a hint of the pro/perso accent.
    if (!tiny && this.ground) {
      const lift = clamp(-(this.oy.value + this.float) * 2, 0, 0.6);
      const gy = base + R * 0.8;
      x.fillStyle = `rgba(0,0,0,${0.33 * (1 - lift * 0.6)})`;
      x.beginPath();
      x.ellipse(cx, gy, R * 0.85 * (1 - lift * 0.3), R * 0.07, 0, 0, Math.PI * 2);
      x.fill();
      if (this.groundTint) {
        const gg = x.createRadialGradient(cx, gy, 0, cx, gy, R * 0.9);
        gg.addColorStop(0, rgba(this.groundTint, 0.22 * (1 - lift * 0.5)));
        gg.addColorStop(1, rgba(this.groundTint, 0));
        x.save();
        x.translate(cx, gy);
        x.scale(1, 0.16);
        x.translate(-cx, -gy);
        x.fillStyle = gg;
        x.beginPath();
        x.arc(cx, gy, R * 0.9, 0, Math.PI * 2);
        x.fill();
        x.restore();
      }
    }

    x.save();
    x.translate(cx, cy);
    x.rotate(this.tiltS.value);

    if (this.armVis.value > 0.03 && !tiny) {
      this.drawArm(x, R, -1, this.armL.value, this.armVis.value);
      this.drawArm(x, R, 1, this.armR.value, this.armVis.value);
    }

    x.save();
    x.scale(this.sx.value, this.sy.value);
    const body = this.bodyPath(R);

    x.save();
    x.shadowColor = "rgba(0,0,0,.35)";
    x.shadowBlur = R * 0.25;
    x.shadowOffsetY = R * 0.06;
    const g = x.createLinearGradient(R * 0.6, -R * 0.9, -R * 0.7, R * 0.8);
    g.addColorStop(0, TOP);
    g.addColorStop(1, BOT);
    x.fillStyle = g;
    x.fill(body);
    x.restore();

    if (this.tintA > 0.02) {
      const tg = x.createLinearGradient(0, R * 0.6, 0, -R * 0.8);
      tg.addColorStop(0, rgba(this.tint, 0.62 * this.tintA));
      tg.addColorStop(1, rgba(this.tint, 0));
      x.fillStyle = tg;
      x.fill(body);
    }
    const hl = x.createRadialGradient(R * 0.22, -R * 0.5, 0, R * 0.22, -R * 0.5, R * 0.5);
    hl.addColorStop(0, "rgba(255,255,255,.55)");
    hl.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = hl;
    x.fill(body);

    x.save();
    x.clip(body);
    if (this.blush > 0.02) this.drawBlush(x, R);
    this.drawEyes(x, R, tiny, n);
    this.drawMouth(x, R, tiny, n);
    x.restore();
    x.restore();
    x.restore();

    if (this.badge && this.badgeS.value > 0.02) this.drawBadge(x, R, cx, cy, c, tiny);
    this.drawParticles(x, R, cx, cy);
  }

  private cachedR = -1;
  private cachedPath: Path2D | null = null;

  bodyPath(R: number): Path2D {
    if (this.cachedPath && this.cachedR === R) return this.cachedPath;
    const p = new Path2D();
    for (const [a, b, r] of LOBES) {
      p.moveTo(a * R + r * R, b * R);
      p.arc(a * R, b * R, r * R, 0, Math.PI * 2);
    }
    const X = BASE.x * R, Y = BASE.y * R, Wd = BASE.w * R, Hd = BASE.h * R, r = BASE.r * R;
    p.moveTo(X + r, Y);
    p.arcTo(X + Wd, Y, X + Wd, Y + Hd, r);
    p.arcTo(X + Wd, Y + Hd, X, Y + Hd, r);
    p.arcTo(X, Y + Hd, X, Y, r);
    p.arcTo(X, Y, X + Wd, Y, r);
    p.closePath();
    this.cachedR = R;
    this.cachedPath = p;
    return p;
  }

  /** Sphere projection of a point on the face: yaw/pitch → offset and foreshortening. */
  private proj(R: number, yaw: number, pitch: number) {
    const cp = Math.cos(pitch);
    return {
      x: Math.sin(yaw) * cp * R * 0.85,
      y: R * 0.2 - Math.sin(pitch) * R * 0.55,
      fx: Math.max(0.2, Math.cos(yaw)),
      fy: Math.max(0.2, cp),
      vis: Math.cos(yaw) * cp,
    };
  }

  /** Arm `sd` (−1 left, 1 right): angle 0 = along the body, ~2.2 = raised. */
  private drawArm(x: CanvasRenderingContext2D, R: number, sd: number, ang: number, vis: number) {
    const v = clamp(vis, 0, 1.2);
    x.save();
    x.translate(sd * R * ARM.sx * this.sx.value, R * ARM.sy * this.sy.value);
    x.rotate(sd * -(0.15 + ang));
    x.scale(v, v);
    const L = R * ARM.len, w = R * ARM.w;
    const g = x.createLinearGradient(0, 0, 0, L);
    g.addColorStop(0, "#e9eaf0");
    g.addColorStop(1, "#c2c6d4");
    x.fillStyle = g;
    x.beginPath();
    x.roundRect(-w / 2, -w * 0.2, w, L, w / 2);
    x.fill();
    x.restore();
  }

  private drawBlush(x: CanvasRenderingContext2D, R: number) {
    for (const sd of [-1, 1]) {
      const p = this.proj(R, sd * 0.62 + this.yaw, -0.22 + this.pitch);
      if (p.vis < 0.1) continue;
      const rg = x.createRadialGradient(p.x, p.y + R * 0.1, 0, p.x, p.y + R * 0.1, R * 0.15);
      rg.addColorStop(0, `rgba(235,120,140,${0.42 * this.blush})`);
      rg.addColorStop(1, "rgba(235,120,140,0)");
      x.fillStyle = rg;
      x.fillRect(-R * 2, -R * 2, R * 4, R * 4);
    }
  }

  currentEye(): EyeShape {
    if (this.eyeOverride) return this.eyeOverride;
    if (this.anticipating) return "grand";
    if (this.calm && this.state === "idle") return "mi";
    return this.cfg.eye;
  }

  private drawEyes(x: CanvasRenderingContext2D, R: number, tiny: boolean, n: number) {
    const eye = this.currentEye();
    const m = (tiny ? 1.45 : 1) * this.es;
    const minLine = tiny ? 1 : 0;
    for (const sd of [-1, 1]) {
      const p = this.proj(R, sd * 0.34 + this.yaw, this.pitch);
      if (p.vis <= 0.05) continue;
      const w = R * 0.18 * m, h = R * 0.25 * m;
      x.save();
      x.translate(p.x, p.y);
      x.scale(p.fx, p.fy);
      x.fillStyle = INK;
      x.strokeStyle = INK;
      x.lineCap = "round";
      let e: EyeShape = eye;
      if (e === "clin") e = sd > 0 ? "content" : "rond";
      if (e === "agace") {
        x.rotate(-sd * 0.22);
        x.lineWidth = Math.max(w * 0.3, minLine);
        x.beginPath();
        x.moveTo(-w * 0.55, 0);
        x.lineTo(w * 0.55, 0);
        x.stroke();
      } else if (e === "content") {
        x.lineWidth = Math.max(w * 0.28, minLine);
        x.beginPath();
        x.arc(0, h * 0.22, w * 0.5, Math.PI * 1.15, Math.PI * 1.85);
        x.stroke();
      } else if (e === "dodo") {
        x.lineWidth = Math.max(w * 0.22, minLine);
        x.beginPath();
        x.moveTo(-w * 0.5, 0);
        x.quadraticCurveTo(0, w * 0.28, w * 0.5, 0);
        x.stroke();
      } else if (e === "mi") {
        x.beginPath();
        x.ellipse(0, h * 0.12, w / 2, Math.max(h * 0.28 * this.open, w * 0.12), 0, 0, Math.PI * 2);
        x.fill();
      } else if (e === "spirale") {
        x.lineWidth = Math.max(w * 0.16, minLine * 0.8);
        x.beginPath();
        for (let a = 0; a < 4.2 * Math.PI; a += 0.2) {
          const r = w * 0.04 + a * w * 0.04;
          const aa = a + n * 9 * sd;
          if (a === 0) x.moveTo(Math.cos(aa) * r, Math.sin(aa) * r);
          else x.lineTo(Math.cos(aa) * r, Math.sin(aa) * r);
        }
        x.stroke();
      } else {
        const k = e === "grand" ? 1.14 : 1;
        const hh = Math.max(h * k * this.open, w * 0.2);
        x.beginPath();
        x.ellipse(0, 0, (w * k) / 2, hh / 2, 0, 0, Math.PI * 2);
        x.fill();
      }
      x.restore();
    }
  }

  currentMouth(): MouthShape | null {
    if (this.talking) return "parle";
    if (this.mouthOverride) return this.mouthOverride;
    if (this.anticipating) return "o";
    return this.cfg.mouth;
  }

  private drawMouth(x: CanvasRenderingContext2D, R: number, tiny: boolean, n: number) {
    const mo = this.currentMouth();
    if (!mo) return;
    const p = this.proj(R, this.yaw, -0.42 + this.pitch * 0.9);
    if (p.vis <= 0.1) return;
    // A touch larger than the reference page (R is small in the island).
    const m = R * 0.11 * (tiny ? 1.3 : 1);
    x.save();
    x.translate(p.x, p.y);
    x.scale(p.fx, p.fy);
    x.fillStyle = INK;
    x.strokeStyle = INK;
    x.lineCap = "round";
    x.lineWidth = Math.max(R * 0.028, tiny ? 0.9 : 0);
    x.beginPath();
    switch (mo) {
      case "parle":
        x.ellipse(0, 0, m * 0.55, m * (0.2 + Math.abs(Math.sin(this.t * 11)) * 0.4), 0, 0, Math.PI * 2);
        x.fill();
        break;
      case "o":
        x.ellipse(0, 0, m * 0.4, m * 0.5, 0, 0, Math.PI * 2);
        x.fill();
        break;
      case "baille": {
        const k = Math.sin(Math.min(1, (n - this.mouthStart) / 1.4) * Math.PI);
        x.ellipse(0, 0, m * 0.6, m * (0.4 + 0.5 * k), 0, 0, Math.PI * 2);
        x.fill();
        break;
      }
      case "sourire":
        x.moveTo(-m * 0.6, -m * 0.1);
        x.quadraticCurveTo(0, m * 0.75, m * 0.6, -m * 0.1);
        x.stroke();
        break;
      case "moue":
        x.moveTo(-m * 0.45, m * 0.25);
        x.quadraticCurveTo(0, -m * 0.15, m * 0.45, m * 0.25);
        x.stroke();
        break;
      case "plat":
        x.moveTo(-m * 0.45, 0);
        x.lineTo(m * 0.45, m * 0.08);
        x.stroke();
        break;
    }
    x.restore();
  }

  /** Status badge, top-right of the cloud. */
  private drawBadge(x: CanvasRenderingContext2D, R: number, cx: number, cy: number, c: StateCfg, tiny: boolean) {
    const b = this.badge!;
    const s = clamp(this.badgeS.value, 0, 1.3) * (tiny ? 1.3 : 1);
    const t = this.t;
    x.save();
    x.translate(cx + R * 0.82, cy - R * 0.72);
    x.scale(s, s);
    if (b === "dots") {
      const col = c.tint ? rgba(c.tint, 1) : "#8b5cf6";
      const pw = R * 0.5, ph = R * 0.24;
      x.fillStyle = col;
      x.beginPath();
      x.roundRect(-pw / 2, -ph / 2, pw, ph, ph / 2);
      x.fill();
      for (let i = 0; i < 3; i++) {
        const q = (((t * 2.4 - i * 0.22) % 1) + 1) % 1;
        x.fillStyle = "#fff";
        x.beginPath();
        x.arc((i - 1) * R * 0.13, 0, R * 0.035 * (1 + 0.4 * Math.max(0, Math.sin(q * 6.28))), 0, Math.PI * 2);
        x.fill();
      }
    } else {
      const col = b === "bang" ? "#f5a623" : "#60a5fa";
      x.rotate(Math.sin(t * 12) * 0.1);
      x.fillStyle = "#0d0e12";
      x.beginPath();
      x.arc(0, 0, R * 0.21, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = col;
      x.beginPath();
      x.arc(0, 0, R * 0.16, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = "#fff";
      x.font = `800 ${R * 0.21}px ${FONT}`;
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.fillText(b === "bang" ? "!" : "?", 0, R * 0.01);
    }
    x.restore();
  }

  private drawParticles(x: CanvasRenderingContext2D, R: number, cx: number, cy: number) {
    for (const p of this.particles) {
      if (p.a < 0) continue;
      const k = p.a / p.l;
      const al = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8;
      x.save();
      x.globalAlpha = clamp(al, 0, 1);
      x.translate(cx + (p.x + p.vx * p.a) * R, cy + (p.y + p.vy * p.a) * R);
      if (p.k === "z") {
        x.fillStyle = "#aab0c4";
        x.font = `700 ${R * 0.2}px ${FONT}`;
        x.fillText("z", 0, 0);
      } else if (p.k === "h") {
        x.fillStyle = HEART;
        const z = R * 0.09;
        x.beginPath();
        x.moveTo(0, z * 0.4);
        x.bezierCurveTo(-z * 1.1, -z * 0.2, -z * 0.5, -z, 0, -z * 0.4);
        x.bezierCurveTo(z * 0.5, -z, z * 1.1, -z * 0.2, 0, z * 0.4);
        x.fill();
      } else if (p.k === "d") {
        const z = R * 0.07;
        x.fillStyle = "#9cc8f5";
        x.beginPath();
        x.moveTo(0, -z);
        x.quadraticCurveTo(z * 0.8, z * 0.2, 0, z * 0.6);
        x.quadraticCurveTo(-z * 0.8, z * 0.2, 0, -z);
        x.fill();
      } else {
        x.rotate(p.r + p.a * 2);
        x.fillStyle = "#fff";
        x.beginPath();
        for (let i = 0; i < 8; i++) {
          const r = i % 2 ? R * 0.02 : R * 0.07;
          const a = (i * Math.PI) / 4;
          x.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        x.fill();
      }
      x.restore();
    }
  }
}
