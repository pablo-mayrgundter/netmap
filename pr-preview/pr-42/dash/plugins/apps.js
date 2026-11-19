// Apps: how often each app in netmap's sidebar was opened (app_open by
// app_id), and by how many people, over the range's whole days.
import { errorView, itemsText, loadByParam, renderItems } from "./lib.js";

export const SPEC = { event: "app_open", param: "app_id", limit: 10 };

export default function (bizdash) {
  bizdash.defineCard({
    id: "netmap-apps",
    title: "Apps",
    span: 4,
    after: "funnel",
    followsSegment: true,
    load: ctx => loadByParam(ctx, SPEC),
    render(body, data, ctx) {
      body.textContent = "";
      body.appendChild(ctx.ui.el("p", "sub", `Apps opened from the sidebar, ${ctx.range.daySpan}.`));
      renderItems(body, ctx, ctx.segments.view(data).items, { aNoun: "opens", empty: "No apps opened in this range." });
    },
    snapshot: (data, ctx) => itemsText(ctx.segments.view(data).items),
    error: errorView([SPEC.param]),
  });
}
