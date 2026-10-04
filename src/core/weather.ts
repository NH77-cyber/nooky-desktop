// Weather line for the reduced island. The city is a synced pref ("ville").
// Refreshed at most every 30 minutes; any failure just hides the line.
// Nooky Desktop — original code.

import { Bridge } from "./bridge";

interface Reading {
  temp: number;
  code: number;
  rain: number;
}

const REFRESH_MS = 30 * 60_000;
const RETRY_MS = 5 * 60_000;

let reading: Reading | null = null;
let city = "";
let nextTry = 0;
let busy = false;

/** WMO weather code → short French label. */
export function weatherLabel(code: number): string {
  if (code === 0) return "dégagé";
  if (code <= 2) return "peu nuageux";
  if (code === 3) return "couvert";
  if (code === 45 || code === 48) return "brouillard";
  if (code >= 51 && code <= 57) return "bruine";
  if (code >= 61 && code <= 67) return "pluie";
  if (code >= 71 && code <= 77) return "neige";
  if (code >= 80 && code <= 82) return "averses";
  if (code >= 95) return "orage";
  return "variable";
}

/** Call often (cheap): fetches only when the city changed or the reading is old. */
export function refreshWeather(wanted: string) {
  const c = wanted.trim();
  if (c !== city) {
    city = c;
    reading = null;
    nextTry = 0;
  }
  if (!c || busy || Date.now() < nextTry) return;
  busy = true;
  void Bridge.weather(c)
    .then((raw) => {
      const v = raw ? (JSON.parse(raw) as Reading) : null;
      if (v && Number.isFinite(v.temp)) {
        reading = v;
        nextTry = Date.now() + REFRESH_MS;
      } else {
        nextTry = Date.now() + RETRY_MS;
      }
    })
    .catch(() => {
      nextTry = Date.now() + RETRY_MS;
    })
    .finally(() => {
      busy = false;
    });
}

/** "14° · averses · pluie 60 %" or null. */
export function weatherText(): string | null {
  if (!reading) return null;
  const rain = reading.rain >= 30 ? ` · pluie ${reading.rain} %` : "";
  return `${reading.temp}° · ${weatherLabel(reading.code)}${rain}`;
}
