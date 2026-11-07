// The deployment config: one JSON file (bizdash.config.json) per deployment,
// merged over defaults.json. Pure functions here; loadConfig() is the only part
// that touches the network. bizdash/config.py applies the same rules.

import DEFAULTS from "./defaults.json" with { type: "json" };
import { fnv1a } from "./random.js";
import { hostRule, ruleKind } from "./rules.js";

export { DEFAULTS };

const KNOWN_KEYS = new Set([...Object.keys(DEFAULTS.config), "$schema", "_comment", "version"]);

const isObj = v => v != null && typeof v === "object" && !Array.isArray(v);

/** Deep merge: plain objects merge, everything else (arrays included) replaces. */
export function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? clone(base) : clone(over);
  const out = clone(base);
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? merge(out[k], v) : clone(v);
  return out;
}
const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/**
 * A plugin path must be relative to the config file and stay on the page's
 * origin: a config can be chosen by URL (?config=), and a module loaded from
 * anywhere else would run with the viewer's GA session.
 */
export function isSafeRelativePath(p) {
  return typeof p === "string" && p.length > 0 && !/^[a-z][a-z0-9+.-]*:/i.test(p) && !p.startsWith("/")
    && !p.startsWith("\\") && !p.split(/[\\/]/).includes("..");
}

/** The same rule for ?config=: a same-directory or sub-directory .json file. */
export const isSafeConfigPath = p => isSafeRelativePath(p) && /^[\w./-]+\.json$/.test(p);

export const ruleRev = rule => `r${fnv1a(JSON.stringify(rule)).toString(16)}`;

/**
 * Normalize a raw config. Returns {config, errors, warnings}. Errors are
 * things the page cannot run with; warnings are things it ignores.
 */
