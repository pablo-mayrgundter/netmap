// Bootstrap: load the deployment config, pick a transport, register the core
// cards and the deployment's plugins, and start polling.
//
// Three transports behind one GA client:
//   demo    ?demo=1: the synthetic Data API in this page, no setup at all
//   server  served by `bizdash serve`: its api/ga/* proxy holds the credentials
//   direct  static hosting: the viewer's own Google sign-in, straight to GA
// The page probes api/meta to tell server from static hosting: the server
// answers with its property, and the static build ships api/meta as
// {"static": true} so the probe gets a 200 rather than a logged 404.

import { isSafeConfigPath, loadConfig } from "./config.js";
import { createDashboard, loadPlugins, VERSION } from "./dashboard.js";
import { registerCoreCards, rangeButtonLabel } from "./cards/core.js";
import { createGA, demoTransport, directTransport, serverTransport } from "./ga/client.js";
import { createDemoApi } from "./ga/demo.js";
import { createTokenManager, MISSING_SCOPE_MESSAGE } from "./ga/auth.js";
import { fmt } from "./format.js";

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);

function notice(msg, html = false) {
  const n = $("notice");
  if (html) n.innerHTML = msg; else n.textContent = msg;
  n.classList.toggle("show", !!msg);
}

async function serverMeta() {
  try {
    const r = await fetch("api/meta", { cache: "no-cache" });
    if (!r.ok) return null;
    const m = await r.json();
    return m && !m.static ? m : null;
  } catch (e) { return null; }
}

function scrubUrl(keys) {
  const q = new URLSearchParams(location.search);
  let changed = false;
  for (const k of keys) if (q.has(k)) { q.delete(k); changed = true; }
  if (changed) history.replaceState(null, "", location.pathname + (q.size ? `?${q}` : "") + location.hash);
}

function setProperty(cfg, mode) {
  const a = $("prop");
  if (!cfg.propertyId || mode === "demo") { a.textContent = ""; a.removeAttribute("href"); return; }
  a.textContent = `GA4 property ${cfg.propertyId}`;
  a.href = cfg.links.ga.replace("{propertyId}", encodeURIComponent(cfg.propertyId));
}

function buildControls(dash) {
  const cfg = dash.config;
  const range = $("rangeToggle");
  for (const m of cfg.ranges) {
    const b = document.createElement("button");
    b.type = "button"; b.dataset.minutes = String(m); b.textContent = rangeButtonLabel(m);
    range.appendChild(b);
  }
  const sync = () => {
    for (const b of range.querySelectorAll("button")) b.setAttribute("aria-pressed", String(+b.dataset.minutes === dash.state.minutes));
    for (const b of $("segmentToggle").querySelectorAll("button"))
      b.setAttribute("aria-pressed", String(b.dataset.segment === dash.state.segment));
  };
  range.addEventListener("click", ev => {
    const b = ev.target.closest("button[data-minutes]");
    if (b && +b.dataset.minutes !== dash.state.minutes) dash.setState({ minutes: +b.dataset.minutes });
  });
  if (dash.segmentsEnabled) {
    const seg = $("segmentToggle");
    seg.hidden = false;
    for (const b of seg.querySelectorAll("button")) b.textContent = dash.segLabel(b.dataset.segment);
    $("segmentRule").textContent = `rule: ${cfg.traffic.label}`;
    $("segmentRule").title = `rev ${cfg.traffic.rev}`;
    seg.addEventListener("click", ev => {
      const b = ev.target.closest("button[data-segment]");
      if (b && !b.disabled && b.dataset.segment !== dash.state.segment) dash.setState({ segment: b.dataset.segment });
    });
  }
  dash.on("state", sync);
  sync();
}

