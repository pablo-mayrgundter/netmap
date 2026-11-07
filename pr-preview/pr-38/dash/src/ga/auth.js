// Google Identity Services token handling for the browser-direct transport.
//
// Access tokens last about an hour and cannot be extended, so the dashboard
// renews continuously and, wherever it can, silently. Several requests can be
// in flight at once (parallel GA queries, the background sweeper, a sign-in
// click), so the failure modes are orderings:
//
//   - concurrent renewals must coalesce onto one popup, except an explicit
//     sign-in click, which always starts fresh (it is the escape hatch from a
//     wedged silent attempt);
//   - a newer request supersedes an older one, decided synchronously at the
//     moment each is made, never after an await;
//   - a grant may be written unless a NEWER request has already written one:
//     a merely late grant (slow consent screen) is kept, a stale one never
//     overwrites a fresh token;
//   - the remembered account (`hint`) is what makes silent renewal work with
//     several Google accounts signed in, and is cleared only when an identity
//     change actually lands.
//
// Everything is in one factory with its dependencies injected, so the tests
// can drive each ordering by hand with a fake GIS.

export const SCOPE_ANALYTICS = "https://www.googleapis.com/auth/analytics.readonly";
const KEY_TOKEN = "bizdash.token", KEY_EMAIL = "bizdash.userEmail", KEY_AUTHED = "bizdash.hasAuthed";