export function resolveConfig(raw = {}) {
  const errors = [], warnings = [];
  if (!isObj(raw)) return { config: clone(DEFAULTS.config), errors: ["config must be a JSON object"], warnings };
  for (const k of Object.keys(raw)) if (!KNOWN_KEYS.has(k)) warnings.push(`unknown key "${k}" ignored`);
  const cfg = merge(DEFAULTS.config, raw);
  const S = DEFAULTS.sections;

  for (const k of ["title", "propertyId", "clientId", "timezoneNote"])
    if (typeof cfg[k] !== "string") errors.push(`${k} must be a string`);
  cfg.propertyId = String(cfg.propertyId || "").replace(/^properties\//, "");
  if (cfg.propertyId && !/^\d+$/.test(cfg.propertyId)) errors.push("propertyId must be the numeric GA4 property id");

  if (!Array.isArray(cfg.ranges) || !cfg.ranges.length || !cfg.ranges.every(m => Number.isInteger(m) && m > 0))
    errors.push("ranges must be a list of positive whole minutes");
  else if (!cfg.ranges.includes(cfg.defaultRange)) errors.push("defaultRange must be one of ranges");

  // events: {name: {label, since, unit}}
  if (!isObj(cfg.events)) { errors.push("events must be an object keyed by event name"); cfg.events = {}; }
  for (const [name, e] of Object.entries(cfg.events)) {
    if (!isObj(e)) { errors.push(`events.${name} must be an object`); continue; }
    e.label = e.label || name;
    if (e.since != null && !/^\d{4}-\d{2}-\d{2}$/.test(e.since)) errors.push(`events.${name}.since must be YYYY-MM-DD`);
  }
  const eventMeta = name => cfg.events[name] || { label: name };

  // chart.secondary: an event drawn on the right axis
  const sec = cfg.chart.secondary;
  if (sec) {
    const event = typeof sec === "string" ? sec : sec.event;
    if (!event) errors.push("chart.secondary needs an event");
    else cfg.chart.secondary = { event, label: sec.label || eventMeta(event).label, since: sec.since ?? eventMeta(event).since ?? null };
  }

  if (!Array.isArray(cfg.tiles)) { errors.push("tiles must be a list"); cfg.tiles = []; }
  cfg.tiles = cfg.tiles.map((t, i) => {
    const tile = typeof t === "string" ? { event: t } : { ...t };
    if (!tile.event) errors.push(`tiles[${i}] needs an event`);
    tile.label = tile.label || eventMeta(tile.event).label;
    tile.metric = tile.metric || "totalUsers";
    if (!["totalUsers", "eventCount"].includes(tile.metric)) errors.push(`tiles[${i}].metric must be totalUsers or eventCount`);
    return tile;
  });

  if (!Array.isArray(cfg.breakdowns)) { errors.push("breakdowns must be a list"); cfg.breakdowns = []; }
  for (const [i, b] of cfg.breakdowns.entries()) {
    if (!b.key || !b.dimension) errors.push(`breakdowns[${i}] needs key and dimension`);
    b.title = b.title || `Users by ${b.dimension}`;
    if (b.pairEvent) b.pairLabel = b.pairLabel || eventMeta(b.pairEvent).label;
  }

  if (cfg.funnel) {
    cfg.funnel = merge(S.funnel, cfg.funnel);
    if (!Array.isArray(cfg.funnel.steps) || !cfg.funnel.steps.length) errors.push("funnel.steps must list at least one step");
    const keys = new Set(["visitors"]);
    for (const [i, s] of (cfg.funnel.steps || []).entries()) {
      if (!s.key || keys.has(s.key)) errors.push(`funnel.steps[${i}] needs a unique key (not "visitors")`);
      keys.add(s.key);
      if (!Array.isArray(s.events) || !s.events.length) errors.push(`funnel.steps[${i}].events must list event names`);
      s.label = s.label || s.key;
      s.short = s.short || s.label;
      if (s.fallback && (!Array.isArray(s.fallback.events) || !s.fallback.events.length))
        errors.push(`funnel.steps[${i}].fallback.events must list event names`);
    }
  }

  if (cfg.conversions) {
    cfg.conversions = merge(S.conversions, cfg.conversions);
    if (!Array.isArray(cfg.conversions.events) || !cfg.conversions.events.length)
      errors.push("conversions.events must list event names");
  }

  const iu = cfg.internalUsers;
  if (Array.isArray(iu.ids)) iu.ids = Object.fromEntries(iu.ids.map(id => [id, iu.label]));
  if (!isObj(iu.ids)) { errors.push("internalUsers.ids must map ids to labels"); iu.ids = {}; }
  if (Object.keys(iu.ids).length && !iu.dimension)
    errors.push("internalUsers.ids needs internalUsers.dimension (the event-scoped dimension carrying the id)");

  if (cfg.traffic) {
    cfg.traffic = merge(S.traffic, cfg.traffic);
    const t = cfg.traffic;
    if (!t.rule && t.siteHosts?.length) t.rule = hostRule(t.siteHosts);
    if (!t.rule) errors.push("traffic needs siteHosts or a rule");
    else {
      try { ruleKind(t.rule.match || t.rule); } catch (e) { errors.push(e.message); }
      t.label = t.label || (t.siteHosts?.length ? `host ≠ ${t.siteHosts[0]}` : "custom rule");
      t.rev = t.rev || ruleRev(t.rule);
    }
    if (!["all", "standard", "nonstandard"].includes(t.default)) errors.push("traffic.default must be all, standard or nonstandard");
  }

  for (const k of ["z", "minExtra", "lookbackDays"])
    if (typeof cfg.spikes[k] !== "number" || !(cfg.spikes[k] > 0)) errors.push(`spikes.${k} must be a positive number`);

  if (!Array.isArray(cfg.plugins)) { errors.push("plugins must be a list of module paths"); cfg.plugins = []; }
  for (const p of cfg.plugins)
    if (!isSafeRelativePath(p)) errors.push(`plugin "${p}" must be a relative path on this site (no URL, no leading /, no ..)`);

  if (cfg.links.errorTracker && typeof cfg.links.errorTracker !== "string")
    errors.push("links.errorTracker must be a URL template string");

  return { config: cfg, errors, warnings };
}

/**
 * Runtime overrides from the URL: ?client_id= and ?property= are remembered in
 * this browser and scrubbed from the address bar, as before.
 */
export function applyOverrides(cfg, { params, storage }) {
  const out = clone(cfg);
  for (const [param, key, field] of [["client_id", "bizdash.clientId", "clientId"],
                                      ["property", "bizdash.propertyId", "propertyId"]]) {
    const v = params.get(param);
    if (v) { try { storage?.setItem(key, v); } catch (e) { /* storage blocked */ } }
    let kept = null;
    try { kept = storage?.getItem(key); } catch (e) { kept = null; }
    if (v || kept) out[field] = v || kept;
  }
  return out;
}

/** Fetch, resolve and override. Throws on a config the page cannot run with. */
export async function loadConfig({ url = "bizdash.config.json", params, storage, fetchFn = fetch } = {}) {
  const res = await fetchFn(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const { config, errors, warnings } = resolveConfig(await res.json());
  for (const w of warnings) console.warn(`bizdash config: ${w}`);
  if (errors.length) throw new Error(`invalid ${url}: ${errors.join("; ")}`);
  return applyOverrides(config, { params, storage });
}
