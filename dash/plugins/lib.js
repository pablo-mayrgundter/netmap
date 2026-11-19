// Helpers shared by netmap's cards: one event, counted by one of its
// parameters (an event-scoped custom dimension), over the range's whole days.
// Everything here is pure except loadByParam, which only calls ctx.ga, so the
// tests import it in Node.

export const NETMAP = "https://pablo-mayrgundter.github.io/netmap/";
export const NOT_SET = "(not set)";
const METRICS = ["eventCount", "totalUsers"];

/** The Data API body: `event`'s count and people by customEvent:<param>. */
export function byParamBody({ event, param, limit = 10, dateRanges, exclusion = null, comparisons = null }) {
  const dimension = `customEvent:${param}`;
  const eventFilter = { filter: { fieldName: "eventName", inListFilter: { values: [event] } } };
  return {
    dateRanges,
    dimensions: [{ name: dimension }],
    metrics: METRICS.map(name => ({ name })),
    dimensionFilter: exclusion ? { andGroup: { expressions: [eventFilter, exclusion] } } : eventFilter,
    orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
    // One more than asked, so a "(not set)" row can be dropped and still fill
    // the list; and with comparisons, GA's limit counts a row per segment.
    limit: (limit + 1) * (comparisons ? comparisons.length : 1),
    ...(comparisons ? { comparisons } : {}),
  };
}

/** Rows as {name, count, people}, without "(not set)", at most `limit`. */
export function toItems(rows, dimension, limit = 10) {
  return (rows || [])
    .filter(r => r[dimension] != null && r[dimension] !== NOT_SET && r[dimension] !== "")
    .map(r => ({ name: String(r[dimension]), count: Math.round(r.eventCount || 0), people: Math.round(r.totalUsers || 0) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * Load one event-by-param list. With a traffic rule, the three segments come
 * in the same request (so the segment control costs no request); returns
 * {items} or {segments: {all: {items}, ...}}, as ctx.segments.view expects.
 */
export async function loadByParam(ctx, { event, param, limit = 10 }) {
  const dimension = `customEvent:${param}`;
  const body = byParamBody({ event, param, limit, dateRanges: ctx.range.dateRanges,
                             exclusion: ctx.internal.exclusion(), comparisons: ctx.comparisons });
  const p = await ctx.ga.runReport(body);
  if (!ctx.comparisons) return { items: toItems(ctx.rows.gaRows(p, [dimension], METRICS), dimension, limit), segments: null };
  const bySeg = ctx.rows.gaRowsByComparison(p, [dimension], METRICS);
  return { segments: Object.fromEntries(Object.entries(bySeg).map(([s, rows]) => [s, { items: toItems(rows, dimension, limit) }])) };
}

/** The custom dimensions a GA error says are missing, e.g. "customEvent:app_id". */
export function unregisteredDimensions(message) {
  const s = String(message || "");
  if (!/register|not a valid dimension/i.test(s)) return [];
  return [...new Set(s.match(/customEvent:[A-Za-z0-9_]+/g) || [])];
}

/** An explanation for a failed list: what to register in GA, or the error itself. */
export function failureText(message, params) {
  const missing = unregisteredDimensions(message);
  if (missing.length || /register/i.test(String(message || ""))) {
    const names = missing.length ? missing.map(d => d.slice("customEvent:".length)) : params;
    return `GA has no custom dimension ${names.join(", ")} yet. Register it (Admin → Custom definitions, `
      + "event scope; see this repository's README); data shows from then on.";
  }
  return `Unavailable: ${message}`;
}

/** netmap's link selecting an AS: #sel=<asn> (main.js applySelection). Null for anything but a number. */
export function asnLink(asn) {
  const s = String(asn ?? "").trim();
  return /^\d{1,10}$/.test(s) ? `${NETMAP}#sel=${s}` : null;
}

/** Tab-separated lines for "Copy data". */
export const itemsText = items => items.map(i => `${i.name}\t${i.count}\t${i.people}`).join("\n");

/** Bars for a list, or an empty-state line. */
export function renderItems(body, ctx, items, { label = i => i.name, empty = "None in this range.", aNoun = "events" } = {}) {
  if (!items.length) { body.appendChild(ctx.ui.el("div", "empty", empty)); return; }
  const max = Math.max(...items.map(i => Math.max(i.count, i.people)));
  for (const i of items) {
    const row = ctx.ui.hbarPairRow(i.name, i.count, i.people, max, { aNoun, bNoun: "people" });
    const name = row.querySelector(".name");
    const shown = label(i);
    if (shown instanceof Node) { name.textContent = ""; name.appendChild(shown); } else name.textContent = shown;
    body.appendChild(row);
  }
}

/** Card error view, naming the dimension to register when that is the reason. */
export function errorView(params) {
  return (body, err, ctx) => {
    body.textContent = "";
    body.appendChild(ctx.ui.el("div", "empty", failureText(err?.message || err, params)));
  };
}
