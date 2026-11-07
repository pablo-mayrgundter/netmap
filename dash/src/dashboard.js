// The dashboard runtime: a registry of cards (core and plugin alike), the
// shared view state, the context each card receives, layout, and the
// load/render lifecycle. Core cards are defined through exactly the same
// defineCard() a plugin uses, so the plugin API is the one the core relies on.

import * as format from "./format.js";
import * as rows from "./ga/rows.js";
import * as rules from "./rules.js";
import * as time from "./time.js";
import * as charts from "./ui/charts.js";
import * as reports from "./core/reports.js";

export const VERSION = "0.1.1";
const { el } = format;
const CARD_ID = /^[a-z0-9][a-z0-9:_.-]*$/i;
const REFRESH = new Set(["range", "realtime", "once"]);
const KINDS = new Set(["card", "tile", "frameless"]);

function sizeOf(def) {
  if (def.kind === "tile") return "tile";
  return def.span <= 4 ? "third" : def.span <= 8 ? "wide" : "full";
}

/**
 * Where a card's storage lives: per mode, and per property outside the demo,
 * so synthetic data never lands under a real property's key (a demo page can
 * carry a configured property id).
 */
export const storageScope = (mode, propertyId) =>
  (mode === "demo" || !propertyId ? String(mode) : `${mode}:${propertyId}`);

