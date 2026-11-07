// The model's message handler, the same on a worker and on the main thread:
// init builds the model; tick propagates to a time and answers for a dish
// and a selected satellite. DOM-free. worker.js runs it in a Web Worker;
// engine.js falls back to calling it directly.

import { LinkModel } from './model.js';

export function createCore() {
  let model = null;
  return {
    /** { omm, gateways, pops } -> { summary, timings } */
    init(msg) {
      model = new LinkModel(msg);
      return { summary: null, timings: { ...model.timings } };
    },
    /**
     * { t, dish: { lon, lat } | null, sat: norad | null, opts } ->
     * { t, dish, sat, summary, timings }. The first tick also classifies
     * the shells' planes, so the summary comes with it.
     */
    tick(msg) {
      if (!model) throw new Error('tick before init');
      const t0 = performance.now();
      const first = !model.planes;
      model.propagate(msg.t);
      model.gatewayViews(msg.opts?.gwMask);
      const dish = msg.dish ? model.dish(msg.dish.lon, msg.dish.lat, { ...msg.opts, pin: msg.sat ?? null }) : null;
      let sat = null;
      const i = msg.sat != null ? model.byNorad.get(msg.sat) : undefined;
      if (i !== undefined) sat = { ...model.satInfo(i), gateways: model.gatewaysOf(i).map(({ g, range }) => model.gatewayLeg(g, range)) };
      const timings = { ...model.timings, tick: performance.now() - t0 };
      return { t: msg.t, dish, sat, missingSat: msg.sat != null && i === undefined, summary: first ? model.summary() : null, timings };
    },
  };
}
