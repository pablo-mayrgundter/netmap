// The apps' part of the permalink (README in this folder):
//
//   app=<id>        the open app (none: no key)
//   side=0|1        its panel shown (1) or collapsed to the rail / the drawer's peek (0)
//   <id>.<key>=v    the open app's own params (ctx.hash), only the open app's
//
// main.js's hashParams writes these after its own keys, and applyHash hands
// an edited hash here. DOM-free, so node's tests import it.

export const APP_KEY = 'app';
export const SIDE_KEY = 'side';
// An app's own key: short, and nothing a URL would escape.
export const PARAM_KEY = /^[a-z0-9_-]{1,32}$/;

export const paramKey = (app, key) => `${app}.${key}`;

/**
 * The apps' state in a hash (URLSearchParams): { app, side, params }, with
 * params the open app's own, by their short keys. `known(id)` says whether
 * an app id is registered; an unknown one reads as no app.
 */
export function readAppHash(h, known = () => true) {
  const id = h.get(APP_KEY);
  const app = id && known(id) ? id : null;
  const side = h.get(SIDE_KEY);
  const params = {};
  if (app) {
    const pre = `${app}.`;
    for (const [k, v] of h) if (k.startsWith(pre) && PARAM_KEY.test(k.slice(pre.length))) params[k.slice(pre.length)] = v;
  }
  return { app, side: side === null ? true : side === '1' || side === 'true', params };
}

/** Write the apps' state into `h` (URLSearchParams); keys sorted, so links compare. */
export function writeAppHash(h, { app, side = true, params = {} }) {
  for (const k of [...h.keys()]) if (k === APP_KEY || k === SIDE_KEY || /^[a-z][a-z0-9-]*\./.test(k)) h.delete(k);
  if (!app) return h;
  h.set(APP_KEY, app);
  h.set(SIDE_KEY, side ? '1' : '0');
  for (const k of Object.keys(params).sort()) {
    const v = params[k];
    if (v !== null && v !== undefined && v !== '') h.set(paramKey(app, k), String(v));
  }
  return h;
}

/** Two apps' params (key -> string) hold the same values. */
export function sameParams(a, b) {
  const ka = Object.keys(a).filter((k) => a[k] !== undefined && a[k] !== null);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined && b[k] !== null);
  return ka.length === kb.length && ka.every((k) => String(a[k]) === String(b[k]));
}

/**
 * What an edited hash changes for the apps, against the state now: `app`
 * (a different app, or none), `side`, and `params` (the same app, other params).
 */
export function appHashChanges(next, now) {
  return {
    app: next.app !== now.app,
    side: !!next.app && next.side !== now.side,
    params: !!next.app && next.app === now.app && !sameParams(next.params, now.params),
  };
}
