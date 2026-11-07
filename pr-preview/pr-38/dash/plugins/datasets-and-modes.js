// Datasets and modes: which maps people load (dataset_load by dataset_id) and
// which layout they switch to (mode_change by mode: cyber, hybrid, geo).
// Each list is its own report, so one unregistered dimension costs one list.
import { failureText, itemsText, loadByParam, renderItems } from "./lib.js";

export const LISTS = [
  { key: "datasets", title: "Datasets loaded", event: "dataset_load", param: "dataset_id", aNoun: "loads" },
  { key: "modes", title: "Modes switched to", event: "mode_change", param: "mode", aNoun: "changes" },
];

const SEGMENTS = ["all", "standard", "nonstandard"];

/**
 * Settle every list on its own and fold them into one segmented result:
 * {segments: {all: {datasets, modes}, ...}} with a traffic rule, else
 * {datasets, modes, segments: null}. A failed list is {error} in every segment.
 */
export async function loadLists(ctx, lists = LISTS) {
  const settled = await Promise.allSettled(lists.map(l => loadByParam(ctx, l)));
  const parts = Object.fromEntries(lists.map((l, i) => [l.key, settled[i].status === "fulfilled"
    ? settled[i].value : { error: settled[i].reason?.message || String(settled[i].reason) }]));
  if (lists.every(l => parts[l.key].error)) throw new Error(parts[lists[0].key].error);
  const of = (part, seg) => (part.error ? part : part.segments ? part.segments[seg] : part);
  if (!lists.some(l => parts[l.key].segments)) return { ...parts, segments: null };
  return { segments: Object.fromEntries(SEGMENTS.map(seg =>
    [seg, Object.fromEntries(lists.map(l => [l.key, of(parts[l.key], seg)]))])) };
}

export default function (bizdash) {
  bizdash.defineCard({
    id: "netmap-datasets-modes",
    title: "Datasets and modes",
    span: 4,
    after: "netmap-apps",
    followsSegment: true,
    load: ctx => loadLists(ctx),
    render(body, data, ctx) {
      body.textContent = "";
      body.appendChild(ctx.ui.el("p", "sub", `Map loads by dataset and mode changes by mode, ${ctx.range.daySpan}.`));
      const view = ctx.segments.view(data);
      for (const l of LISTS) {
        body.appendChild(ctx.ui.el("h3", "sub-head", l.title));
        const v = view[l.key];
        if (v.error) body.appendChild(ctx.ui.el("div", "empty", failureText(v.error, [l.param])));
        else renderItems(body, ctx, v.items, { aNoun: l.aNoun });
      }
    },
    snapshot: (data, ctx) => LISTS.map(l => {
      const v = ctx.segments.view(data)[l.key];
      return `${l.title}\n${v.error ? `unavailable: ${v.error}` : itemsText(v.items)}`;
    }).join("\n\n"),
    error: (body, err, ctx) => {
      body.textContent = "";
      body.appendChild(ctx.ui.el("div", "empty", failureText(err?.message || err, LISTS.map(l => l.param))));
    },
  });
}
