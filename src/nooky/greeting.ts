// Nooky's launch greeting — "Bonjour <prénom> !". Nooky Desktop — original
// choreography (the hooks into the island's state machine — start, hover,
// interrupt, onComplete — follow Coucou's, MIT License).
//
// Timeline (seconds):
//   0.00  the island grows (the island's own spring), a soft card fades in
//   0.25  Nooky floats down from the top edge…
//   0.95  …lands with a squash
//   1.10  its right arm comes out and waves, happy eyes, a small smile
//   1.25  "Bonjour <prénom> !" slides in next to it (after 18:00: "Bonsoir")
//   3.25  the text fades, Nooky settles
//   3.70  done → the island collapses to compact (or opens the morning card)

import { BotEngine } from "./engine";
import { EXPANDED_W } from "../core/layout";
import { Ease, clamp, lerp, seg } from "../core/anim";
import { Sound } from "../core/sound";
import { hello } from "../core/state";
import { modeAccent } from "../core/mode";

const T = {
  fall0: 0.25,
  land: 0.95,
  wave: 1.1,
  text0: 1.25,
  text1: 1.6,
  textOut0: 3.2,
  textOut1: 3.5,
  end: 3.7,
};

export const GREETING_END = T.end;

const H = 150;
const D = 74; // Nooky's body diameter during the greeting
const REST = { x: 214, y: 84 };
const FONT = `ui-rounded, "SF Pro Rounded", system-ui, "Segoe UI Variable Display", "Segoe UI", sans-serif`;

function greetingText(d = new Date()): { title: string; sub: string } {
  const date = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  return {
    title: hello(d),
    sub: date.charAt(0).toUpperCase() + date.slice(1),
  };
}

function rr(x: CanvasRenderingContext2D, X: number, Y: number, W: number, Hh: number, R: number) {
  x.beginPath();
  x.roundRect(X, Y, W, Hh, Math.max(0, Math.min(R, W / 2, Hh / 2)));
}

/** A few slow sparkles in the card, seeded so every launch looks the same. */
const SPARKLES = (() => {
  let s = 11;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
  // Kept clear of the text block (x 270…560, y 55…120).
  return Array.from({ length: 24 }, () => ({
    x: 30 + rnd() * 580, y: 46 + rnd() * 90, r: 0.8 + rnd() * 1.6, p: rnd() * Math.PI * 2, sp: 0.6 + rnd(),
  })).filter((s) => !(s.x > 262 && s.x < 568 && s.y > 50 && s.y < 126)).slice(0, 14);
})();

export class Greeting {
  private startMs = 0;
  private tc = Number.POSITIVE_INFINITY;
  private fired = false;
  private timers: number[] = [];
  private lastMs = 0;
  private text = greetingText();

  readonly engine = new BotEngine();

  onComplete: (() => void) | null = null;

  start() {
    this.startMs = performance.now();
    this.lastMs = this.startMs;
    this.tc = Number.POSITIVE_INFINITY;
    this.fired = false;
    this.text = greetingText();
    this.cancelTimers();
    const e = this.engine;
    e.setState("idle", true);
    e.particleOverhang = 0;
    e.lookX = 0;
    e.lookY = -0.3;
    this.timers.push(
      window.setTimeout(() => {
        e.land();
        e.lookY = 0;
        Sound.play("peek");
      }, T.land * 1000),
      window.setTimeout(() => e.greet(true), T.wave * 1000),
      window.setTimeout(() => e.blink(), 2.9 * 1000),
      window.setTimeout(() => this.fire(), (T.end + 0.05) * 1000),
    );
  }

  /** Mouse entered the island during the greeting — hold it open. */
  hover() {
    this.engine.lookY = 0;
  }

  /** Mouse left or the greeting is cut short — collapse from now. */
  interrupt() {
    const t = this.elapsed;
    if (!Number.isFinite(this.tc) || this.tc > t) this.tc = t;
    this.cancelTimers();
    this.engine.interruptGreet();
  }

  get elapsed(): number {
    return (performance.now() - this.startMs) / 1000;
  }

  get done(): boolean {
    return this.fired;
  }

