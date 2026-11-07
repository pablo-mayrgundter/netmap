// Number formatting and DOM helpers. The DOM helpers touch `document` only
// when called, so this module also imports cleanly under Node for tests.

export const SVG_NS = "http://www.w3.org/2000/svg";
export const DASH = "—";

export const fmt = n => n == null || Number.isNaN(n) ? DASH
  : n >= 10000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "K"
  : Math.round(n).toLocaleString("en-US");

/** A value that may legitimately be missing: null is "not reported", never 0. */
export const tileValue = v => (v == null ? DASH : fmt(v));

export const roundOrNull = v => (v == null ? null : Math.round(v));

export const pctText = r => r == null ? "" : r === 0 ? "0%"
  : r * 100 < 9.95 ? `${(r * 100).toFixed(1)}%` : `${Math.round(r * 100)}%`;

export const fmtPct = v => (v == null ? DASH : `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`);

export const fmtSeconds = v => v == null ? DASH
  : v < 10 ? `${v.toFixed(1)} s` : v < 120 ? `${Math.round(v)} s` : `${(v / 60).toFixed(1)} min`;

export const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

/**
 * Period-over-period change as {cls, text, title}, or null when there is
 * nothing to compare (no arrow at all, which is not "no change"). A previous
 * period of zero reads "new": a percentage of zero is not a number. A change
 * under half a percent is flat.
 */
export function delta(current, previous) {
  if (current == null || previous == null) return null;
  if (previous === 0) return { cls: "na", text: current === 0 ? DASH : "new" };
  const pct = (current - previous) / previous * 100;
  if (Math.abs(pct) < 0.5) return { cls: "flat", text: "→ 0%" };
  return { cls: pct > 0 ? "up" : "down",
           text: `${pct > 0 ? "↑" : "↓"} ${Math.abs(pct) >= 999 ? "999+" : Math.round(Math.abs(pct))}%` };
}

export function niceTicks(max, n = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || 10 * mag;
  const top = Math.ceil(max / step - 0.001) * step;
  const ticks = [];
  for (let v = 0; v <= top + step * 0.001; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

export function svgEl(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  return e;
}

export const css = name => getComputedStyle(document.body).getPropertyValue(name).trim();

/** Fills `text` into a template like "https://x/{id}?q={query}", URL-encoding each value. */
export function fillTemplate(template, vars) {
  if (!template) return null;
  let missing = false;
  const out = template.replace(/\{(\w+)\}/g, (_, k) => {
    if (vars[k] == null || vars[k] === "") { missing = true; return ""; }
    return encodeURIComponent(String(vars[k]));
  });
  return missing ? null : out;
}
