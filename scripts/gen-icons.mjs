// Draws Nooky — the "nuage épuré": a three-lobed cloud with two ink eyes — into
// every icon Tauri needs:
// PNG set, icon.ico (Windows), icon.icns (macOS) and the monochrome
// tray-template.png for the macOS menu bar. No dependencies: shapes are
// rasterised here with supersampling and encoded with node:zlib.
//
//   npm run icons        (= node scripts/gen-icons.mjs)
//
// Nooky Desktop — original artwork, drawn in code.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");

// ── Colours ───────────────────────────────────────────────────────────────────

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const INK = hex("#1c1e27");
const BG_IN = hex("#2a2c36");
const BG_OUT = hex("#101116");
const TOP = hex("#f6f6f9");
const BOT = hex("#b7bccb");

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// ── Nooky's shapes, in units of R (same body as src/nooky/engine.ts) ──────────
// "Nuage épuré": three soft lobes over a rounded base, solid ink eyes, no mouth.

const LOBES = [
  [0, -0.32, 0.56],
  [-0.5, -0.02, 0.42],
  [0.5, -0.02, 0.42],
];
const BASE = { x: -0.82, y: -0.02, w: 1.64, h: 0.6, r: 0.3 };
/** Body centre, in units of R (it spans −0.88 … 0.58). */
const CENTER_Y = -0.15;

function inRoundRect(x, y, b) {
  const cx = Math.max(b.x + b.r, Math.min(b.x + b.w - b.r, x));
  const cy = Math.max(b.y + b.r, Math.min(b.y + b.h - b.r, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= b.r * b.r;
}

function inCloud(x, y) {
  for (const [cx, cy, r] of LOBES) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) return true;
  return inRoundRect(x, y, BASE);
}

const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

// Eyes: the engine's face projection at yaw ±0.34 (x = sin(0.34)·0.85), y = 0.2.
const EYE_X = Math.sin(0.34) * 0.85, EYE_Y = 0.2, EYE_RX = 0.09 * Math.cos(0.34), EYE_RY = 0.125;

/**
 * Colour of one sample of the full-colour icon, as [r,g,b,a] 0..255 / 0..1.
 * `u`,`v` are in 0..1 over the icon square.
 */
function sampleApp(u, v) {
  // Background: macOS-style rounded square, a sober dark stage with a soft centre.
  const inset = 0.098, rad = 0.2;
  const bx = Math.max(inset + rad, Math.min(1 - inset - rad, u));
  const by = Math.max(inset + rad, Math.min(1 - inset - rad, v));
  if ((u - bx) ** 2 + (v - by) ** 2 > rad * rad) return null;
  let col = mix(BG_IN, BG_OUT, smooth(0, 0.62, Math.hypot(u - 0.5, v - 0.42)));

  const R = 0.31;
  const cx = 0.5, cy = 0.5 - CENTER_Y * R;
  const x = (u - cx) / R, y = (v - cy) / R;

  // Ground shadow.
  if (inEllipse(x, y, 0, 0.7, 0.72, 0.06)) col = mix(col, [0, 0, 0], 0.35);

  // Soft drop shadow under the body.
  if (!inCloud(x, y)) {
    let near = 0;
    for (let k = 1; k <= 3; k++) if (inCloud(x, y - 0.06 * k)) near = Math.max(near, 1 - k / 4);
    return [...mix(col, [0, 0, 0], 0.25 * near), 1];
  }

  // Body: linear gradient top-right → bottom-left, top highlight.
  const t = clamp01(((0.6 - x) * 1.3 + (y + 0.9) * 1.7) / (1.3 * 1.3 + 1.7 * 1.7));
  col = mix(TOP, BOT, t);
  const hl = Math.hypot(x - 0.22, y + 0.5);
  col = mix(col, [255, 255, 255], 0.55 * (1 - smooth(0, 0.5, hl)));

  // Eyes: solid ink, no highlight.
  for (const sd of [-1, 1]) {
    if (inEllipse(x, y, sd * EYE_X, EYE_Y, EYE_RX, EYE_RY)) col = INK;
  }
  return [...col, 1];
}

/**
 * Menu-bar template: black cloud with the eyes cut out (transparent), so
 * macOS can tint it for light and dark menu bars.
 */
function sampleTemplate(u, v) {
  const R = 0.5;
  const x = (u - 0.5) / R, y = (v - 0.5 + CENTER_Y * R) / R;
  if (!inCloud(x, y)) return null;
  for (const sd of [-1, 1]) {
    if (inEllipse(x, y, sd * 0.3, 0.18, 0.11, 0.16)) return null;
  }
  return [0, 0, 0, 1];
}

// ── Raster + encoders ─────────────────────────────────────────────────────────

function render(size, sampler) {
  const ss = size <= 64 ? 6 : size <= 256 ? 4 : 3;
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sj = 0; sj < ss; sj++) {
        for (let si = 0; si < ss; si++) {
          const s = sampler((i + (si + 0.5) / ss) / size, (j + (sj + 0.5) / ss) / size);
          if (!s) continue;
          r += s[0] * s[3]; g += s[1] * s[3]; b += s[2] * s[3]; a += s[3];
        }
      }
      const o = (j * size + i) * 4;
      const n = ss * ss;
      if (a > 0) {
        px[o] = Math.round(r / a);
        px[o + 1] = Math.round(g / a);
        px[o + 2] = Math.round(b / a);
      }
      px[o + 3] = Math.round((a / n) * 255);
    }
  }
  return px;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePNG(size, px) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const cache = new Map();
function appPNG(size) {
  if (!cache.has(size)) cache.set(size, encodePNG(size, render(size, sampleApp)));
  return cache.get(size);
}

/** ICO with PNG-compressed entries (Vista+). */
function encodeICO(sizes) {
  const entries = sizes.map((s) => ({ s, png: appPNG(s) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.s >= 256 ? 0 : e.s;
    dir[o + 1] = e.s >= 256 ? 0 : e.s;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

/** ICNS with PNG payloads (the format iconutil writes). */
function encodeICNS() {
  const types = [
    ["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256],
    ["ic09", 512], ["ic10", 1024], ["ic11", 32], ["ic12", 64], ["ic13", 256], ["ic14", 512],
  ];
  const parts = types.map(([type, s]) => {
    const png = appPNG(s);
    const h = Buffer.alloc(8);
    h.write(type, 0, "ascii");
    h.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([h, png]);
  });
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.write("icns", 0, "ascii");
  h.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([h, body]);
}

mkdirSync(OUT, { recursive: true });
const files = {
  "32x32.png": appPNG(32),
  "64x64.png": appPNG(64),
  "128x128.png": appPNG(128),
  "128x128@2x.png": appPNG(256),
  "icon.png": appPNG(512),
  "icon.ico": encodeICO([16, 24, 32, 48, 64, 128, 256]),
  "icon.icns": encodeICNS(),
  "tray-template.png": encodePNG(44, render(44, sampleTemplate)),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(OUT, name), data);
  console.log(`icons/${name}  ${data.length} B`);
}