  /** Where Nooky is right now, in island coordinates — the island's own Nooky takes over from here. */
  handoff(): { x: number; y: number; d: number } {
    const p = this.pose(this.elapsed);
    return { x: p.x, y: p.y, d: p.d };
  }

  private fire() {
    if (this.fired) return;
    this.fired = true;
    this.cancelTimers();
    this.onComplete?.();
  }

  private cancelTimers() {
    this.timers.forEach((id) => window.clearTimeout(id));
    this.timers = [];
  }

  private pose(t: number): { x: number; y: number; d: number } {
    const fall = seg(t, T.fall0, T.land);
    const y = lerp(-56, REST.y, Ease.out(fall)) + (t > T.land ? Math.sin((t - T.land) * 2.2) * 2 : 0);
    const settle = seg(t, T.textOut0, T.end);
    const x = lerp(REST.x, REST.x - 10, Ease.inOut(settle));
    return { x, y, d: lerp(D, D * 0.92, Ease.inOut(settle)) };
  }

  draw(x: CanvasRenderingContext2D) {
    const nowMs = performance.now();
    const dt = Math.min(0.05, (nowMs - this.lastMs) / 1000);
    this.lastMs = nowMs;
    const t = this.elapsed;
    if (!this.fired && t >= T.end + 0.3) this.fire();
    const out = Number.isFinite(this.tc) ? 1 - seg(t, this.tc, this.tc + 0.25) : 1;

    x.clearRect(0, 0, EXPANDED_W, H);

    // Card with a soft glow of the pro / perso accent rising from the bottom.
    const card = seg(t, 0.12, 0.45) * out;
    if (card > 0) {
      x.save();
      x.globalAlpha = card;
      rr(x, 10, 36, 620, 104, 20);
      x.fillStyle = "#14151b";
      x.fill();
      x.clip();
      const [ar, ag, ab] = modeAccent().rgb;
      const g = x.createRadialGradient(320, 200, 10, 320, 200, 330);
      g.addColorStop(0, `rgba(${ar},${ag},${ab},0.22)`);
      g.addColorStop(1, `rgba(${ar},${ag},${ab},0)`);
      x.fillStyle = g;
      x.fillRect(10, 36, 620, 104);
      for (const s of SPARKLES) {
        const a = (0.25 + 0.35 * Math.sin(t * s.sp * 2 + s.p)) * seg(t, 0.3, 0.9);
        if (a <= 0) continue;
        x.fillStyle = `rgba(255,255,255,${a})`;
        x.beginPath();
        x.arc(s.x, s.y - t * 3 * s.sp, s.r, 0, Math.PI * 2);
        x.fill();
      }
      x.restore();
    }

    // Nooky.
    const p = this.pose(t);
    const e = this.engine;
    e.floatOn = t > T.land + 0.3;
    e.groundTint = null;
    e.ground = t > T.land;
    e.update(dt);
    const W = p.d / 0.6;
    const overhang = 40;
    const Hc = W + overhang;
    x.save();
    x.globalAlpha = out;
    x.translate(p.x - W / 2, p.y - overhang / 2 - Hc / 2);
    e.particleOverhang = overhang;
    e.draw(x, W, Hc);
    x.restore();

    // "Bonjour <prénom> !"
    const tin = Ease.out(seg(t, T.text0, T.text1));
    const tout = 1 - seg(t, T.textOut0, T.textOut1);
    const ta = clamp(tin * tout * out, 0, 1);
    if (ta > 0) {
      x.save();
      x.globalAlpha = ta;
      const dx = (1 - tin) * 14;
      x.textBaseline = "alphabetic";
      x.fillStyle = "#eef0f6";
      x.font = `700 27px ${FONT}`;
      x.fillText(this.text.title, 280 + dx, 86);
      x.fillStyle = "#8d91a3";
      x.font = `500 13.5px ${FONT}`;
      x.fillText(this.text.sub, 282 + dx, 110);
      x.restore();
    }
  }

  /** True while the greeting still needs frames. */
  get animating(): boolean {
    return !this.fired || this.engine.busy;
  }
}
