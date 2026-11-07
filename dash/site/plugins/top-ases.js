// Top ASes selected: the 20 ASNs people selected most (as_select by asn),
// each linking to netmap with that AS selected (#sel=<asn>).
import { asnLink, errorView, itemsText, loadByParam, renderItems } from "./lib.js";

export const SPEC = { event: "as_select", param: "asn", limit: 20 };

export default function (bizdash) {
  bizdash.defineCard({
    id: "netmap-top-ases",
    title: "Top ASes selected",
    span: 4,
    after: "netmap-datasets-modes",
    followsSegment: true,
    load: ctx => loadByParam(ctx, SPEC),
    render(body, data, ctx) {
      body.textContent = "";
      body.appendChild(ctx.ui.el("p", "sub", `Selections by click, search or neighbour, ${ctx.range.daySpan}. Each opens in netmap.`));
      renderItems(body, ctx, ctx.segments.view(data).items, {
        aNoun: "selections",
        empty: "No ASes selected in this range.",
        label: i => {
          const href = asnLink(i.name);
          if (!href) return i.name;
          const a = ctx.ui.el("a", "asn", `AS${i.name}`);
          a.href = href; a.target = "_blank"; a.rel = "noopener"; a.style.color = "inherit";
          return a;
        },
      });
    },
    snapshot: (data, ctx) => itemsText(ctx.segments.view(data).items),
    error: errorView([SPEC.param]),
  });
}
