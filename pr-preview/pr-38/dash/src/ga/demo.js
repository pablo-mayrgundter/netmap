// A synthetic GA4 Data API: answers runReport, runRealtimeReport and
// batchRunReports bodies with GA-shaped payloads, computed over a deterministic
// synthetic population of visitors, sessions and events. Mirrored in
// bizdash/demo.py, number for number.
//
// Because the demo answers *queries* rather than standing in for particular
// cards, every card — core or plugin — runs the same code against it as
// against GA, and de-duplicated metrics behave as they do in GA: users over a
// day are fewer than the sum of users per hour.
//
// The demo property's timezone is UTC. Three injected episodes give spike
// detection, the drill-down and the traffic rule something to find: a referral
// spike about 76 h ago, a single-country direct burst about 14 h ago, and an
// off-site burst about 20 h ago on a host that is not the site.
//
// Deliberate refusals, so the page's gap paths run without credentials:
// realtime refuses `screenPageViews` and `hostName`; an unregistered
// `customEvent:` dimension is a 400, as in GA.

import { countAround, fnv1a, pick, rng } from "../random.js";
import { gaMatch } from "./filter.js";

export const HISTORY_DAYS = 120;
const DIURNAL = [1.45, 1.233, 1.0, 0.767, 0.55, 0.364, 0.221, 0.131, 0.1, 0.131, 0.221, 0.364,
                 0.55, 0.767, 1.0, 1.233, 1.45, 1.636, 1.779, 1.869, 1.9, 1.869, 1.779, 1.636];
const WEEKLY = [1, 1, 1, 1, 1, 0.75, 0.75];                     // Monday first
const DECAY = [1.0, 0.659, 0.435, 0.287, 0.189, 0.125, 0.082, 0.054, 0.036];

const SOURCES = [
  [["google", "organic", "Organic Search"], 36],
  [["(direct)", "(none)", "Direct"], 26],
  [["bing", "organic", "Organic Search"], 6],
  [["github.com", "referral", "Referral"], 9],
  [["news.example", "referral", "Referral"], 5],
  [["social.example", "referral", "Organic Social"], 6],
  [["google", "cpc", "Paid Search"], 8],
  [["newsletter", "email", "Email"], 4],
];
const CAMPAIGN = { "Organic Search": "(organic)", "Organic Social": "(referral)", Referral: "(referral)",
                   Direct: "(direct)", "Paid Search": "spring_promo", Email: "weekly_digest" };
const COUNTRIES = [
  [["United States", ["New York", "San Francisco", "Austin", "Chicago"]], 40],
  [["India", ["Bengaluru", "Mumbai", "Delhi"]], 15],
  [["Germany", ["Berlin", "Munich"]], 10],
  [["United Kingdom", ["London", "Manchester"]], 9],
  [["Canada", ["Toronto", "Vancouver"]], 7],
  [["Brazil", ["Sao Paulo"]], 6],
  [["France", ["Paris", "Lyon"]], 5],
  [["Japan", ["Tokyo"]], 4],
  [["Australia", ["Sydney"]], 4],
];
const PAGES = [["/", 34], ["/items", 20], ["/docs", 14], ["/pricing", 12], ["/blog", 10], ["/about", 6], ["/signup", 4]];
const TITLES = { "/": "Home", "/items": "Items", "/docs": "Docs", "/pricing": "Pricing", "/blog": "Blog",
                 "/about": "About", "/signup": "Sign up" };
const DEVICES = [["desktop", 60], ["mobile", 35], ["tablet", 5]];
const BROWSERS = { desktop: [["Chrome", 64], ["Safari", 14], ["Edge", 12], ["Firefox", 10]],
                   mobile: [["Chrome", 55], ["Safari", 45]], tablet: [["Safari", 70], ["Chrome", 30]] };
const OSES = { desktop: [[["Windows", "Windows 11"], 38], [["Macintosh", "Macintosh Intel 10.15"], 34],
                         [["Windows", "Windows 10"], 18], [["Linux", "Linux x86_64"], 10]],
               mobile: [[["Android", "Android 14"], 55], [["iOS", "iOS 18.1"], 45]],
               tablet: [[["iOS", "iOS 18.1"], 70], [["Android", "Android 14"], 30]] };
