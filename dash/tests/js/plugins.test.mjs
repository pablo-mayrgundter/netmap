// Unit tests for netmap's plugin cards: the pure helpers, and the loaders run
// against a fake ctx shaped like bizdash's plugin context.
import { test } from "node:test";
import assert from "node:assert/strict";

import { asnLink, byParamBody, failureText, itemsText, loadByParam, toItems, unregisteredDimensions }
  from "../../site/plugins/lib.js";
import { LISTS, loadLists } from "../../site/plugins/datasets-and-modes.js";
import { SPEC as APPS } from "../../site/plugins/apps.js";
import { SPEC as ASES } from "../../site/plugins/top-ases.js";
import { NOTE } from "../../site/plugins/consent-note.js";

const RANGE = [{ startDate: "1daysAgo", endDate: "today" }];
const SEGMENTS = ["all", "standard", "nonstandard"];

// gaRows / gaRowsByComparison as bizdash reads them, enough for these payloads.
function gaRows(p, dims, metrics) {
  return (p.rows || []).map(r => ({
    ...Object.fromEntries(dims.map((d, i) => [d, r.dimensionValues[i].value])),
    ...Object.fromEntries(metrics.map((m, i) => [m, +r.metricValues[i].value])),
  }));
}
function gaRowsByComparison(p, dims, metrics) {
  const out = Object.fromEntries(SEGMENTS.map(s => [s, []]));
  for (const r of gaRows(p, [...dims, "comparison"], metrics)) { const s = r.comparison; delete r.comparison; out[s].push(r); }
  return out;
}
const payload = (rows, compared) => ({
  rows: rows.map(([d, c, u, seg]) => ({ dimensionValues: [{ value: d }, ...(compared ? [{ value: seg }] : [])],
                                        metricValues: [{ value: String(c) }, { value: String(u) }] })),
});

function fakeCtx({ comparisons = null, answer }) {
  const asked = [];
  return {
    asked,
    range: { dateRanges: RANGE },
    comparisons,
    internal: { exclusion: () => null },
    rows: { gaRows, gaRowsByComparison },
    ga: { runReport: async body => { asked.push(body); return answer(body); } },
  };
}

test("the report asks for one event by its custom dimension, ordered by count", () => {
  const b = byParamBody({ event: "app_open", param: "app_id", limit: 10, dateRanges: RANGE });
  assert.deepEqual(b.dimensions, [{ name: "customEvent:app_id" }]);
  assert.deepEqual(b.metrics.map(m => m.name), ["eventCount", "totalUsers"]);
  assert.deepEqual(b.dimensionFilter, { filter: { fieldName: "eventName", inListFilter: { values: ["app_open"] } } });
  assert.equal(b.limit, 11);                       // room to drop "(not set)"
  assert.equal(b.comparisons, undefined);
});

test("with comparisons GA's row limit covers every segment, and an exclusion is ANDed", () => {
  const ex = { notExpression: { filter: { fieldName: "customEvent:client_id", inListFilter: { values: ["x"] } } } };
  const b = byParamBody({ event: "as_select", param: "asn", limit: 20, dateRanges: RANGE, exclusion: ex,
                          comparisons: [{}, {}, {}] });
  assert.equal(b.limit, 63);
  assert.equal(b.comparisons.length, 3);
  assert.equal(b.dimensionFilter.andGroup.expressions[1], ex);
});

test("items drop (not set), sort by count then name, and cap the list", () => {
  const rows = [
    { "customEvent:asn": "(not set)", eventCount: 99, totalUsers: 9 },
    { "customEvent:asn": "174", eventCount: 3, totalUsers: 2 },
    { "customEvent:asn": "13335", eventCount: 5, totalUsers: 4 },
    { "customEvent:asn": "1299", eventCount: 3, totalUsers: 3 },
  ];
  assert.deepEqual(toItems(rows, "customEvent:asn", 2), [
    { name: "13335", count: 5, people: 4 },
    { name: "1299", count: 3, people: 3 },
  ]);
  assert.equal(itemsText(toItems(rows, "customEvent:asn")), "13335\t5\t4\n1299\t3\t3\n174\t3\t2");
});

