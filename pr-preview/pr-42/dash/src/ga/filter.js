// GA4 FilterExpression semantics over one row, for the synthetic Data API and
// for tests. `get(fieldName)` returns the row's value (a string) or undefined.
// Independent of rules.js on purpose: the tests check the rule compiler
// against this evaluator, so it must not share the compiler's code.

export function gaMatch(expr, get) {
  if (!expr) return true;
  if (expr.andGroup) return expr.andGroup.expressions.every(e => gaMatch(e, get));
  if (expr.orGroup) return expr.orGroup.expressions.some(e => gaMatch(e, get));
  if (expr.notExpression) return !gaMatch(expr.notExpression, get);
  const f = expr.filter;
  if (!f) throw new Error(`unsupported filter expression ${JSON.stringify(expr)}`);
  let value = get(f.fieldName);
  if (value == null) return false;
  value = String(value);
  if (f.inListFilter) {
    const vals = f.inListFilter.values || [];
    // caseSensitive is a proto3 bool, so absent means false.
    if (f.inListFilter.caseSensitive) return vals.map(String).includes(value);
    return vals.some(v => String(v).toLowerCase() === value.toLowerCase());
  }
  if (f.stringFilter) {
    const sf = f.stringFilter, mt = sf.matchType || "EXACT";
    let want = String(sf.value);
    if (!sf.caseSensitive) { value = value.toLowerCase(); want = want.toLowerCase(); }
    switch (mt) {
      case "EXACT": return value === want;
      case "BEGINS_WITH": return value.startsWith(want);
      case "ENDS_WITH": return value.endsWith(want);
      case "CONTAINS": return value.includes(want);
      case "FULL_REGEXP": return new RegExp(`^(?:${want})$`).test(value);
      case "PARTIAL_REGEXP": return new RegExp(want).test(value);
      default: throw new Error(`unsupported matchType ${mt}`);
    }
  }
  if (f.numericFilter) {
    const n = +value, want = +(f.numericFilter.value.int64Value ?? f.numericFilter.value.doubleValue);
    return { EQUAL: n === want, LESS_THAN: n < want, LESS_THAN_OR_EQUAL: n <= want,
             GREATER_THAN: n > want, GREATER_THAN_OR_EQUAL: n >= want }[f.numericFilter.operation] ?? false;
  }
  if (f.emptyFilter) return value === "";
  throw new Error(`unsupported filter ${JSON.stringify(f)}`);
}

/** Every fieldName an expression reads. */
export function filterFields(expr, out = new Set()) {
  if (!expr) return out;
  if (expr.andGroup) expr.andGroup.expressions.forEach(e => filterFields(e, out));
  else if (expr.orGroup) expr.orGroup.expressions.forEach(e => filterFields(e, out));
  else if (expr.notExpression) filterFields(expr.notExpression, out);
  else if (expr.filter) out.add(expr.filter.fieldName);
  return out;
}
