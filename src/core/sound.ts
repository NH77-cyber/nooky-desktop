// Nooky's sounds — tiny, quiet, original, synthesised with the Web Audio API.
// No audio files ship with the app. Same API as before: Sound.play(name).
// Nooky Desktop — original code.

/** One note: frequency (Hz), start offset and duration (s), optional glide. */
interface Note {
  f: number;
  at: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
  to?: number; // glide to this frequency
  vibrato?: number; // Hz of a gentle wobble
}

const C6 = 1046.5, D6 = 1174.7, E6 = 1318.5, G6 = 1568, A5 = 880, E5 = 659.3, G5 = 784, C5 = 523.3;

const SOUNDS: Record<string, Note[]> = {
  peek: [{ f: 1320, at: 0, dur: 0.07, gain: 0.35 }],
  open: [
    { f: E5, at: 0, dur: 0.08, gain: 0.35 },
    { f: A5, at: 0.06, dur: 0.11, gain: 0.35 },
  ],
  close: [
    { f: A5, at: 0, dur: 0.07, gain: 0.25 },
    { f: E5, at: 0.06, dur: 0.1, gain: 0.25 },
  ],
  hover: [{ f: 1760, at: 0, dur: 0.05, gain: 0.15 }],
  blip: [{ f: C6, at: 0, dur: 0.05, type: "triangle", gain: 0.3 }],
  tick: [{ f: 2093, at: 0, dur: 0.02, gain: 0.12 }],
  poke: [{ f: 560, to: 300, at: 0, dur: 0.14, gain: 0.45 }],
  annoyed: [{ f: 330, to: 280, at: 0, dur: 0.16, type: "triangle", gain: 0.25 }],
  dizzy: [{ f: 760, to: 340, at: 0, dur: 0.55, gain: 0.35, vibrato: 9 }],
  greet: [
    { f: C6, at: 0, dur: 0.16, gain: 0.35 },
    { f: E6, at: 0.09, dur: 0.16, gain: 0.32 },
    { f: G6, at: 0.18, dur: 0.28, gain: 0.3 },
  ],
  done: [
    { f: G5, at: 0, dur: 0.14, gain: 0.35 },
    { f: C6, at: 0.08, dur: 0.18, gain: 0.35 },
    { f: E6 * 2, at: 0.2, dur: 0.12, gain: 0.08 },
  ],
  proud: [
    { f: E6, at: 0, dur: 0.1, gain: 0.28 },
    { f: G6 * 1.5, at: 0.07, dur: 0.16, gain: 0.18 },
  ],
  reminder: [
    { f: D6, at: 0, dur: 0.22, type: "triangle", gain: 0.3 },
    { f: D6, at: 0.24, dur: 0.3, type: "triangle", gain: 0.3 },
  ],
  error: [
    { f: 440, at: 0, dur: 0.12, type: "triangle", gain: 0.3 },
    { f: 349, at: 0.1, dur: 0.18, type: "triangle", gain: 0.3 },
  ],
  send: [{ f: 620, to: 1240, at: 0, dur: 0.08, gain: 0.25 }],
  love: [
    { f: A5, at: 0, dur: 0.1, gain: 0.25 },
    { f: 1108.7, at: 0.07, dur: 0.1, gain: 0.25 },
    { f: E6, at: 0.14, dur: 0.18, gain: 0.25 },
  ],
  drop: [
    { f: 300, to: 900, at: 0, dur: 0.09, gain: 0.4 },
    { f: C6 * 2, at: 0.1, dur: 0.1, gain: 0.08 },
  ],
  talk: [{ f: C5, to: G5, at: 0, dur: 0.06, gain: 0.12 }],
  // End of a focus session: a soft three-note chime.
  chime: [
    { f: G5, at: 0, dur: 0.5, type: "triangle", gain: 0.22 },
    { f: C6, at: 0.16, dur: 0.55, type: "triangle", gain: 0.2 },
    { f: E6, at: 0.32, dur: 0.8, type: "triangle", gain: 0.18 },
  ],
};

export type SoundName = keyof typeof SOUNDS;
export const SOUND_NAMES = Object.keys(SOUNDS);

class SoundEngine {
  enabled = true;
  /** 0…1, from the settings. */
  volume = 0.5;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private idleTimer: number | null = null;

  /** Creates the audio context lazily. Safe to call more than once. */
  preload(): Promise<void> {
    this.ensure();
    return Promise.resolve();
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = this.masterGain();
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
    } catch {
      return null;
    }
    return this.ctx;
  }

  /** Quiet by design: full volume is still a soft blip. */
  private masterGain(): number {
    return Math.max(0, Math.min(1, this.volume)) * 0.22;
  }

  /** WebViews can hand us a suspended context; call after any user input. */
  resume() {
    if (this.idleTimer != null) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    void this.ensure()?.resume().catch(() => {});
  }

  /** Suspends the audio thread once the island goes quiet, so idle costs nothing. */
  idle() {
    if (!this.ctx || this.ctx.state !== "running" || this.idleTimer != null) return;
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      void this.ctx?.suspend().catch(() => {});
    }, 1500);
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = this.masterGain();
  }

  setEnabled(on: boolean) {
    this.enabled = on;
  }

  play(name: SoundName | string) {
    if (!this.enabled) return;
    const notes = SOUNDS[name];
    if (!notes) return;
    const ctx = this.ensure();
    const master = this.master;
    if (!ctx || !master) return;
    if (this.idleTimer != null) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    const t0 = ctx.currentTime + 0.005;
    for (const n of notes) this.note(ctx, master, n, t0);
  }

  private note(ctx: AudioContext, out: AudioNode, n: Note, t0: number) {
    const start = t0 + n.at;
    const end = start + n.dur;
    const osc = ctx.createOscillator();
    osc.type = n.type ?? "sine";
    osc.frequency.setValueAtTime(n.f, start);
    if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, end);

    const env = ctx.createGain();
    const peak = n.gain ?? 0.3;
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(peak, start + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, end);

    if (n.vibrato) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = n.vibrato;
      depth.gain.value = n.f * 0.04;
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(start);
      lfo.stop(end + 0.02);
    }

    // A faint octave partial makes the chimes read as little bells.
    if ((n.type ?? "sine") === "sine" && n.dur > 0.09) {
      const bell = ctx.createOscillator();
      const bellEnv = ctx.createGain();
      bell.frequency.setValueAtTime(n.f * 2, start);
      bellEnv.gain.setValueAtTime(0.0001, start);
      bellEnv.gain.exponentialRampToValueAtTime(peak * 0.18, start + 0.004);
      bellEnv.gain.exponentialRampToValueAtTime(0.0001, start + n.dur * 0.6);
      bell.connect(bellEnv).connect(out);
      bell.start(start);
      bell.stop(end + 0.02);
    }

    osc.connect(env).connect(out);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}

export const Sound = new SoundEngine();