function footer(dash) {
  const f = $("pageFoot");
  const q = dash.ga.quota;
  const parts = [`bizdash ${VERSION}`, `${dash.mode} data`];
  if (dash.config.traffic) parts.push(`traffic rule ${dash.config.traffic.rev}`);
  if (q?.tokensPerHour) parts.push(`GA quota: ${fmt(q.tokensPerHour.remaining)} tokens left this hour, `
    + `${fmt(q.tokensPerDay?.remaining)} today`);
  f.textContent = parts.join(" · ");
  // links.extra: [{label, url}] from the config, e.g. a team runbook
  for (const l of dash.config.links.extra || []) {
    if (!l?.url || !/^https?:\/\//.test(l.url)) continue;
    const a = document.createElement("a");
    a.href = l.url; a.textContent = l.label || l.url; a.target = "_blank"; a.rel = "noopener";
    f.append(" · ", a);
  }
}

async function start() {
  const requested = params.get("config");
  const configPath = requested && isSafeConfigPath(requested) ? requested : "bizdash.config.json";
  if (requested && configPath !== requested) console.warn(`bizdash: ignoring unsafe ?config=${requested}`);
  const configUrl = new URL(configPath, location.href).href;
  let config;
  try {
    config = await loadConfig({ url: configUrl, params, storage: localStorage });
  } catch (e) {
    notice(`Could not load the dashboard config: ${e.message}`);
    $("liveNote").textContent = "not configured";
    return;
  }
  scrubUrl(["client_id", "property", "switch_account"]);
  $("title").textContent = config.title;
  document.title = config.title;

  const demo = params.get("demo") === "1";
  const meta = demo ? null : await serverMeta();
  const mode = demo ? "demo" : meta ? "server" : "direct";
  let transport, tokens = null;
  const startedDirect = { done: false };
  if (mode === "demo") transport = demoTransport(createDemoApi(config));
  else if (mode === "server") {
    transport = serverTransport();
    if (meta.property_id) config = { ...config, propertyId: String(meta.property_id) };
  } else {
    tokens = createTokenManager({
      clientId: config.clientId,
      forceAccountSelect: params.get("switch_account") === "1",
      onSignInNeeded: () => { $("signin").hidden = false; $("liveNote").textContent = "paused — sign in to resume"; },
      onRecovered: () => { if (startedDirect.resume) startedDirect.resume(); },
    });
    transport = directTransport({ tokens, propertyId: config.propertyId,
      onSessionExpired: (why = {}) => {
        $("signin").hidden = false;
        if (why.missingScope) notice(MISSING_SCOPE_MESSAGE);
      } });
  }
  const ga = createGA({ transport, mode, maxConcurrent: config.ga.maxConcurrent,
    reportTtlMs: config.ga.reportCacheSeconds * 1000, realtimeTtlMs: config.ga.realtimeCacheSeconds * 1000 });
  $("demoBadge").hidden = !(mode === "demo" || meta?.demo);
  setProperty(config, meta?.demo ? "demo" : mode);

  const dash = createDashboard({ config, ga, mode: meta?.demo ? "demo" : mode, root: $("grid"), params });
  window.bizdash = { dash, ga, config, tokens, VERSION, mode };
  registerCoreCards(dash);
  const failures = await loadPlugins(dash, configUrl);
  buildControls(dash);
  dash.on("loaded", id => { if (id === "users" || id === "chart") dash.rerender(); footer(dash); });
  footer(dash);

  $("copyData").addEventListener("click", async () => {
    const text = dash.snapshot();
    try { await navigator.clipboard.writeText(text); $("copyData").textContent = "Copied"; }
    catch (e) { console.info(text); $("copyData").textContent = "Copy failed (see console)"; }
    setTimeout(() => { $("copyData").textContent = "Copy data"; }, 2000);
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => dash.rerender(), 120); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => dash.rerender());

  const run = () => {
    $("liveNote").textContent = `live — refreshes every ${config.refresh.realtimeSeconds} s`;
    const mounted = dash.mount({ notice: $("notice"), actions: $("headerActions") });
    setInterval(() => dash.loadAll(["realtime"]), config.refresh.realtimeSeconds * 1000);
    setInterval(() => dash.loadAll(["range"]), config.refresh.rangeSeconds * 1000);
    if (failures.length) dash.showNotice(`Some plugins failed to load: ${failures.join("; ")}.`, "plugins");
    return mounted;
  };
  if (mode !== "direct") return run();

  if (!config.clientId || !config.propertyId) {
    notice("This deployment has no Google OAuth client ID or GA4 property yet. Set <code>clientId</code> and "
      + "<code>propertyId</code> in <code>bizdash.config.json</code>, or open this page with "
      + "<code>?client_id=…&amp;property=…</code> (remembered in this browser). "
      + 'Zero-setup synthetic data: <a href="?demo=1">view the demo</a>.', true);
    $("liveNote").textContent = "not configured";
    return null;
  }
  const startDirect = () => {
    $("signin").hidden = true;
    if (startedDirect.done) { dash.loadAll(["range", "realtime"]); return; }
    startedDirect.done = true;
    run();
  };
  startedDirect.resume = startDirect;
  $("signin").addEventListener("click", async () => {
    try { await tokens.ensureToken({ interactive: true }); startDirect(); }
    catch (e) { notice(`Google sign-in failed: ${e.message}`); }
  });
  setInterval(() => tokens.sweep({ visible: document.visibilityState === "visible" }), 60e3);
  if (tokens.live()) return startDirect();
  $("signin").hidden = false;
  $("liveNote").textContent = "sign in to load data";
  if (tokens.hasAuthed()) tokens.ensureToken().then(startDirect).catch(() => {});
  return null;
}

window.bizdashReady = start().catch(e => {
  console.error(e);
  notice(`The dashboard failed to start: ${e.message}`);
});
