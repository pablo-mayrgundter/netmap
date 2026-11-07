// Google Analytics 4, opt-in only (README: Analytics).
//
// Nothing loads, and nothing leaves the page, unless the build has a
// measurement ID (VITE_GA_MEASUREMENT_ID) and the viewer says yes. Until then
// track() queues; "No thanks" drops the queue. Do Not Track and Global Privacy
// Control turn it off without asking. Dev servers and tests are off unless
// ?ga_debug=1 or VITE_GA_FORCE=1 asks.
//
// netmap's hash holds the whole view (camera, route, sliders), so the URL is
// never sent as it is: page_location is the origin and path, and every event
// carries a `view` param (mode:view:dataset) instead. Parameters are low
// cardinality: names, ids, ASNs, counts; never typed text.
//
// createAnalytics is the logic, with the browser passed in, so node can test
// it (analytics.test.js); `analytics` and `track` are this page's instance.

export const GTAG_SRC = 'https://www.googletagmanager.com/gtag/js';
export const STORAGE_KEY = 'netmap.analytics'; // 'granted' | 'denied'
const QUEUE_MAX = 100;

const KEY = /^[a-z][a-z0-9_]{0,39}$/; // event and parameter names
const VALUE = /^[A-Za-z0-9_.:-]{1,64}$/; // string values: no spaces, '#', '=', '&', '/' or '?'
// GA's own page fields: set once from the sanitized location, never per event.
const RESERVED = new Set(['page_location', 'page_referrer', 'page_title', 'page_path', 'send_to', 'event_callback', 'user_id', 'client_id']);
// Free text: only its length or its result is sent.
const FREE_TEXT = new Set(['q', 'query', 'search_term', 'term', 'text', 'input']);

/** Params fit to send: known-safe keys, finite numbers, 0/1 for booleans, short tokens. */
export function sanitizeParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (!KEY.test(k) || RESERVED.has(k) || FREE_TEXT.has(k)) continue;
    if (typeof v === 'number') {
      if (Number.isFinite(v)) out[k] = Math.round(v * 1000) / 1000;
    } else if (typeof v === 'boolean') out[k] = v ? 1 : 0;
    else if (typeof v === 'string' && VALUE.test(v)) out[k] = v;
  }
  return out;
}

const MODES = ['cyber', 'hybrid', 'geo'];
const VIEWS = ['map', 'globe'];

/** The view, as one low-cardinality token: 'geo:globe:internet'. */
export function viewParam({ mode, view, dataset } = {}) {
  const m = MODES.includes(mode) ? mode : 'other';
  const v = VIEWS.includes(view) ? view : 'other';
  const d = typeof dataset === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(dataset) ? dataset : dataset ? 'other' : 'none';
  return `${m}:${v}:${d}`;
}

/** The page's address without its query or hash. */
export function pageLocation(loc) {
  return `${loc.origin}${loc.pathname}`;
}

/** A count as a bucket: 'lt1k', '1k-10k', '10k-100k', '100k-1m', 'gte1m'. */
export function countBucket(n) {
  if (!(n >= 1000)) return 'lt1k';
  if (n < 1e4) return '1k-10k';
  if (n < 1e5) return '10k-100k';
  if (n < 1e6) return '100k-1m';
  return 'gte1m';
}

/** The browser asks not to be tracked: Do Not Track or Global Privacy Control. */
export function privacySignal(nav = {}, win = {}) {
  const dnt = nav.doNotTrack ?? win.doNotTrack ?? nav.msDoNotTrack;
  return dnt === '1' || dnt === 'yes' || nav.globalPrivacyControl === true;
}

/**
 * Whether this build and page may run the tag at all, and in debug mode.
 * A production build with an ID runs; a dev server or test only when forced.
 */
export function gate({ id, prod = false, force = false, search = '' }) {
  const debug = new URLSearchParams(search).get('ga_debug') === '1';
  return { enabled: !!id && (prod || force || debug), debug };
}

/**
 * The analytics instance.
 *  id            measurement ID (G-…), or '' for none: then everything is a no-op
 *  enabled       gate().enabled: the build and page allow it
 *  debug         GA's DebugView (debug_mode)
 *  blocked       privacySignal(): off, and never asks
 *  storage       localStorage-like (getItem/setItem/removeItem), may throw
 *  host          where dataLayer and gtag live (window)
 *  loadScript    (src) => void: adds the gtag.js script
 *  location      { origin, pathname }
 *  clearCookies  () => void: drops GA's cookies when consent is withdrawn
 */
