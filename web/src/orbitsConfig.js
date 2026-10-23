// Where the Orbits layer's guest page comes from (see README, "Orbits").
//
// The guest is celestiary's layer mode (layer.html), embedded as a
// cross-origin iframe. Its GL calls replay into the globe's own context, so
// the page that may supply them is a security decision, made here and only
// here:
//   - the default is production, https://celestiary.org/layer.html;
//   - a build can point elsewhere with VITE_ORBITS_SRC, and add origins to
//     the allow-list with VITE_ORBITS_ORIGINS (comma-separated);
//   - a link can pick another page with ?orbits_src=<url>, but only on an
//     allowed origin (so the #296 preview, on celestiary.org, works and an
//     arbitrary site doesn't);
//   - localhost and 127.0.0.1, any port, are allowed only in a dev server or
//     when netmap itself is served from one of them.
// Pure (no DOM, no import.meta), so `npm test` checks it in node.

export const DEFAULT_ORBITS_SRC = 'https://celestiary.org/layer.html';

/** Origins any build may load the guest from. */
export const BUILT_IN_ORBITS_ORIGINS = ['https://celestiary.org'];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether `origin` is a loopback origin (any port). */
export function isLocalOrigin(origin) {
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** Comma-separated origins from a build variable; anything that isn't a bare origin is dropped. */
export function parseOrigins(list) {
  if (typeof list !== 'string') return [];
  return list
    .split(',')
    .map((s) => s.trim())
    .filter((s) => {
      try {
        return s !== '' && new URL(s).origin === s;
      } catch {
        return false;
      }
    });
}

/**
 * Whether the guest may come from `origin`.
 * @param {string} origin a serialized origin, e.g. 'https://celestiary.org'
 * @param {{ extra?: string[], allowLocal?: boolean }} opts
 */
export function isAllowedOrbitsOrigin(origin, { extra = [], allowLocal = false } = {}) {
  if (typeof origin !== 'string' || origin === 'null') return false;
  if (BUILT_IN_ORBITS_ORIGINS.includes(origin) || extra.includes(origin)) return true;
  return allowLocal && isLocalOrigin(origin);
}

/**
 * The guest page to load: the URL param if it's allowed, else the build's
 * choice, else production.
 * @param {object} opts
 * @param {string|null} [opts.param] `?orbits_src=`
 * @param {string} [opts.envSrc] VITE_ORBITS_SRC
 * @param {string} [opts.envOrigins] VITE_ORBITS_ORIGINS
 * @param {string} opts.pageOrigin netmap's own origin (location.origin)
 * @param {boolean} [opts.dev] a dev server (import.meta.env.DEV)
 * @returns {{ src: string, origin: string, rejected: string|null }}
 *   `rejected` names a `param` that was refused, for a notice
 */
export function resolveOrbitsSrc({ param = null, envSrc = '', envOrigins = '', pageOrigin, dev = false }) {
  const extra = parseOrigins(envOrigins);
  const allowLocal = dev || isLocalOrigin(pageOrigin);
  const check = (s, trusted) => {
    let u;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalOrigin(u.origin))) return null;
    if (u.username || u.password) return null;
    // The build's own choice is trusted for its origin; a link's isn't.
    if (!trusted && !isAllowedOrbitsOrigin(u.origin, { extra, allowLocal })) return null;
    if (trusted && isLocalOrigin(u.origin) && !allowLocal) return null;
    return { src: u.href, origin: u.origin };
  };
  let rejected = null;
  if (param) {
    const ok = check(param, false);
    if (ok) return { ...ok, rejected };
    rejected = param;
  }
  if (envSrc) {
    const ok = check(envSrc, true);
    if (ok) return { ...ok, rejected };
  }
  return { ...check(DEFAULT_ORBITS_SRC, true), rejected };
}

/** The guest's query: what to draw. */
export function orbitsQuery({ sats, starlink, iridium, dsn }) {
  const nets = [starlink && 'S', iridium && 'I', dsn && 'D'].filter(Boolean);
  return { nets: nets.join(','), sats: sats ? '1' : '0', any: sats || nets.length > 0 };
}