export function createDashboard({ config, ga, mode, root, storage = globalThis.localStorage, params = new URLSearchParams() }) {
  const cards = new Map();           // id -> {def, frame, data, error, gen, index}
  const listeners = new Map();
  const headerActions = [];
  const footnotes = new Map();       // cardId -> Map(key -> text)
  let registered = 0, mounted = false, loadGen = 0;
  const segmentsEnabled = !!config.traffic;
  const state = { minutes: config.defaultRange, bucket: "hour", segment: segmentsEnabled ? config.traffic.default : "all" };
  const rangeParam = +params.get("range");
  if (config.ranges.includes(rangeParam)) state.minutes = rangeParam;
  if (segmentsEnabled) {
    let kept = null;
    try { kept = storage?.getItem("bizdash.segment"); } catch (e) { kept = null; }
    const fromUrl = params.get("segment");
    if (rows.SEGMENTS.includes(fromUrl)) state.segment = fromUrl;
    else if (rows.SEGMENTS.includes(kept)) state.segment = kept;
  }

  const emit = (event, ...args) => {
    for (const fn of listeners.get(event) || []) {
      try { fn(...args); } catch (e) { console.error(`bizdash: "${event}" listener failed`, e); }
    }
  };
  const on = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event).delete(fn);
  };

  // ---- shared core data, memoized per load generation ----------------------
  let memo = new Map();
  const shared = (key, fn) => {
    const k = `${loadGen}:${key}`;
    if (!memo.has(k)) memo.set(k, fn().catch(e => { memo.delete(k); throw e; }));
    return memo.get(k);
  };
  let latestHour = null;              // GA's latest reported hour: "now" in property time
  const core = {
    get latest() { return latestHour; },
    timeseries: () => shared(`ts:${state.minutes}`, () => (time.isRealtimeRange(state.minutes)
      ? reports.realtimeRange(ga, config) : reports.timeseries(ga, config, state.minutes))
      .then(d => { if (d.latest && (!latestHour || d.latest > latestHour)) latestHour = d.latest; return d; })),
    /** The anchored window {start, end} the chart settled on, or null (realtime range). */
    window: async () => (await core.timeseries()).window,
    breakdowns: () => shared(`bd:${state.minutes}`, () => reports.breakdowns(ga, config, state.minutes)),
    funnel: () => (config.funnel ? shared(`fn:${state.minutes}`, () => reports.funnel(ga, config, state.minutes))
                                 : Promise.resolve(null)),
    conversions: () => (config.conversions ? shared("cv", () => reports.conversions(ga, config)) : Promise.resolve(null)),
    tiles: () => shared(`tiles:${state.minutes}`, () => reports.keyEventTiles(ga, config, state.minutes)),
    realtime: () => reports.realtime(ga, config),
    spike: (start, end) => shared(`spike:${start}:${end}`, () => reports.spikeDrill(ga, config, start, end)),
    trafficProfile: () => shared(`tp:${state.minutes}`, () => reports.trafficProfile(ga, config, state.minutes)),
  };

  const segLabel = seg => (config.traffic?.labels || {})[seg] || seg;
  const internalIds = config.internalUsers?.ids || {};

  function scopedStorage(id) {
    const prefix = `bizdash.card.${id}.${storageScope(mode, config.propertyId)}.`;
    return {
      get(k) { try { return JSON.parse(storage.getItem(prefix + k)); } catch (e) { return null; } },
      set(k, v) { try { storage.setItem(prefix + k, JSON.stringify(v)); } catch (e) { /* blocked or full */ } },
      remove(k) { try { storage.removeItem(prefix + k); } catch (e) { /* blocked */ } },
      clear() {
        try { for (const k of Object.keys(storage)) if (k.startsWith(prefix)) storage.removeItem(k); } catch (e) { /* blocked */ }
      },
    };
  }

  function contextFor(entry, gen = loadGen) {
    const { def, frame } = entry;
    const minutes = state.minutes;
    const dayMinutes = Math.max(minutes, time.MINUTES_PER_DAY);
    return Object.freeze({
      config, mode, version: VERSION,
      state: Object.freeze({ ...state }),
      range: Object.freeze({
        minutes, label: time.rangeLabel(minutes), tileLabel: time.tileRangeLabel(minutes),
        isRealtime: time.isRealtimeRange(minutes), dayMinutes, daySpan: time.daySpanLabel(minutes),
        start: time.rangeStart(dayMinutes), dateRanges: [{ startDate: time.rangeStart(dayMinutes), endDate: "today" }],
      }),
      ga, core,
      comparisons: reports.comparisonsFor(config),
      segments: Object.freeze({
        enabled: segmentsEnabled, current: state.segment, label: segLabel, rule: config.traffic?.rule || null,
        view: data => reports.segmentView(data, state.segment),
        ranked: body => reports.rankedReport(ga, body, reports.comparisonsFor(config)),
        applied: data => reports.appliedSegment(data, state.segment),
        isNonstandard: row => (config.traffic ? rules.isNonstandard(row, config.traffic.rule) : null),
        classifyHosts: hosts => (config.traffic ? rules.classifyHosts(hosts, config.traffic.rule) : null),
      }),
      filters: Object.freeze({ and: rows.and, or: rows.or, not: rows.not, inList: rows.inList, equals: rows.equals,
        events: rows.events, withFilter: rows.withFilter, internalExclusion: () => reports.internalExclusion(config) }),
      internal: Object.freeze({
        dimension: config.internalUsers?.dimension || null, ids: Object.keys(internalIds),
        label: id => internalIds[id] || null, isInternal: id => id in internalIds,
        exclusion: () => reports.internalExclusion(config),
      }),
      time, format, rows, rules,
      links: Object.freeze({
        ga: () => (config.propertyId && mode !== "demo" ? format.fillTemplate(config.links.ga, { propertyId: config.propertyId }) : null),
        errorTracker: vars => format.fillTemplate(config.links.errorTracker, vars),
        fill: (template, vars) => format.fillTemplate(template, vars),
      }),
      ui: Object.freeze({ ...charts, el: format.el, svgEl: format.svgEl, notice: msg => showNotice(msg, def.id), gapList }),
      storage: scopedStorage(def.id),
      card: frame.api,
      dashboard: Object.freeze({
        footnote: setFootnote, refresh: id => loadCard(cards.get(id)), data: id => cards.get(id)?.data,
        snapshot, on, emit, setState: patch => setState(patch),
      }),
      stale: () => gen !== loadGen && def.refresh === "range",
    });
  }

  function gapList(gaps) {
    const box = el("div", "sub gaps");
    if (!gaps?.length) return box;
    box.textContent = `Not available: ${gaps.map(g => `${g.field || g.part} (${g.reason})`).join("; ")}`;
    return box;
  }

  // ---- registration ---------------------------------------------------------------
  function defineCard(def) {
    if (!def || typeof def !== "object") throw new Error("defineCard: expected a card definition object");
    if (!CARD_ID.test(def.id || "")) throw new Error(`defineCard: invalid id ${JSON.stringify(def.id)}`);
    if (cards.has(def.id)) throw new Error(`defineCard: a card "${def.id}" is already defined`);
    if (typeof def.render !== "function") throw new Error(`defineCard(${def.id}): render(body, data, ctx) is required`);
    const d = { kind: "card", span: 12, refresh: "range", order: 1000, followsSegment: false, ...def };
    if (!KINDS.has(d.kind)) throw new Error(`defineCard(${d.id}): kind must be card, tile or frameless`);
    if (!REFRESH.has(d.refresh)) throw new Error(`defineCard(${d.id}): refresh must be range, realtime or once`);
    if (!(d.span >= 1 && d.span <= 12)) throw new Error(`defineCard(${d.id}): span must be 1..12`);
    cards.set(d.id, { def: d, frame: null, data: undefined, error: null, gen: 0, index: registered++ });
    if (mounted) { layout(); loadCard(cards.get(d.id)); }
    return d.id;
  }

  function addHeaderAction({ id, label, title = "", onClick }) {
    if (!id || !label || typeof onClick !== "function") throw new Error("addHeaderAction: id, label and onClick are required");
    headerActions.push({ id, label, title, onClick });
    if (mounted) renderHeaderActions();
  }

  // ---- frames and layout -------------------------------------------------------------
  function makeFrame(entry) {
    const { def } = entry;
    const node = el("section", `card ${def.kind === "tile" ? "tile" : ""} ${def.kind === "frameless" ? "frameless" : ""}`.trim());
    node.id = `card-${def.id.replace(/[^a-z0-9_-]/gi, "-")}`;
    node.dataset.card = def.id;
    node.dataset.size = sizeOf(def);
    node.style.setProperty("--span", String(def.span));
    const head = el("div", "card-head");
    const h2 = el("h2", "", def.title ?? "");
    const tools = el("div", "card-tools");
    head.append(h2, tools);
    const segSub = el("p", "seg-sub");
    const body = el("div", "card-body");
    const foot = el("div", "card-foot");
    const tip = el("div", "tooltip");
    if (def.title != null || def.kind !== "frameless") node.append(head);
    node.append(segSub, body, foot, tip);
    const api = Object.freeze({
      id: def.id, el: node, body, tools, tip,
      setTitle: t => { h2.textContent = t; },
      setSubtitle: content => {
        segSub.textContent = "";
        if (content instanceof Node) segSub.appendChild(content); else if (content) segSub.textContent = content;
      },
      /** "Traffic filter: Standard", naming the segment a card's numbers reflect, under All too. */
      setFilter: (data, { follows = true } = {}) => {
        if (!segmentsEnabled) { segSub.textContent = ""; return; }
        const seg = follows ? reports.appliedSegment(data, state.segment) : "all";
        segSub.textContent = `Traffic filter: ${segLabel(seg)}`;
        segSub.title = seg === state.segment ? `Rule: ${config.traffic.label} (${config.traffic.rev})`
          : `This card cannot follow the traffic filter, so it shows ${segLabel("all")}.`;
      },
      setFoot: text => { entry.ownFoot = text || ""; renderFoot(entry); },
    });
    entry.frame = { node, body, foot, api };
  }

  function renderFoot(entry) {
    const foot = entry.frame.foot;
    foot.textContent = "";
    const notes = [entry.ownFoot, ...(footnotes.get(entry.def.id)?.values() || [])].filter(Boolean);
    for (const n of notes) foot.appendChild(el("p", "foot-note", n));
  }
  function setFootnote(cardId, key, text) {
    if (!footnotes.has(cardId)) footnotes.set(cardId, new Map());
    if (text) footnotes.get(cardId).set(key, text); else footnotes.get(cardId).delete(key);
    const entry = cards.get(cardId);
    if (entry?.frame) renderFoot(entry);
  }

  function ordered() {
    const hide = new Set(config.layout.hide || []);
    const explicit = config.layout.order || [];
    const list = [...cards.values()].filter(c => !hide.has(c.def.id));
    const rank = new Map();
    const resolve = (c, seen = new Set()) => {
      if (rank.has(c.def.id)) return rank.get(c.def.id);
      let r = c.def.order;
      const anchor = c.def.after || c.def.before;
      if (anchor && cards.has(anchor) && !seen.has(anchor)) {
        seen.add(c.def.id);
        r = resolve(cards.get(anchor), seen) + (c.def.after ? 0.5 : -0.5);
      }
      rank.set(c.def.id, r);
      return r;
    };
    list.forEach(c => resolve(c));
    return list.sort((a, b) => {
      const ia = explicit.indexOf(a.def.id), ib = explicit.indexOf(b.def.id);
      if (ia >= 0 || ib >= 0) return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib) || rank.get(a.def.id) - rank.get(b.def.id);
      return rank.get(a.def.id) - rank.get(b.def.id) || a.index - b.index;
    });
  }

  function layout() {
    for (const c of ordered()) {
      if (!c.frame) makeFrame(c);
      root.appendChild(c.frame.node);    // appendChild moves: this is the reorder
    }
    for (const c of cards.values()) if (c.frame && (config.layout.hide || []).includes(c.def.id)) c.frame.node.remove();
  }

  // ---- lifecycle --------------------------------------------------------------------------
  function renderCard(entry) {
    const { def, frame } = entry;
    if (!frame || !frame.node.isConnected) return;
    if (entry.error) {
      frame.body.textContent = "";
      const ctx = contextFor(entry);
      if (def.error) { try { def.error(frame.body, entry.error, ctx); return; } catch (e) { /* fall through */ } }
      frame.body.appendChild(el("p", "card-error", `${def.title || def.id} unavailable: ${entry.error.message || entry.error}`));
      return;
    }
    if (entry.data === undefined && def.load) return;
    try {
      const ctx = contextFor(entry);
      if (def.followsSegment) frame.api.setFilter(entry.data);
      def.render(frame.body, entry.data, ctx);
      emit("rendered", def.id, entry.data);
    } catch (e) {
      console.error(`bizdash: card ${def.id} failed to render`, e);
      frame.body.textContent = "";
      frame.body.appendChild(el("p", "card-error", `${def.title || def.id} failed to render: ${e.message}`));
    }
  }

  async function loadCard(entry) {
    if (!entry || !entry.frame?.node.isConnected) return;
    const { def, frame } = entry;
    if (!def.load) { entry.data = null; renderCard(entry); return; }
    const gen = ++entry.gen, rangeGen = loadGen;
    frame.node.classList.add("loading");
    try {
      const data = await def.load(contextFor(entry, rangeGen));
      if (gen !== entry.gen) return;                      // a newer load of this card won
      entry.data = data; entry.error = null;
      emit("loaded", def.id, data);
    } catch (e) {
      if (gen !== entry.gen) return;
      console.warn(`bizdash: card ${def.id} failed to load:`, e.message);
      entry.error = e;
    } finally {
      if (gen === entry.gen) frame.node.classList.remove("loading");
    }
    renderCard(entry);
  }

  function loadAll(kinds) {
    return Promise.all([...cards.values()].filter(c => kinds.includes(c.def.refresh)).map(loadCard));
  }

  /** Re-render everything from data already held: no request. */
  function rerender() { for (const c of cards.values()) renderCard(c); }

  function setState(patch) {
    const before = { ...state };
    Object.assign(state, patch);
    // A bucket the range cannot fill twice over falls back to hours.
    if (state.bucket !== "hour" && !time.bucketFits(state.bucket, state.minutes)) state.bucket = "hour";
    if (patch.segment && segmentsEnabled) { try { storage?.setItem("bizdash.segment", state.segment); } catch (e) { /* blocked */ } }
    emit("state", { ...state }, before);
    if (patch.minutes != null && patch.minutes !== before.minutes) {
      loadGen++; memo = new Map();
      return loadAll(["range"]);
    }
    rerender();
    return Promise.resolve();
  }

  function snapshot() {
    const lines = [`${config.title} — ${time.rangeLabel(state.minutes)}`
      + (segmentsEnabled ? `, traffic filter: ${segLabel(state.segment)}` : "") + ` (${mode} data)`];
    for (const c of ordered()) {
      if (!c.def.snapshot || c.data === undefined || c.error) continue;
      try {
        const text = c.def.snapshot(c.data, contextFor(c));
        if (text) lines.push("", `## ${c.def.title || c.def.id}`, text);
      } catch (e) { lines.push("", `## ${c.def.title || c.def.id}`, `(snapshot failed: ${e.message})`); }
    }
    return lines.join("\n");
  }

  // One notice line, shared: each source (a card, the plugin loader) owns its
  // own message, so one clearing its message cannot erase another's.
  let noticeEl = null;
  const notices = new Map();
  function showNotice(msg, key = "page") {
    if (msg) notices.set(key, msg); else notices.delete(key);
    renderNotices();
  }
  function renderNotices() {
    if (!noticeEl) return;
    noticeEl.textContent = [...notices.values()].join(" ");
    noticeEl.classList.toggle("show", notices.size > 0);
  }

  let actionsEl = null;
  function renderHeaderActions() {
    if (!actionsEl) return;
    for (const a of headerActions) {
      if (actionsEl.querySelector(`[data-action="${CSS.escape(a.id)}"]`)) continue;
      const b = el("button", "action", a.label);
      b.type = "button"; b.dataset.action = a.id; b.title = a.title;
      b.addEventListener("click", () => {
        try { a.onClick(contextFor({ def: { id: `action:${a.id}`, refresh: "once" }, frame: { api: null } })); }
        catch (e) { showNotice(`${a.label} failed: ${e.message}`); }
      });
      actionsEl.insertBefore(b, actionsEl.firstChild);
    }
  }

  function mount({ notice, actions } = {}) {
    noticeEl = notice || null;
    actionsEl = actions || null;
    renderNotices();
    mounted = true;
    layout();
    renderHeaderActions();
    return loadAll(["range", "realtime", "once"]);
  }

  /** What a plugin module's default export receives. */
  const pluginApi = Object.freeze({
    version: VERSION, config, mode, defineCard, addHeaderAction, on,
    ui: Object.freeze({ ...charts, ...format }), helpers: Object.freeze({ time, rows, rules }),
  });

  return {
    state, config, ga, mode, core, cards, pluginApi, defineCard, addHeaderAction, on, emit,
    mount, setState, rerender, loadAll, loadCard: id => loadCard(cards.get(id)), snapshot, showNotice,
    ordered: () => ordered().map(c => c.def.id), segLabel, segmentsEnabled,
  };
}

/**
 * Load the config's plugin modules. Each failure is isolated: a plugin that
 * fails to import or to register costs its own cards and is named in the
 * notice. Paths are resolved against the config file and must stay on this
 * origin (config.js already refuses absolute URLs and "..").
 */
export async function loadPlugins(dashboard, configUrl, importFn = u => import(u)) {
  const failures = [];
  for (const p of dashboard.config.plugins) {
    try {
      const url = new URL(p, configUrl);
      if (url.origin !== new URL(configUrl).origin) throw new Error("not on this origin");
      const mod = await importFn(url.href);
      if (typeof mod.default === "function") await mod.default(dashboard.pluginApi);
      else if (Array.isArray(mod.cards)) mod.cards.forEach(c => dashboard.defineCard(c));
      else throw new Error("exports neither a default function nor a `cards` array");
    } catch (e) {
      console.error(`bizdash: plugin ${p} failed`, e);
      failures.push(`${p}: ${e.message}`);
    }
  }
  return failures;
}