export function createAnalytics({
  id = '',
  enabled = true,
  debug = false,
  blocked = false,
  storage = null,
  host = {},
  loadScript = () => {},
  location = { origin: '', pathname: '/' },
  clearCookies = () => {},
} = {}) {
  const live = !!id && enabled; // a tag could run here
  let choice = live && !blocked ? read() : null; // 'granted' | 'denied' | null (not asked)
  let queue = [];
  let started = false;
  let viewOf = () => ({});
  const listeners = new Set();

  function read() {
    try {
      const v = storage?.getItem(STORAGE_KEY);
      return v === 'granted' || v === 'denied' ? v : null;
    } catch {
      return null;
    }
  }
  function write(v) {
    try {
      storage?.setItem(STORAGE_KEY, v);
    } catch {
      /* private mode, blocked storage: the choice lasts this page */
    }
  }

  // gtag pushes its `arguments` object, as Google's snippet does: gtag.js
  // reads Arguments entries as commands and plain arrays as something else.
  function gtag() {
    host.dataLayer.push(arguments);
  }

  function start() {
    if (started) {
      gtag('consent', 'update', { analytics_storage: 'granted' });
    } else {
      started = true;
      host.dataLayer = host.dataLayer || [];
      host.gtag = gtag;
      const page = { page_location: pageLocation(location), page_title: 'netmap' };
      gtag('consent', 'default', {
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
        analytics_storage: 'denied',
      });
      gtag('set', 'ads_data_redaction', true);
      gtag('consent', 'update', { analytics_storage: 'granted' });
      gtag('set', { ...page, allow_google_signals: false, allow_ad_personalization_signals: false });
      gtag('js', new Date());
      gtag('config', id, {
        ...page,
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
        view: viewParam(viewOf()),
        ...(debug ? { debug_mode: true } : {}),
      });
      loadScript(`${GTAG_SRC}?id=${encodeURIComponent(id)}`);
    }
    const q = queue;
    queue = [];
    for (const [name, params] of q) gtag('event', name, params);
  }

  function changed() {
    for (const f of listeners) f(api.status());
  }

  const api = {
    /** 'off' (no ID, or not this build), 'blocked' (DNT/GPC), 'pending', 'granted' or 'denied'. */
    status() {
      if (!live) return 'off';
      if (blocked) return 'blocked';
      return choice ?? 'pending';
    },
    /** The banner should ask: a tag could run, and nobody has said yes or no. */
    needsPrompt: () => api.status() === 'pending',
    grant() {
      if (!live || blocked) return;
      choice = 'granted';
      write('granted');
      start();
      changed();
    },
    deny() {
      if (!live || blocked) return;
      const was = choice;
      choice = 'denied';
      write('denied');
      queue = [];
      if (was === 'granted' && started) {
        gtag('consent', 'update', { analytics_storage: 'denied' });
        clearCookies();
      }
      changed();
    },
    /** One event. Queued until the viewer chooses; sent once they allow it. */
    track(name, params = {}) {
      const s = api.status();
      if (s === 'off' || s === 'blocked' || s === 'denied') return;
      if (typeof name !== 'string' || !KEY.test(name)) return;
      const p = { ...sanitizeParams(params), view: viewParam(viewOf()) };
      if (s === 'granted') gtag('event', name, p);
      else if (queue.length < QUEUE_MAX) queue.push([name, p]);
    },
    /** What the `view` param describes: () => ({ mode, view, dataset }). */
    setView(f) {
      viewOf = f;
    },
    onChange(f) {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    queued: () => queue.length,
  };
  if (choice === 'granted') start();
  return api;
}

// --- this page -----------------------------------------------------------

function browserAnalytics() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return createAnalytics();
  const env = import.meta.env || {};
  const id = String(env.VITE_GA_MEASUREMENT_ID || '').trim();
  const { enabled, debug } = gate({ id, prod: !!env.PROD, force: env.VITE_GA_FORCE === '1', search: location.search });
  let storage = null;
  try {
    storage = window.localStorage;
  } catch {
    /* blocked: the choice isn't remembered */
  }
  return createAnalytics({
    id,
    enabled,
    debug,
    blocked: privacySignal(navigator, window),
    storage,
    host: window,
    location: window.location,
    loadScript: (src) => {
      const s = document.createElement('script');
      s.async = true;
      s.src = src;
      document.head.appendChild(s);
    },
    clearCookies: () => {
      const host = location.hostname.split('.');
      const domains = host.map((_, i) => host.slice(i).join('.')).concat(['']);
      for (const c of document.cookie.split(';')) {
        const name = c.split('=')[0].trim();
        if (!/^_ga/.test(name)) continue;
        for (const d of domains) document.cookie = `${name}=; Max-Age=0; path=/${d ? `; domain=${d}` : ''}`;
      }
    },
  });
}

export const analytics = browserAnalytics();

/** Records an event: track('app_open', { app_id: 'celestiary' }). A no-op without consent or an ID. */
export function track(name, params) {
  analytics.track(name, params);
}