test("ASNs link to netmap with the AS selected; anything else does not link", () => {
  assert.equal(asnLink("13335"), "https://pablo-mayrgundter.github.io/netmap/#sel=13335");
  assert.equal(asnLink(14593), "https://pablo-mayrgundter.github.io/netmap/#sel=14593");
  for (const bad of ["(not set)", "AS13335", "1&x=2", "", null, "12345678901"]) assert.equal(asnLink(bad), null, bad);
});

test("an unregistered custom dimension is explained as a GA setup step", () => {
  const msg = "GA4 runReport: Field customEvent:app_id is not a valid dimension. Did you register it? (HTTP 400)";
  assert.deepEqual(unregisteredDimensions(msg), ["customEvent:app_id"]);
  assert.match(failureText(msg, ["app_id"]), /no custom dimension app_id yet\. Register it/);
  assert.deepEqual(unregisteredDimensions("GA4 runReport: quota exhausted (HTTP 429)"), []);
  assert.equal(failureText("quota exhausted", ["app_id"]), "Unavailable: quota exhausted");
});

test("a plain load returns items; a compared load returns one list per segment", async () => {
  const plain = fakeCtx({ answer: () => payload([["starlink", 7, 5], ["(not set)", 1, 1]], false) });
  assert.deepEqual(await loadByParam(plain, APPS), { items: [{ name: "starlink", count: 7, people: 5 }], segments: null });

  const cmp = fakeCtx({ comparisons: [{ name: "all" }, { name: "standard" }, { name: "nonstandard" }],
    answer: () => payload([["13335", 9, 6, "all"], ["13335", 8, 5, "standard"], ["174", 1, 1, "nonstandard"]], true) });
  const d = await loadByParam(cmp, ASES);
  assert.deepEqual(Object.keys(d.segments), SEGMENTS);
  assert.deepEqual(d.segments.standard.items, [{ name: "13335", count: 8, people: 5 }]);
  assert.equal(cmp.asked[0].limit, 63);
});

test("datasets and modes: one failed list costs that list only; both failing fails the card", async () => {
  const ok = fakeCtx({ answer: b => {
    if (b.dimensions[0].name === "customEvent:mode") throw new Error("Field customEvent:mode is not a valid dimension. Did you register it?");
    return payload([["internet", 4, 3], ["routers", 1, 1]], false);
  } });
  const d = await loadLists(ok);
  assert.deepEqual(d.datasets.items.map(i => i.name), ["internet", "routers"]);
  assert.match(d.modes.error, /customEvent:mode/);
  assert.equal(d.segments, null);
  assert.deepEqual(LISTS.map(l => [l.event, l.param]), [["dataset_load", "dataset_id"], ["mode_change", "mode"]]);

  const bad = fakeCtx({ answer: () => { throw new Error("HTTP 403"); } });
  await assert.rejects(loadLists(bad), /HTTP 403/);
});

test("datasets and modes: with comparisons, each segment holds both lists", async () => {
  const ctx = fakeCtx({ comparisons: [{}, {}, {}],
    answer: b => payload(b.dimensions[0].name === "customEvent:mode"
      ? [["cyber", 3, 2, "all"], ["cyber", 2, 2, "standard"]]
      : [["internet", 5, 4, "all"], ["internet", 4, 3, "standard"]], true) });
  const d = await loadLists(ctx);
  assert.deepEqual(Object.keys(d.segments), SEGMENTS);
  assert.deepEqual(d.segments.standard.modes.items, [{ name: "cyber", count: 2, people: 2 }]);
  assert.deepEqual(d.segments.nonstandard.datasets.items, []);
});

test("the consent note says the counts are a lower bound", () => {
  assert.match(NOTE, /opt-in/);
  assert.match(NOTE, /lower bound/);
});