export function createTokenManager({
  clientId,
  scopes = ["openid", "email", SCOPE_ANALYTICS],
  storage = globalThis.localStorage,
  win = globalThis,
  doc = globalThis.document,
  fetchFn = (...a) => globalThis.fetch(...a),
  leadMs = 60e3,                 // lazy path: renew when less than this remains
  refreshLeadMs = 300e3,         // sweeper: renew this far ahead
  requestTimeoutMs = 180e3,      // a consent screen plus phone 2FA can take a while
  forceAccountSelect = false,    // ?switch_account=1
  onSignInNeeded = () => {},
  onRecovered = () => {},
} = {}) {
  const store = {
    get: k => { try { return storage?.getItem(k) ?? null; } catch (e) { return null; } },
    set: (k, v) => { try { storage?.setItem(k, v); } catch (e) { /* blocked */ } },
    del: k => { try { storage?.removeItem(k); } catch (e) { /* blocked */ } },
  };
  // All mutable state in one object, so tests can read and reset it.
  const s = {
    accessToken: null, tokenExpiry: 0, gisPromise: null,
    tokenInFlight: null, tokenInFlightCtx: null, abandonInFlightGrant: null,
    tokenGeneration: 0, tokenWriteGen: 0, sweeperPaused: false, forceAccountSelect,
  };
  if (forceAccountSelect) { store.del(KEY_TOKEN); store.del(KEY_EMAIL); }
  try {
    const saved = JSON.parse(store.get(KEY_TOKEN) || "null");
    if (saved && saved.expiry > Date.now() + 120e3) { s.accessToken = saved.token; s.tokenExpiry = saved.expiry; }
  } catch (e) { /* corrupt entry */ }

  /** Memoized: a second gsi/client evaluation orphans callbacks on clients already handed out. */
  function loadGIS() {
    if (!s.gisPromise) {
      s.gisPromise = new Promise((res, rej) => {
        if (win.google?.accounts?.oauth2) return res();
        const el = doc.createElement("script");
        el.src = "https://accounts.google.com/gsi/client";
        el.onload = res;
        el.onerror = () => rej(new Error("could not load Google Identity Services"));
        doc.head.appendChild(el);
      }).catch(e => { s.gisPromise = null; throw e; });
    }
    return s.gisPromise;
  }

  const live = (lead = leadMs) => !!s.accessToken && Date.now() < s.tokenExpiry - lead;

  async function ensureToken({ leadMs: lead = leadMs, background = false, interactive = false } = {}) {
    if (!interactive && live(lead)) return;
    if (s.tokenInFlight && !interactive) {
      // a real caller joining a background renewal makes its failure visible
      if (!background && s.tokenInFlightCtx) s.tokenInFlightCtx.background = false;
      return followToken(s.tokenInFlight).catch(err => {
        throw Object.assign(new Error(err.message), { inherited: true, cause: err });
      });
    }
    const ctx = { background };
    s.tokenInFlightCtx = ctx;
    const mine = requestToken({ interactive, ctx });
    s.tokenInFlight = mine;
    try {
      await followToken(mine);
    } finally {
      if (s.tokenInFlight === mine) { s.tokenInFlight = null; s.tokenInFlightCtx = null; }
    }
  }

  /** Await a grant, following whatever superseded it: supersession is bookkeeping, not failure. */
  async function followToken(p) {
    try {
      await p;
    } catch (e) {
      if (e.superseded && s.tokenInFlight && s.tokenInFlight !== p) {
        return followToken(s.tokenInFlight).catch(err => {
          throw Object.assign(new Error(err.message), { inherited: true, cause: err });
        });
      }
      throw e;
    }
  }

  async function requestToken({ interactive = false, ctx = { background: false } } = {}) {
    // Claimed synchronously, before any await, so request order is the single
    // source of truth for both supersession and the write guard.
    let settled = false, superseded = false, timer = null;
    const myGen = ++s.tokenGeneration;
    let resolveGrant, rejectGrant;
    const grant = new Promise((a, b) => { resolveGrant = a; rejectGrant = b; });
    const finish = fn => (...args) => { if (settled) return; settled = true; clearTimeout(timer); fn(...args); };
    const ok = finish(resolveGrant), fail = finish(rejectGrant);
    if (s.abandonInFlightGrant) s.abandonInFlightGrant();
    const mySupersede = () => {
      superseded = true;
      fail(Object.assign(new Error("superseded by a newer sign-in request"), { superseded: true }));
    };
    s.abandonInFlightGrant = mySupersede;
    timer = setTimeout(() => fail(new Error("timed out waiting for Google sign-in")), requestTimeoutMs);
    try {
      await loadGIS().catch(e => { if (!superseded) throw e; });
      if (!superseded) {
        const chooseAccount = s.forceAccountSelect || interactive;
        // A fresh client per request: callbacks live on the client, so a
        // shared one would cross-wire concurrent requests.
        const client = win.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: scopes.join(" "),
          error_callback: e => fail(new Error(e?.type || "sign-in failed")),
          callback: t => {
            if (s.tokenWriteGen > myGen) return;          // a newer request already wrote
            if (t.error) return fail(new Error(t.error_description || t.error));
            s.accessToken = t.access_token;
            s.tokenExpiry = Date.now() + t.expires_in * 1000;
            s.tokenWriteGen = myGen;
            s.sweeperPaused = false;
            s.forceAccountSelect = false;                  // consumed where the grant lands
            store.set(KEY_TOKEN, JSON.stringify({ token: s.accessToken, expiry: s.tokenExpiry }));
            store.set(KEY_AUTHED, "1");
            if (chooseAccount) store.del(KEY_EMAIL);       // an identity change landed
            const sent = s.accessToken;
            fetchFn("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${sent}` } })
              .then(r => (r.ok ? r.json() : null))
              .then(u => { if (u?.email && s.tokenWriteGen === myGen) store.set(KEY_EMAIL, u.email); })
              .catch(() => {});
            onRecovered();
            ok();
          },
        });
        try {
          const hint = chooseAccount ? null : store.get(KEY_EMAIL);
          client.requestAccessToken(chooseAccount ? { prompt: "select_account" }
                                                  : { prompt: "", ...(hint ? { hint } : {}) });
        } catch (e) { fail(e); }
      }
      await grant;
    } catch (e) {
      if (!ctx.background && !e.superseded) onSignInNeeded(e);
      throw e;
    } finally {
      clearTimeout(timer);
      if (s.abandonInFlightGrant === mySupersede) s.abandonInFlightGrant = null;
    }
  }

  /** One background top-up attempt per broken window, never a bootstrap of a signed-out session. */
  function sweep({ visible = true } = {}) {
    if (!visible) return null;
    if (!s.accessToken || Date.now() >= s.tokenExpiry) return null;
    if (s.sweeperPaused) return null;
    return ensureToken({ leadMs: refreshLeadMs, background: true })
      .catch(e => { if (!e.inherited) s.sweeperPaused = true; });
  }

  /** The 401 path: drop the token we sent, unless a sibling has already replaced it. */
  function dropToken(sent) {
    if (s.accessToken === sent) { s.accessToken = null; store.del(KEY_TOKEN); }
  }

  function reset() {
    Object.assign(s, { accessToken: null, tokenExpiry: 0, tokenInFlight: null, tokenInFlightCtx: null,
      abandonInFlightGrant: null, tokenGeneration: 0, tokenWriteGen: 0, sweeperPaused: false });
    store.del(KEY_EMAIL); store.del(KEY_TOKEN);
  }

  return {
    state: s, loadGIS, ensureToken, requestToken, followToken, sweep, dropToken, reset, live,
    get token() { return s.accessToken; },
    hasAuthed: () => store.get(KEY_AUTHED) === "1",
    userEmail: () => store.get(KEY_EMAIL),
  };
}