const SCREENS = { desktop: [["1920x1080", 40], ["1536x864", 20], ["2560x1440", 15], ["1440x900", 15], ["1366x768", 10]],
                  mobile: [["390x844", 40], ["412x915", 35], ["375x667", 25]],
                  tablet: [["820x1180", 60], ["768x1024", 40]] };

const INT_METRICS = new Set(["activeUsers", "totalUsers", "newUsers", "sessions", "engagedSessions",
  "eventCount", "screenPageViews", "userEngagementDuration", "keyEvents"]);
const FLOAT_METRICS = new Set(["engagementRate", "bounceRate", "screenPageViewsPerSession",
  "averageSessionDuration", "eventsPerSession", "sessionsPerUser"]);
const EVENT_SCOPED = new Set(["eventName", "pagePath", "pageTitle", "unifiedScreenName", "pagePathPlusQueryString"]);
const SESSION_DIMS = new Set(["dateHour", "date", "hour", "dateHourMinute", "dayOfWeek", "sessionSource",
  "sessionMedium", "sessionSourceMedium", "sessionDefaultChannelGroup", "sessionCampaignName", "firstUserSource",
  "firstUserMedium", "firstUserDefaultChannelGroup", "firstUserCampaignName", "landingPage", "hostName",
  "newVsReturning", "country", "city", "deviceCategory", "browser", "operatingSystem", "operatingSystemWithVersion",
  "screenResolution", "platform"]);
const REALTIME_DIMS = new Set(["minutesAgo", "country", "city", "deviceCategory", "unifiedScreenName",
  "eventName", "platform", "streamName", "appVersion"]);
const REALTIME_METRICS = new Set(["activeUsers", "eventCount", "keyEvents"]);

