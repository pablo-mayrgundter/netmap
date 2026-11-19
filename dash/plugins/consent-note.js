// A note above the tiles: netmap's analytics are opt-in, so GA only sees the
// viewers who allowed it, and every number on this page is a lower bound.
export const NOTE = "netmap's analytics are opt-in: GA only counts viewers who clicked “Allow analytics”, "
  + "and never asks browsers with Do Not Track or Global Privacy Control set. Read every number here as a lower bound "
  + "on real use, and compare shapes and trends rather than totals.";
export const MORE = "https://github.com/pablo-mayrgundter/netmap#analytics";

export default function (bizdash) {
  bizdash.defineCard({
    id: "netmap-consent-note",
    title: null,
    kind: "frameless",
    span: 12,
    order: 50,
    refresh: "once",
    load: async () => ({ note: NOTE }),
    render(body, data, ctx) {
      body.textContent = "";
      const p = ctx.ui.el("p", "sub consent-note", `${data.note} `);
      const a = ctx.ui.el("a", "", "What netmap sends");
      a.href = MORE; a.target = "_blank"; a.rel = "noopener"; a.style.color = "inherit";
      p.appendChild(a);
      body.appendChild(p);
    },
    snapshot: data => data.note,
  });
}
