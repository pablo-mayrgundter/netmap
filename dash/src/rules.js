// The traffic rule: what the segment control calls NON-STANDARD, written once,
// as data, in the deployment config, and read through two compilers:
//
//   trafficFilterExpression(rule)  a GA4 FilterExpression, for comparisons
//   isNonstandard(row, rule)       the same rule over rows the page holds:
//                                  true, false, or null when a row lacks a
//                                  dimension the rule reads
//
// Mirrored in bizdash/rules.py. The rule says what the traffic DID (for
// example, landed on a host that is not the site), never who sent it.
//
// Node shapes: {all: [...]}, {any: [...]}, {not: node}, and the leaves
// {dim, in: [...]} / {dim, notIn: [...]}. Values compare case-insensitively,
// which is what GA's inListFilter does with caseSensitive false.

import { SEGMENTS } from "./ga/rows.js";

/** Dimensions runRealtimeReport accepts that a rule leaf could use. hostName is not one. */
export const REALTIME_RULE_DIMS = new Set(["country", "countryId", "city", "cityId", "deviceCategory",
  "platform", "appVersion", "streamId", "streamName", "unifiedScreenName"]);

export function ruleKind(node) {
  if (node && Array.isArray(node.all)) return "all";
  if (node && Array.isArray(node.any)) return "any";
  if (node && node.not) return "not";
  if (node && node.dim && (Array.isArray(node.in) || Array.isArray(node.notIn))) return "leaf";
  throw new Error(`traffic rule: unrecognized node ${JSON.stringify(node)}`);
}

const matchOf = rule => (rule && rule.match) || rule;

export function trafficFilterExpression(rule) {
  const compile = node => {
    const kind = ruleKind(node);
    if (kind === "leaf") {
      const inList = { filter: { fieldName: node.dim,
        inListFilter: { values: [...(node.in || node.notIn)].map(String), caseSensitive: false } } };
      return node.in ? inList : { notExpression: inList };
    }
    if (kind === "not") return { notExpression: compile(node.not) };
    const parts = node[kind].map(compile);
    if (parts.length === 1) return parts[0];
    return kind === "all" ? { andGroup: { expressions: parts } } : { orGroup: { expressions: parts } };
  };
  return compile(matchOf(rule));
}

/** Three-valued (Kleene) evaluation: an unknown only matters where it could change the answer. */
export function isNonstandard(row, rule) {
  const evaluate = node => {
    const kind = ruleKind(node);
    if (kind === "leaf") {
      if (row == null || row[node.dim] == null) return null;
      const v = String(row[node.dim]).toLowerCase();
      const hit = (node.in || node.notIn).some(x => String(x).toLowerCase() === v);
      return node.in ? hit : !hit;
    }
    if (kind === "not") { const v = evaluate(node.not); return v == null ? null : !v; }
    const vals = node[kind].map(evaluate);
    const decisive = kind !== "all";
    if (vals.includes(decisive)) return decisive;
    return vals.includes(null) ? null : !decisive;
  };
  return evaluate(matchOf(rule));
}

/** Every dimension the rule reads. */
export function ruleDims(rule) {
  const out = new Set();
  const walk = node => {
    const kind = ruleKind(node);
    if (kind === "leaf") out.add(node.dim);
    else if (kind === "not") walk(node.not);
    else node[kind].forEach(walk);
  };
  walk(matchOf(rule));
  return [...out];
}

/**
 * The part of the rule realtime can express, or null when there is none.
 * Dropping leaves narrows or widens the rule, so the result is marked partial
 * and the realtime card says which part it applied.
 */
export function realtimeRule(rule) {
  let partial = false;
  const prune = node => {
    const kind = ruleKind(node);
    if (kind === "leaf") {
      if (REALTIME_RULE_DIMS.has(node.dim)) return node;
      partial = true;
      return null;
    }
    if (kind === "not") { const inner = prune(node.not); return inner && { not: inner }; }
    const kept = node[kind].map(prune).filter(Boolean);
    return kept.length ? { [kind]: kept } : null;
  };
  const match = prune(matchOf(rule));
  return match && { ...rule, match, partial };
}

/**
 * The three segments as GA4 comparisons. One request carries all three and GA
 * de-duplicates each itself, so Standard is GA's own count, never All minus
 * Non-standard: a hit-scoped rule puts some people in both.
 */
export function trafficComparisons(rule) {
  const expr = trafficFilterExpression(rule);
  return [
    { name: "all", dimensionFilter: { filter: { fieldName: "country",
        stringFilter: { matchType: "FULL_REGEXP", value: ".*" } } } },
    { name: "nonstandard", dimensionFilter: expr },
    { name: "standard", dimensionFilter: { notExpression: expr } },
  ];
}

/** "standard" | "nonstandard" | "both" | null for a row seen on these hosts. */
export function classifyHosts(hosts, rule) {
  const vals = (hosts || []).filter(h => h != null && h !== "");
  if (!vals.length) return null;
  const flags = vals.map(h => isNonstandard({ hostName: h }, rule));
  if (flags.every(f => f === true)) return "nonstandard";
  if (flags.every(f => f === false)) return "standard";
  return "both";
}

/** The default rule for a list of site hosts: the hit landed on any other host. */
export const hostRule = hosts => ({ any: [{ dim: "hostName", notIn: [...hosts] }] });

export { SEGMENTS };