export class GAError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const pad = n => String(n).padStart(2, "0");
/** The UTC dateHour label of absolute hour H. */
export function dhOf(H) {
  const d = new Date(H * 3600e3);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}`;
}
const dayIndexOfISO = iso => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400e3);
const hexId = s => fnv1a(s).toString(16);

const fmtValue = (name, v) => {
  if (FLOAT_METRICS.has(name)) {
    const s = v.toFixed(6);
    return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
  }
  return String(Math.round(v));
};

/**
 * cfg: a resolved bizdash config (only `demo`, `internalUsers` and `traffic`
 * are read). now: epoch ms, fixed for a client's lifetime so a page's
 * queries agree with each other.
 */
export function createDemoApi(cfg = {}, { now = Date.now() } = {}) {
  const demo = { siteHost: "www.example.com", usersPerHour: 14, events: [], customDimensions: [], ...(cfg.demo || {}) };
  const intDim = cfg.internalUsers?.dimension || null;
  const intParam = intDim && intDim.startsWith("customEvent:") ? intDim.slice("customEvent:".length) : null;
  const internalIds = Object.keys(cfg.internalUsers?.ids || {});
  const registered = new Set([...(demo.customDimensions || []), ...(intParam ? [intParam] : []),
    ...demo.events.flatMap(e => Object.keys(e.params || {}))]);
  const nowH = Math.floor(now / 3600e3);
  const nowM = Math.floor(now / 60e3);
  const firstH = nowH - HISTORY_DAYS * 24 + 1;
  const hourCache = new Map();
  let tokensUsed = 0;

  function base(H) {
    const r = rng(`base:${H}`);
    return demo.usersPerHour * DIURNAL[H % 24] * WEEKLY[(Math.floor(H / 24) + 3) % 7] * (0.85 + 0.3 * r());
  }
  const nNew = H => countAround(rng(`new:${H}`), base(H) * 0.62);

  // The first draws of a new session's stream are its minute and its source,
  // so a returning session can recover its user's first channel cheaply.
  function firstTouch(H, s) {
    const r = rng(`s:${H}.${s}`);
    r();
    return pick(r, SOURCES);
  }

  function userAttrs(uid) {
    const r = rng(`u:${uid}`);
    const [country, cities] = pick(r, COUNTRIES);
    const city = cities[Math.floor(r() * cities.length)];
    const device = pick(r, DEVICES);
    const browser = pick(r, BROWSERS[device]);
    const [os, osv] = pick(r, OSES[device]);
    const screen = pick(r, SCREENS[device]);
    return { country, city, device, browser, os, osv, screen, cid: `demo.${hexId(uid)}` };
  }

  function makeSession(id, uid, H, r, minute, src, first, isNew, spec = {}) {
    const u = { ...userAttrs(uid), ...(spec.user || {}) };
    const [source, medium, channel] = src;
    const s = {
      id, user: uid, H, dh: dhOf(H), minute, source, medium, channel, campaign: CAMPAIGN[channel] || "(not set)",
      firstSource: first[0], firstMedium: first[1], firstChannel: first[2], firstCampaign: CAMPAIGN[first[2]] || "(not set)",
      host: spec.host || demo.siteHost, nvr: isNew ? "new" : "returning",
      country: u.country, city: u.city, device: u.device, browser: u.browser, os: u.os, osv: u.osv,
      screen: u.screen, cid: spec.cid || u.cid, events: [], pv: 0, engaged: false, engagement: 0,
    };
    const landing = spec.landing || pick(r, PAGES);
    const pv = spec.pages || 1 + Math.floor(r() * r() * 5);
    const pages = [landing];
    for (let i = 1; i < pv; i++) pages.push(pick(r, PAGES));
    s.landing = landing;
    s.engaged = spec.engaged != null ? spec.engaged : r() < 0.62;
    s.engagement = spec.engagement != null ? spec.engagement
      : s.engaged ? 10 + Math.floor(r() * r() * 300) : Math.floor(r() * 8);
    s.events.push({ name: "session_start", page: landing, params: {} });
    if (isNew) s.events.push({ name: "first_visit", page: landing, params: {} });
    for (const p of pages) s.events.push({ name: "page_view", page: p, params: {} });
    s.pv = pages.length;
    if (s.engaged) s.events.push({ name: "user_engagement", page: pages[pages.length - 1], params: {} });
    if (!spec.noEvents) {
      const fired = new Set();
      for (const ev of demo.events) {
        if (ev.requires && !fired.has(ev.requires)) continue;
        const p = ev.rate * (channel === "Paid Search" ? 1.5 : 1) * (s.engaged ? 1.3 : 0.4) * (spec.boost || 1);
        if (r() < p) {
          const n = 1 + (ev.repeat ? Math.floor(r() * r() * ev.repeat) : 0);
          for (let i = 0; i < n; i++) {
            const params = {};
            for (const [k, vals] of Object.entries(ev.params || {})) params[k] = vals[Math.floor(r() * vals.length)];
            if (intParam) params[intParam] = s.cid;
            s.events.push({ name: ev.name, page: pages[Math.min(i, pages.length - 1)], params });
          }
          fired.add(ev.name);
        }
      }
    }
    return s;
  }

  function sessionsAt(H) {
    if (hourCache.has(H)) return hourCache.get(H);
    const out = [];
    const nn = nNew(H);
    for (let s = 0; s < nn; s++) {
      const r = rng(`s:${H}.${s}`);
      const minute = Math.floor(r() * 60);
      const src = pick(r, SOURCES);
      out.push(makeSession(`n${H}.${s}`, `u${H}.${s}`, H, r, minute, src, src, true));
    }
    const nr = countAround(rng(`ret:${H}`), base(H) * 0.5);
    for (let s = 0; s < nr; s++) {
      const r = rng(`r:${H}.${s}`);
      const minute = Math.floor(r() * 60);
      // Some come back the same day, most within a few weeks: what makes users
      // over a window fewer than the sum of users per hour.
      const back = r() < 0.4 ? 1 + Math.floor(r() * 8) : 1 + Math.floor(r() * r() * 24 * 28);
      const H0 = H - back, n0 = nNew(H0);
      if (!n0) continue;
      const s0 = Math.floor(r() * n0);
      const first = firstTouch(H0, s0);
      const src = r() < 0.55 ? SOURCES[1][0] : pick(r, SOURCES);
      out.push(makeSession(`r${H}.${s}`, `u${H0}.${s0}`, H, r, minute, src, first, false));
    }
    // injected episodes
    const ref = H - (nowH - 76);
    if (ref >= 0 && ref < DECAY.length) {
      const n = Math.round(260 * DECAY[ref]);
      const src = ["news.example", "referral", "Referral"];
      for (let i = 0; i < n; i++) {
        const r = rng(`x:${H}.ref.${i}`);
        out.push(makeSession(`x${H}.ref.${i}`, `x${H}.ref.${i}`, H, r, Math.floor(r() * 60), src, src, true,
          { landing: "/blog", user: { country: "United States" } }));
      }
    }
    const burst = H - (nowH - 14);
    if (burst >= 0 && burst < 3) {
      const src = SOURCES[1][0];
      for (let i = 0; i < 150; i++) {
        const r = rng(`x:${H}.burst.${i}`);
        out.push(makeSession(`x${H}.burst.${i}`, `x${H}.burst.${i}`, H, r, Math.floor(r() * 60), src, src, true,
          { landing: "/", pages: 1, user: { country: "India", city: "Mumbai" }, noEvents: true,
            engaged: r() < 0.15 }));
      }
    }
    const off = H - (nowH - 20);
    if (off >= 0 && off < 5) {
      const src = SOURCES[1][0];
      for (let i = 0; i < 200; i++) {
        const r = rng(`x:${H}.off.${i}`);
        out.push(makeSession(`x${H}.off.${i}`, `x${H}.off.${i}`, H, r, Math.floor(r() * 60), src, src, true,
          { host: "localhost", landing: "/", pages: 1, noEvents: true, engaged: false, engagement: 1,
            user: { country: "Netherlands", city: "(not set)", device: "desktop", browser: "Chrome",
                    os: "Linux", osv: "Linux x86_64", screen: "800x600" } }));
      }
    }
    // the deployment's own testers, once a day each, busier than anyone
    internalIds.forEach((id, j) => {
      if (H % 24 !== (15 + j) % 24) return;
      const r = rng(`i:${H}.${j}`);
      const src = SOURCES[1][0];
      out.push(makeSession(`i${H}.${j}`, `internal.${j}`, H, r, Math.floor(r() * 60), src, src, false,
        { cid: id, boost: 3, engaged: true }));
    });
    hourCache.set(H, out);
    return out;
  }

  // ---- reporting ----------------------------------------------------------

  function dayIndex(d) {
    const D = Math.floor(nowH / 24);
    if (d === "today") return D;
    if (d === "yesterday") return D - 1;
    const m = /^(\d+)daysAgo$/.exec(d);
    if (m) return D - +m[1];
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return dayIndexOfISO(d);
    throw new GAError(400, `Invalid date "${d}"`);
  }

  function sessionField(s, name) {
    switch (name) {
      case "dateHour": return s.dh;
      case "date": return s.dh.slice(0, 8);
      case "hour": return s.dh.slice(8, 10);
      case "dateHourMinute": return s.dh + pad(s.minute);
      case "dayOfWeek": return String((Math.floor(s.H / 24) + 4) % 7);
      case "sessionSource": return s.source;
      case "sessionMedium": return s.medium;
      case "sessionSourceMedium": return `${s.source} / ${s.medium}`;
      case "sessionDefaultChannelGroup": return s.channel;
      case "sessionCampaignName": return s.campaign;
      case "firstUserSource": return s.firstSource;
      case "firstUserMedium": return s.firstMedium;
      case "firstUserDefaultChannelGroup": return s.firstChannel;
      case "firstUserCampaignName": return s.firstCampaign;
      case "landingPage": return s.landing;
      case "hostName": return s.host;
      case "newVsReturning": return s.nvr;
      case "country": return s.country;
      case "city": return s.city;
      case "deviceCategory": return s.device;
      case "browser": return s.browser;
      case "operatingSystem": return s.os;
      case "operatingSystemWithVersion": return s.osv;
      case "screenResolution": return s.screen;
      case "platform": return "web";
      default: return undefined;
    }
  }

  function checkDimension(name) {
    if (name.startsWith("customEvent:")) {
      if (!registered.has(name.slice("customEvent:".length)))
        throw new GAError(400, `Field ${name} is not a valid dimension. Did you register it?`);
      return;
    }
    if (!EVENT_SCOPED.has(name) && !SESSION_DIMS.has(name))
      throw new GAError(400, `Field ${name} is not a valid dimension.`);
  }

  const field = (s, e, name) => {
    if (name.startsWith("customEvent:")) return e ? (e.params[name.slice(12)] ?? "(not set)") : "(not set)";
    if (name === "eventName") return e ? e.name : undefined;
    if (name === "pagePath" || name === "pagePathPlusQueryString") return e ? e.page : s.landing;
    if (name === "pageTitle" || name === "unifiedScreenName") return TITLES[e ? e.page : s.landing];
    return sessionField(s, name);
  };

  function filterFieldsOf(expr, out) {
    if (!expr) return out;
    for (const k of ["andGroup", "orGroup"]) if (expr[k]) expr[k].expressions.forEach(x => filterFieldsOf(x, out));
    if (expr.notExpression) filterFieldsOf(expr.notExpression, out);
    if (expr.filter) out.add(expr.filter.fieldName);
    return out;
  }

  function newAcc() {
    return { users: new Set(), newUsers: new Set(), sessions: new Set(), engaged: new Set(), events: 0, pv: 0, engagement: 0 };
  }
  function addTo(acc, s, e, eventMode) {
    acc.users.add(s.user);
    if (s.nvr === "new") acc.newUsers.add(s.user);
    if (!acc.sessions.has(s.id)) {
      acc.sessions.add(s.id);
      if (s.engaged) acc.engaged.add(s.id);
      acc.engagement += s.engagement;
      if (!eventMode) { acc.events += s.events.length; acc.pv += s.pv; }
    }
    if (eventMode) { acc.events++; if (e.name === "page_view") acc.pv++; }
  }
  function metricValue(acc, m) {
    const sessions = acc.sessions.size;
    switch (m) {
      case "activeUsers": case "totalUsers": return acc.users.size;
      case "newUsers": return acc.newUsers.size;
      case "sessions": return sessions;
      case "engagedSessions": return acc.engaged.size;
      case "engagementRate": return sessions ? acc.engaged.size / sessions : 0;
      case "bounceRate": return sessions ? 1 - acc.engaged.size / sessions : 0;
      case "eventCount": return acc.events;
      case "keyEvents": return 0;
      case "screenPageViews": return acc.pv;
      case "screenPageViewsPerSession": return sessions ? acc.pv / sessions : 0;
      case "eventsPerSession": return sessions ? acc.events / sessions : 0;
      case "sessionsPerUser": return acc.users.size ? sessions / acc.users.size : 0;
      case "userEngagementDuration": return acc.engagement;
      case "averageSessionDuration": return sessions ? acc.engagement * 1.4 / sessions : 0;
      default: throw new GAError(400, `Field ${m} is not a valid metric.`);
    }
  }

  function checkMetric(m) {
    if (!INT_METRICS.has(m) && !FLOAT_METRICS.has(m)) throw new GAError(400, `Field ${m} is not a valid metric.`);
  }

  function orderRows(rows, body, dims, metrics) {
    const orderBys = body.orderBys || [];
    const cmp = (a, b) => {
      for (const o of orderBys) {
        let x, y;
        if (o.metric) { const i = metrics.indexOf(o.metric.metricName); x = a.m[i]; y = b.m[i]; }
        else if (o.dimension) { const i = dims.indexOf(o.dimension.dimensionName); x = a.d[i]; y = b.d[i]; }
        else continue;
        if (x !== y) return (x < y ? -1 : 1) * (o.desc ? -1 : 1);
      }
      return 0;
    };
    if (orderBys.length) rows.sort(cmp);
    else {
      const t = ["dateHour", "date", "dateHourMinute", "minutesAgo"].map(d => dims.indexOf(d)).find(i => i >= 0);
      if (t != null) rows.sort((a, b) => (a.d[t] < b.d[t] ? -1 : a.d[t] > b.d[t] ? 1 : 0));
      else rows.sort((a, b) => (b.m[0] ?? 0) - (a.m[0] ?? 0) || (a.d.join() < b.d.join() ? -1 : 1));
    }
    return rows;
  }

  function payload(kind, dims, metrics, rows, totals, rowCount, body) {
    tokensUsed += 1 + Math.floor(rowCount / 1000);
    const out = {
      dimensionHeaders: dims.map(name => ({ name })),
      metricHeaders: metrics.map(name => ({ name, type: FLOAT_METRICS.has(name) ? "TYPE_FLOAT" : "TYPE_INTEGER" })),
      rows: rows.map(r => ({ dimensionValues: r.d.map(value => ({ value })),
                             metricValues: r.m.map((v, i) => ({ value: fmtValue(metrics[i], v) })) })),
      rowCount, metadata: { currencyCode: "USD", timeZone: "Etc/UTC" }, kind,
    };
    if (totals) out.totals = totals.map(r => ({ dimensionValues: r.d.map(value => ({ value })),
      metricValues: r.m.map((v, i) => ({ value: fmtValue(metrics[i], v) })) }));
    if (!rows.length) delete out.rows;
    if (body.returnPropertyQuota) out.propertyQuota = quota();
    return out;
  }

  const quota = () => ({
    tokensPerDay: { consumed: tokensUsed, remaining: Math.max(0, 200000 - tokensUsed) },
    tokensPerHour: { consumed: tokensUsed % 40000, remaining: 40000 - (tokensUsed % 40000) },
    concurrentRequests: { consumed: 0, remaining: 10 },
    tokensPerProjectPerHour: { consumed: tokensUsed % 14000, remaining: 14000 - (tokensUsed % 14000) },
  });

  function runReport(body) {
    const dims = (body.dimensions || []).map(d => d.name);
    const metrics = (body.metrics || []).map(m => m.name);
    if (!metrics.length) throw new GAError(400, "At least one metric is required.");
    dims.forEach(checkDimension);
    metrics.forEach(checkMetric);
    const ranges = body.dateRanges || [];
    if (ranges.length !== 1) throw new GAError(400, "the demo answers exactly one dateRange");
    const D0 = dayIndex(ranges[0].startDate), D1 = dayIndex(ranges[0].endDate);
    if (D1 < D0) throw new GAError(400, "startDate is after endDate");
    const comparisons = body.comparisons || null;
    const filters = filterFieldsOf(body.dimensionFilter, new Set());
    for (const c of comparisons || []) filterFieldsOf(c.dimensionFilter, filters);
    for (const f of filters) checkDimension(f);
    const eventMode = [...dims, ...filters].some(d => EVENT_SCOPED.has(d) || d.startsWith("customEvent:"));
    const outDims = comparisons ? [...dims, "comparison"] : dims;
    const groups = new Map();
    const totalsBy = new Map();
    const wantTotals = (body.metricAggregations || []).includes("TOTAL") || (comparisons && !dims.length);
    const segs = comparisons || [{ name: null, dimensionFilter: null }];
    const h0 = Math.max(firstH, D0 * 24), h1 = Math.min(nowH, D1 * 24 + 23);
    for (let H = h0; H <= h1; H++) {
      for (const s of sessionsAt(H)) {
        if (H === nowH && s.minute > nowM % 60) continue;      // the current hour is still filling
        const items = eventMode ? s.events : [null];
        for (const e of items) {
          const get = name => field(s, e, name);
          if (!gaMatch(body.dimensionFilter, get)) continue;
          for (const c of segs) {
            if (c.dimensionFilter && !gaMatch(c.dimensionFilter, get)) continue;
            const d = dims.map(get);
            if (c.name != null) d.push(c.name);
            const key = d.join("\u0001");
            let g = groups.get(key);
            if (!g) { g = { d, acc: newAcc() }; groups.set(key, g); }
            addTo(g.acc, s, e, eventMode);
            if (wantTotals) {
              let t = totalsBy.get(c.name);
              if (!t) { t = newAcc(); totalsBy.set(c.name, t); }
              addTo(t, s, e, eventMode);
            }
          }
        }
      }
    }
    let rows = [...groups.values()].map(g => ({ d: g.d, m: metrics.map(m => metricValue(g.acc, m)) }));
    let totals = null;
    if (wantTotals) {
      totals = [...totalsBy.entries()].map(([name, acc]) => ({
        d: [...dims.map(() => "RESERVED_TOTAL"), ...(name != null ? [name] : [])],
        m: metrics.map(m => metricValue(acc, m)) }));
      if (!totals.length) totals = comparisons ? [] : [{ d: dims.map(() => "RESERVED_TOTAL"), m: metrics.map(() => 0) }];
    }
    if (comparisons && !dims.length) rows = [];                 // GA answers this shape in totals alone
    orderRows(rows, body, outDims, metrics);
    const rowCount = rows.length;
    const offset = +(body.offset || 0), limit = +(body.limit || 10000);
    rows = rows.slice(offset, offset + limit);
    return payload("analyticsData#runReport", outDims, metrics, rows, totals, rowCount, body);
  }

  // ---- realtime -------------------------------------------------------------

  const rtCache = new Map();
  function visitorsAt(M) {
    if (rtCache.has(M)) return rtCache.get(M);
    const H = Math.floor(M / 60);
    const ago = nowM - M;
    let n = countAround(rng(`rtn:${M}`), base(H) * 0.07);
    if ((ago >= 5 && ago <= 8) || (ago >= 19 && ago <= 22)) n += 6;
    const out = [];
    for (let i = 0; i < n; i++) {
      const r = rng(`rt:${M}.${i}`);
      const stay = 1 + Math.floor(r() * r() * 10);
      const [country, cities] = pick(r, COUNTRIES);
      const city = cities[Math.floor(r() * cities.length)];
      const device = pick(r, DEVICES);
      const v = { id: `v${M}.${i}`, country, city, device, events: [] };
      for (let k = 0; k < stay; k++) v.events.push({ name: "page_view", minute: M + k, page: pick(r, PAGES) });
      for (const ev of demo.events) {
        if (ev.requires && !v.events.some(x => x.name === ev.requires)) continue;
        if (r() < ev.rate) v.events.push({ name: ev.name, minute: M, page: v.events[0].page });
      }
      out.push(v);
    }
    rtCache.set(M, out);
    return out;
  }

  function runRealtimeReport(body) {
    const dims = (body.dimensions || []).map(d => d.name);
    const metrics = (body.metrics || []).map(m => m.name);
    for (const d of dims) if (!REALTIME_DIMS.has(d)) throw new GAError(400, `Field ${d} is not a valid dimension for realtime reports.`);
    for (const m of metrics) if (!REALTIME_METRICS.has(m)) throw new GAError(400, `Field ${m} is not a valid metric for realtime reports.`);
    for (const f of filterFieldsOf(body.dimensionFilter, new Set()))
      if (!REALTIME_DIMS.has(f)) throw new GAError(400, `Field ${f} is not a valid dimension for realtime reports.`);
    const mr = (body.minuteRanges || [{ startMinutesAgo: 29, endMinutesAgo: 0 }])[0];
    const startAgo = mr.startMinutesAgo ?? 29, endAgo = mr.endMinutesAgo ?? 0;
    const groups = new Map();
    for (let M = nowM - startAgo - 10; M <= nowM; M++) {
      for (const v of visitorsAt(M)) {
        for (const e of v.events) {
          const ago = nowM - e.minute;
          if (ago < endAgo || ago > startAgo) continue;
          const get = name => ({ minutesAgo: pad(ago), country: v.country, city: v.city, deviceCategory: v.device,
            unifiedScreenName: TITLES[e.page], eventName: e.name, platform: "web", streamName: "Web",
            appVersion: "(not set)" })[name];
          if (!gaMatch(body.dimensionFilter, get)) continue;
          const d = dims.map(get), key = d.join("\u0001");
          let g = groups.get(key);
          if (!g) { g = { d, users: new Set(), events: 0 }; groups.set(key, g); }
          g.users.add(v.id);
          g.events++;
        }
      }
    }
    const rows = [...groups.values()].map(g => ({ d: g.d,
      m: metrics.map(m => (m === "activeUsers" ? g.users.size : m === "eventCount" ? g.events : 0)) }));
    orderRows(rows, body, dims, metrics);
    const rowCount = rows.length;
    return payload("analyticsData#runRealtimeReport", dims, metrics, rows.slice(0, +(body.limit || 10000)),
      null, rowCount, body);
  }

  function batchRunReports(body) {
    const reports = (body.requests || []).map(runReport);
    return { reports, kind: "analyticsData#batchRunReports" };
  }

  /** The Data API's methods, as {status, ok, text} like a fetch would answer. */
  async function post(method, body) {
    try {
      const fn = { runReport, runRealtimeReport, batchRunReports }[method];
      if (!fn) throw new GAError(404, `the demo has no method ${method}`);
      const out = fn(JSON.parse(JSON.stringify(body || {})));
      return { status: 200, ok: true, text: JSON.stringify(out) };
    } catch (e) {
      if (!(e instanceof GAError)) throw e;
      const err = { error: { code: e.status, message: e.message, status: "INVALID_ARGUMENT" } };
      return { status: e.status, ok: false, text: JSON.stringify(err) };
    }
  }

  return { post, runReport, runRealtimeReport, batchRunReports, now, nowH, latestHour: dhOf(nowH),
           sessionsAt, quota };
}
