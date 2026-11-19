// Reading GA4 Data API payloads. Rows come back keyed by dimension and metric
// API names, metrics as numbers. Mirrored for the server side in
// bizdash/gaclient.py (rows()).

export const SEGMENTS = ["all", "standard", "nonstandard"];
export const COMPARISON_DIM = "comparison";
export const RESERVED_TOTAL = "RESERVED_TOTAL";
export const NOT_SET = "(not set)";

export function gaRows(payload, dims, metrics) {
  return ((payload && payload.rows) || []).map(row => {
    const rec = {};
    dims.forEach((d, i) => { rec[d] = row.dimensionValues?.[i]?.value ?? ""; });
    metrics.forEach((m, i) => { rec[m] = +(row.metricValues?.[i]?.value ?? 0); });
    return rec;
  });
}

/** The single row of a report with no dimensions, or zeros (GA measured nobody). */
export function gaTotalsRow(payload, metrics) {
  const rows = gaRows(payload, [], metrics);
  return rows[0] || Object.fromEntries(metrics.map(m => [m, 0]));
}

/**
 * GA's own TOTAL aggregation for a plain report, or null when it declined to
 * give one. No rows at all is a real zero; rows without totals are unknown,
 * never their sum (summing a de-duplicated count is the error this avoids).
 */
export function aggregateTotal(payload, metricIndex = 0) {
  const v = payload?.totals?.[0]?.metricValues?.[metricIndex]?.value;
  if (v != null) return +v;
  return (payload?.rows || []).length ? null : 0;
}

/**
 * A comparisons response that carries no `comparison` column is not an answer
 * to the question: reading it as segments would file every row under none of
 * them, and the page would show three empty segments as if GA measured nobody.
 */
export function assertCompared(payload) {
  const names = (payload?.dimensionHeaders || []).map(h => h.name);
  if (!names.includes(COMPARISON_DIM)) throw new Error("the response carries no comparison column");
  if (names[names.length - 1] !== COMPARISON_DIM)
    throw new Error(`comparison is column ${names.indexOf(COMPARISON_DIM) + 1} of ${names.length}, not last`);
}

/** gaRows split by comparison: {all: [...], standard: [...], nonstandard: [...]}. Rows arrive in GA's order. */
export function gaRowsByComparison(payload, dims, metrics) {
  assertCompared(payload);
  const out = Object.fromEntries(SEGMENTS.map(s => [s, []]));
  for (const r of gaRows(payload, [...dims, COMPARISON_DIM], metrics)) {
    const seg = r[COMPARISON_DIM];
    delete r[COMPARISON_DIM];
    if (out[seg]) out[seg].push(r);
  }
  return out;
}

/**
 * One metric set per comparison for a report with NO dimensions. GA answers
 * that shape in `totals` only, one entry per comparison keyed by the last
 * dimension value. Rows win when present.
 */
export function comparisonTotals(payload, metrics) {
  assertCompared(payload);
  const read = list => {
    const by = {};
    for (const row of list || []) {
      const vals = row.dimensionValues || [];
      const name = vals[vals.length - 1]?.value;
      by[name] = Object.fromEntries(metrics.map((m, i) => [m, +(row.metricValues?.[i]?.value ?? 0)]));
    }
    return by;
  };
  const fromTotals = read(payload.totals), fromRows = read(payload.rows);
  const zero = Object.fromEntries(metrics.map(m => [m, 0]));
  return Object.fromEntries(SEGMENTS.map(s => [s, fromRows[s] || fromTotals[s] || zero]));
}

/**
 * One comparisons payload as three plain ones, each shaped as if its segment
 * had been asked for alone, so every reader of plain payloads runs unchanged
 * per segment. A failed part ({error}) fails for every segment.
 */
export function splitByComparison(payload) {
  if (!payload || payload.error) return Object.fromEntries(SEGMENTS.map(seg => [seg, payload]));
  assertCompared(payload);
  const strip = list => (list || []).map(r => ({ ...r, dimensionValues: (r.dimensionValues || []).slice(0, -1) }));
  const of = (list, seg) => (list || []).filter(r => r.dimensionValues?.[r.dimensionValues.length - 1]?.value === seg);
  return Object.fromEntries(SEGMENTS.map(seg => {
    const rows = strip(of(payload.rows, seg));
    const out = { ...payload, dimensionHeaders: payload.dimensionHeaders.slice(0, -1), rows, rowCount: rows.length };
    if (payload.totals) out.totals = strip(of(payload.totals, seg));
    return [seg, out];
  }));
}

// ---- row limits under comparisons ------------------------------------------

/** The most rows GA returns in one page. */
export const MAX_LIMIT = 250000;

/**
 * The `limit` that leaves room for `n` rows in every segment. Under
 * comparisons GA's `limit` counts the rows of all of them together, so
 * `limit: 10` with three comparisons gives each three or four.
 */
export const comparedLimit = (n, comparisons) =>
  Math.min(MAX_LIMIT, n * Math.max(1, comparisons ? comparisons.length : 1));

/** Whether a payload carries the comparison column, last, as assertCompared requires. */
export const isCompared = payload => (payload?.dimensionHeaders || []).at(-1)?.name === COMPARISON_DIM;
const lastValue = r => r.dimensionValues?.[r.dimensionValues.length - 1]?.value;

/**
 * The comparisons that came back with fewer than `n` rows while GA held more
 * than it returned. GA ranks every segment's rows together, so a small
 * segment can be crowded out of even n × comparisons rows by larger ones.
 * A payload with no comparison column has none (its reader rejects it).
 */
export function shortSegments(payload, n, comparisons) {
  if (!comparisons || !isCompared(payload)) return [];
  const rows = payload.rows || [];
  if (!(+(payload.rowCount || 0) > rows.length)) return [];
  const count = new Map();
  for (const r of rows) count.set(lastValue(r), (count.get(lastValue(r)) || 0) + 1);
  return comparisons.filter(c => (count.get(c.name) || 0) < n);
}

/** A comparisons payload with at most `n` rows per segment, in GA's order. */
export function capSegments(payload, n) {
  const seen = new Map();
  const rows = (payload.rows || []).filter(r => {
    const k = lastValue(r), c = (seen.get(k) || 0) + 1;
    seen.set(k, c);
    return c <= n;
  });
  return { ...payload, rows };
}

/** A comparisons payload with one segment's rows replaced by a plain payload's, asked for that segment alone. */
export function withSegmentRows(payload, name, plain) {
  const rows = (payload.rows || []).filter(r => lastValue(r) !== name);
  for (const r of plain?.rows || []) rows.push({ ...r, dimensionValues: [...(r.dimensionValues || []), { value: name }] });
  return { ...payload, rows };
}

// ---- FilterExpression builders --------------------------------------------

export const inList = (fieldName, values, { caseSensitive } = {}) =>
  ({ filter: { fieldName, inListFilter: { values: values.map(String), ...(caseSensitive == null ? {} : { caseSensitive }) } } });
export const equals = (fieldName, value) =>
  ({ filter: { fieldName, stringFilter: { matchType: "EXACT", value: String(value) } } });
export const not = expr => ({ notExpression: expr });
export function and(...exprs) {
  const parts = exprs.flat().filter(Boolean);
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : { andGroup: { expressions: parts } };
}
export function or(...exprs) {
  const parts = exprs.flat().filter(Boolean);
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : { orGroup: { expressions: parts } };
}
export const events = names => inList("eventName", names);

/** A dimensionFilter key only when there is a filter. */
export const withFilter = expr => (expr ? { dimensionFilter: expr } : {});
