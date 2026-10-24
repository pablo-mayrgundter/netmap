// The Orbits layer's performance probe: `?orbits_perf=1`.
//
// Measures, on the user's own GPU, where a camera move's time goes between
// netmap (the host) and celestiary's layer page (the guest, a cross-origin
// iframe), from the host's side only, so it works against the production
// guest as it is:
//   - each guest frame: the `layer:view` that asked for it, its GL calls
//     (count, bytes by call name), the messages that carried them, when the
//     first arrived and when the frame was complete, and the main-thread
//     time spent receiving it (structured-clone deserialisation and the
//     receiver's handler);
//   - each deck draw: why it ran, how long it took, which animation frame it
//     was in (so a burst of draws in one frame shows), whether it replayed a
//     new guest frame, re-ran the last one or had none, the replay's time,
//     and how far behind the camera the guest content it showed was;
//   - input: how long from a pointer or key event to the first deck draw
//     that shows a guest frame drawn for a view sent after it;
//   - the main thread: how busy it is (long animation frames, by who ran);
//   - the anchors (`layer:anchors`): how many, how long to receive;
//   - the guest's own timings, if it sends them (`layer:stats`).
// Times are on one clock, Unix ms (performance.timeOrigin + now), so a
// guest-side log on the same clock lines up with it.
//
// What it hooks is the adapter's, not the wire's, so it survives a change of
// wire (portal-netgl 0.6.0 sends one message per frame over a MessageChannel
// port): frames end at the receiver's `onFrame`, calls are counted as the
// transport delivers them, batched or not, and draws are deck's own. Only
// two numbers need the wire: messages per frame and their deserialisation,
// read by a listener on window that runs before the transport's. On another
// wire, messages per frame are the transport's deliveries and
// deserialisation shows in the main thread's time by invoker instead.
//
// The corner panel's buttons copy the raw records and a summary as JSON, or
// save them to a file. Nothing is sent anywhere. Costs a little main-thread
// time per message; off unless asked for.

const clock = () => performance.timeOrigin + performance.now();
/** The current animation frame's time (the same for every draw in it), Unix ms. */
const vsyncNow = () => {
  const t = typeof document === 'undefined' ? null : document.timeline?.currentTime;
  return typeof t === 'number' ? performance.timeOrigin + t : null;
};

const UPLOAD_CALLS = new Set(['bufferData', 'bufferSubData', 'texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D', 'compressedTexImage2D', 'compressedTexSubImage2D']);
const DRAW_CALLS = new Set(['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements', 'drawBuffers']);
/** A draw in an input's wake: this long after a pointer or key event, ms. */
const INPUT_WAKE_MS = 300;
/** The main thread's busy share is over this window, ms. */
const BUSY_WINDOW_MS = 30_000;

/** A call's family, for the payload table. */
export function callKind(name) {
  if (UPLOAD_CALLS.has(name)) return name.startsWith('tex') || name.startsWith('compressed') ? 'texture' : 'buffer';
  if (name.startsWith('uniform')) return 'uniform';
  if (DRAW_CALLS.has(name)) return 'draw';
  return 'state';
}

/** Bytes of binary data in an encoded NetGL argument (ArrayBuffers, typed arrays, images). */
export function argBytes(arg) {
  if (arg === null || typeof arg !== 'object') return 0;
  if (Array.isArray(arg)) {
    let n = 0;
    for (const a of arg) n += argBytes(a);
    return n;
  }
  if (ArrayBuffer.isView(arg)) return arg.byteLength;
  if (arg instanceof ArrayBuffer) return arg.byteLength;
  if (arg.buffer instanceof ArrayBuffer) return arg.buffer.byteLength;
  if (arg.__netgl_arraybuffer instanceof ArrayBuffer) return arg.__netgl_arraybuffer.byteLength;
  return 0;
}

/** Rough wire size of a NetGL call: its binary data, plus ~8 bytes a scalar argument. */
export function callBytes(msg) {
  let n = 16 + (msg.name?.length ?? 0);
  for (const a of msg.args ?? []) n += a !== null && typeof a === 'object' ? 8 + argBytes(a) : 8;
  return n;
}

/**
 * The messages one wire message carries: itself, or a batch's (an array,
 * `{ batch: [...] }` or `{ calls: [...] }`).
 */
export function unpack(msg) {
  if (Array.isArray(msg)) return msg;
  if (msg && typeof msg === 'object' && typeof msg.name !== 'string') {
    if (Array.isArray(msg.batch)) return msg.batch;
    if (Array.isArray(msg.calls)) return msg.calls;
  }
  return [msg];
}

const isCall = (m) => typeof m?.name === 'string';
const isFrameEnd = (m) => m?.type === 'netgl:frame-end';

/** Who ran a long animation frame's script, coarsely. */
export function invokerKind(s) {
  const inv = String(s?.invoker ?? '');
  const type = String(s?.invokerType ?? '');
  if (/message/i.test(inv)) return 'messages';
  if (/FrameRequestCallback|requestAnimationFrame/i.test(inv)) return 'animationFrame';
  if (/Timer|setTimeout|setInterval/i.test(inv)) return 'timers';
  if (/pointer|mouse|wheel|key|touch/i.test(inv)) return 'input';
  if (type === 'resolve-promise' || type === 'reject-promise') return 'promises';
  return 'other';
}

const quantile = (xs, q) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.floor(q * v.length))];
};
const stat = (xs) => ({ n: xs.filter(Number.isFinite).length, median: quantile(xs, 0.5), p95: quantile(xs, 0.95), max: quantile(xs, 1) });
const round = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);
const roundStats = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' ? round(v) : v)));

/** Draws grouped by animation frame: how many in each. */
export function drawsPerVsync(draws) {
  const by = new Map();
  for (const d of draws) if (d.vsync != null) by.set(d.vsync, (by.get(d.vsync) ?? 0) + 1);
  return [...by.values()];
}

/**
 * For each input, how long until a deck draw showed a guest frame drawn for
 * a view sent after it (frames in arrival order, so their views' times rise).
 */
export function inputToShown(inputs, frames, maxMs = 5000) {
  const shown = frames.filter((f) => Number.isFinite(f.tView) && Number.isFinite(f.tDrawn));
  const out = [];
  let j = 0;
  for (const i of inputs) {
    while (j < shown.length && shown[j].tView < i.t) j += 1;
    if (j >= shown.length) break;
    const ms = shown[j].tDrawn - i.t;
    if (ms <= maxMs) out.push(ms);
  }
  return out;
}

/**
 * @param {object} [o]
 * @param {number} [o.keep] records kept, each kind (a ring)
 */
export function makeOrbitsPerf({ keep = 600 } = {}) {
  const t0 = clock();
  const frames = []; // guest frames
  const draws = []; // deck draws
  const views = new Map(); // viewId → {t, draw, cam}
  const anchors = []; // layer:anchors receipts
  const inputs = []; // pointer / wheel / key input times
  const longFrames = []; // long animation frames (or long tasks)
  const guest = []; // the guest's own `layer:stats`
  let cur = null; // the guest frame being received
  let lastViewId = null; // the last layer:view posted
  let cam = 0; // camera version: bumped when deck's view matrix changes
  let camKey = '';
  let drawing = null; // the deck draw in progress
  let shown = null; // the guest frame on screen (its record)
  let framesSinceDrain = 0;
  let lastInput = null;
  let windowMsgs = 0; // wire messages seen on window (0 on another wire)
  let framesFromReceiver = false; // frames end at the receiver's onFrame
  let pendingAnchor = null; // an anchors message seen on the wire, not yet handled
  let hostStats = null;
  let busyType = null;
  const undo = [];
  const push = (arr, x) => {
    arr.push(x);
    if (arr.length > keep) arr.shift();
  };
  const newFrame = (t) => ({ seq: frames.length ? frames[frames.length - 1].seq + 1 : 1, tFirst: t, tEnd: null, viewId: null, tView: null, wireMsgs: 0, deliveries: 0, calls: 0, bytes: 0, deserMs: 0, handleMs: 0, kinds: {}, names: {}, drawnIn: null, tDrawn: null });
  const frame = (t) => (cur ??= newFrame(t));
  const closeFrame = (t) => {
    const f = frame(t);
    f.tEnd = t;
    f.viewId = lastViewId;
    const v = views.get(lastViewId);
    if (v) f.tView = v.t;
    push(frames, f);
    cur = null;
    framesSinceDrain += 1;
  };

  // The wire: a listener on window, registered before the transport's, sees
  // each message first, so reading `data` here is where Chromium
  // deserialises it. One message may carry a whole frame.
  const observe = (ev) => {
    const a = clock();
    const msg = ev.data;
    const deser = clock() - a;
    const items = unpack(msg);
    if (items.some((m) => isCall(m) || isFrameEnd(m))) {
      windowMsgs += 1;
      const f = frame(a);
      f.wireMsgs += 1;
      f.deserMs += deser;
    } else if (items.some((m) => m?.type === 'layer:anchors')) {
      const m = items.find((x) => x?.type === 'layer:anchors');
      pendingAnchor = { t: a, viewId: m.viewId ?? null, n: Array.isArray(m.anchors) ? m.anchors.length : 0, deserMs: deser, handleMs: null };
    }
  };
  let source = null;
  const raw = (ev) => {
    if (source && ev.source !== source) return;
    observe(ev);
  };

  // What the transport delivers to the adapter: calls (one by one or
  // batched), frame ends, anchors, control.
  const delivered = (msg, run) => {
    const a = clock();
    const items = unpack(msg);
    const netgl = items.some((m) => isCall(m) || isFrameEnd(m));
    const f = netgl ? frame(a) : null;
    if (f) {
      f.deliveries += 1;
      for (const m of items) {
        if (!isCall(m)) continue;
        f.calls += 1;
        const b = callBytes(m);
        f.bytes += b;
        const kk = (f.kinds[callKind(m.name)] ??= { n: 0, bytes: 0 });
        kk.n += 1;
        kk.bytes += b;
        const nn = (f.names[m.name] ??= { n: 0, bytes: 0 });
        nn.n += 1;
        nn.bytes += b;
      }
    }
    const t = clock();
    run();
    const d = clock() - t;
    if (f) {
      f.handleMs += d;
      // Without the receiver's onFrame (attach not called), the frame ends here.
      if (!framesFromReceiver && items.some(isFrameEnd) && cur === f) closeFrame(clock());
    }
    const am = items.find((m) => m?.type === 'layer:anchors');
    if (am) {
      const rec = pendingAnchor ?? { t: a, viewId: am.viewId ?? null, n: Array.isArray(am.anchors) ? am.anchors.length : 0, deserMs: null };
      pendingAnchor = null;
      rec.handleMs = d;
      push(anchors, rec);
    }
  };

  const wrapTransport = (transport, win) => {
    source = win;
    if (typeof window !== 'undefined') {
      window.addEventListener('message', raw, true);
      undo.push(() => window.removeEventListener('message', raw, true));
    }
    return {
      ...transport,
      post(msg, transfer) {
        if (msg?.type === 'layer:view') {
          const t = clock();
          transport.post(msg, transfer);
          lastViewId = msg.viewId;
          views.set(msg.viewId, { t, postMs: clock() - t, draw: drawing?.i ?? null, cam, timeMs: msg.view?.timeMs });
          if (views.size > keep) views.delete(views.keys().next().value);
          if (drawing) drawing.viewSent = msg.viewId;
          return;
        }
        transport.post(msg, transfer);
      },
      onMessage(listener) {
        return transport.onMessage((msg) => delivered(msg, () => listener(msg)));
      },
    };
  };

  /** The guest's own timings (`layer:stats`), if it sends them. */
  const guestStats = (msg) => {
    const { type: _type, ...rest } = msg ?? {};
    push(guest, { t: clock(), ...rest });
  };

  /**
   * Hook the deck and the layer (attachNetGLDeckLayer's handle), after attach.
   * @param {object} deck
   * @param {object} layer
   * @param {object} [o]
   * @param {() => object} [o.redraws] the host's redraw counters (orbitsRedraws.js), for the snapshot
   */
  const attach = (deck, layer, { redraws } = {}) => {
    hostStats = redraws ?? null;
    if (typeof layer?.receiver?.onFrame === 'function') {
      framesFromReceiver = true;
      undo.push(layer.receiver.onFrame(() => closeFrame(clock())));
    }
    // One probe at a time: a restarted layer wraps deck's own method, not the last probe's.
    deck.__orbitsPerfDrawLayers ??= deck._drawLayers;
    const drawLayers = deck.__orbitsPerfDrawLayers?.bind(deck);
    let i = 0;
    if (drawLayers) {
      deck._drawLayers = (reason, opts) => {
        const d = { i: ++i, t0: clock(), vsync: vsyncNow(), reason: String(reason ?? ''), replay: 'none', replayMs: 0, viewSent: null, cam: null, shownSeq: null, lagDraws: null, lagMs: null, inputAgeMs: null };
        drawing = d;
        try {
          return drawLayers(reason, opts);
        } finally {
          d.t1 = clock();
          d.ms = d.t1 - d.t0;
          if (lastInput !== null) d.inputAgeMs = d.t0 - lastInput;
          drawing = null;
          push(draws, d);
        }
      };
    }
    const after = deck.props.onAfterRender;
    deck.setProps({
      onAfterRender: (ctx) => {
        const vp = deck.getViewports()[0];
        if (vp) {
          const key = Array.from(vp.viewMatrix, (x) => x.toPrecision(12)).join(',');
          if (key !== camKey) {
            camKey = key;
            cam += 1;
          }
        }
        if (drawing) drawing.cam = cam;
        const pending = framesSinceDrain;
        after?.(ctx);
        if (!drawing) return;
        drawing.replayMs = layer?.stats?.lastMs ?? 0;
        if (pending > 0 && layer?.stats) {
          drawing.replay = 'new';
          framesSinceDrain = 0;
          shown = frames[frames.length - 1] ?? null;
          if (shown && shown.drawnIn === null) {
            shown.drawnIn = drawing.i;
            shown.tDrawn = clock();
          }
        } else if (shown) drawing.replay = 'rerun';
        if (shown) {
          drawing.shownSeq = shown.seq;
          const v = views.get(shown.viewId);
          if (v) {
            drawing.lagDraws = v.cam === cam ? 0 : drawing.i - v.draw;
            drawing.lagMs = v.cam === cam ? 0 : drawing.t0 - v.t;
          }
        }
      },
    });
    const canvas = deck.getCanvas?.() ?? deck.canvas;
    const target = canvas?.parentElement ?? (typeof window === 'undefined' ? null : window);
    for (const type of ['pointermove', 'pointerdown', 'wheel', 'keydown']) {
      const on = (ev) => {
        if (type === 'pointermove' && !ev.buttons) return;
        lastInput = performance.timeOrigin + ev.timeStamp;
        push(inputs, { t: lastInput, type });
      };
      target?.addEventListener(type, on, { capture: true, passive: true });
      undo.push(() => target?.removeEventListener(type, on, { capture: true }));
    }
    startBusy();
  };

  // The main thread: long animation frames (Chromium 123+; each 50 ms or
  // more, with the scripts that ran in it), else long tasks. Frames under
  // 50 ms aren't reported, so the busy share is a lower bound.
  const startBusy = () => {
    const types = typeof PerformanceObserver === 'undefined' ? [] : (PerformanceObserver.supportedEntryTypes ?? []);
    busyType = types.includes('long-animation-frame') ? 'long-animation-frame' : types.includes('longtask') ? 'longtask' : null;
    if (!busyType) return;
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        push(longFrames, {
          t: performance.timeOrigin + e.startTime,
          ms: e.duration,
          blockingMs: e.blockingDuration ?? null,
          renderMs: e.renderStart ? e.startTime + e.duration - e.renderStart : null,
          scripts: (e.scripts ?? []).map((s) => ({ kind: invokerKind(s), invoker: s.invoker, ms: s.duration, forcedLayoutMs: s.forcedStyleAndLayoutDuration || 0 })),
        });
      }
    });
    try {
      po.observe({ type: busyType, buffered: false });
      undo.push(() => po.disconnect());
    } catch {
      busyType = null;
    }
  };
  const busy = () => {
    const now = clock();
    const from = Math.max(t0, now - BUSY_WINDOW_MS);
    const span = now - from;
    const recent = longFrames.filter((e) => e.t >= from);
    const byKind = {};
    for (const e of recent) for (const s of e.scripts) byKind[s.kind] = (byKind[s.kind] ?? 0) + s.ms;
    const ms = recent.reduce((n, e) => n + e.ms, 0);
    return {
      source: busyType,
      windowS: round(span / 1000, 1),
      pct: busyType && span > 0 ? round((100 * ms) / span, 1) : null,
      longFrames: recent.length,
      scriptMsPerS: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, round((1000 * v) / span, 1)])),
    };
  };

  /** The summary: medians and p95s over the records kept. */
  const summary = () => {
    const done = frames.filter((f) => f.tEnd);
    const span = done.length > 1 ? (done[done.length - 1].tEnd - done[0].tEnd) / 1000 : 0;
    const kinds = {};
    for (const f of done)
      for (const [k, v] of Object.entries(f.kinds)) {
        const s = (kinds[k] ??= { n: [], bytes: [] });
        s.n.push(v.n);
        s.bytes.push(v.bytes);
      }
    // Draws over the same stretch as the frames kept.
    const since = done.length ? done[0].tFirst : -Infinity;
    const inWindow = draws.filter((d) => d.t0 >= since);
    const woke = (t) => inputs.some((i) => t >= i.t && t - i.t < INPUT_WAKE_MS);
    const perFrame = (ds, fs) => (fs.length ? round(ds.length / fs.length) : null);
    const restFrames = done.filter((f) => !woke(f.tEnd));
    const inputFrames = done.filter((f) => woke(f.tEnd));
    const moving = draws.filter((d) => d.lagDraws !== null && d.lagDraws > 0);
    const withCam = draws.filter((d) => d.lagDraws !== null);
    const vs = drawsPerVsync(draws);
    const wire = windowMsgs ? 'window' : 'transport';
    return {
      wire,
      guestFrames: done.length,
      guestFps: span ? round((done.length - 1) / span) : null,
      deckDraws: draws.length,
      deckDrawsPerGuestFrame: perFrame(inWindow, done),
      deckDrawsPerGuestFrameAtRest: perFrame(inWindow.filter((d) => !woke(d.t0)), restFrames),
      deckDrawsPerGuestFrameWithInput: perFrame(inWindow.filter((d) => woke(d.t0)), inputFrames),
      drawsPerVsync: stat(vs),
      bursts: vs.filter((n) => n >= 3).length,
      drawReasons: draws.reduce((m, d) => ((m[d.reason] = (m[d.reason] ?? 0) + 1), m), {}),
      viewToFrameEndMs: stat(done.map((f) => f.tEnd - f.tView)),
      receiveSpanMs: stat(done.map((f) => f.tEnd - f.tFirst)),
      frameEndToDrawnMs: stat(done.map((f) => f.tDrawn - f.tEnd)),
      viewToDrawnMs: stat(done.map((f) => f.tDrawn - f.tView)),
      msgsPerFrame: stat(done.map((f) => (wire === 'window' ? f.wireMsgs : f.deliveries))),
      callsPerFrame: stat(done.map((f) => f.calls)),
      bytesPerFrame: stat(done.map((f) => f.bytes)),
      deserMsPerFrame: wire === 'window' ? stat(done.map((f) => f.deserMs)) : null,
      handleMsPerFrame: stat(done.map((f) => f.handleMs)),
      byKind: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, { n: quantile(v.n, 0.5), bytes: quantile(v.bytes, 0.5) }])),
      deckDrawMs: stat(draws.map((d) => d.ms)),
      replayMs: stat(draws.filter((d) => d.replay !== 'none').map((d) => d.replayMs)),
      replays: draws.reduce((m, d) => ((m[d.replay] = (m[d.replay] ?? 0) + 1), m), {}),
      staleDraws: withCam.length ? round(moving.length / withCam.length) : null,
      lagDraws: stat(moving.map((d) => d.lagDraws)),
      lagMs: stat(moving.map((d) => d.lagMs)),
      inputToDrawMs: stat(draws.filter((d) => d.inputAgeMs !== null && d.inputAgeMs < 1000).map((d) => d.inputAgeMs)),
      inputToShownMs: stat(inputToShown(inputs, done)),
      mainThread: busy(),
      anchors: { n: anchors.length, perMsg: stat(anchors.map((a) => a.n)), deserMs: stat(anchors.map((a) => a.deserMs)), handleMs: stat(anchors.map((a) => a.handleMs)) },
      redraws: hostStats?.() ?? null,
      // TODO(celestiary): its layer page sends no `layer:stats` yet (its own
      // update, render and post times a frame); when it does, they show here.
      guest: guest.length ? guest[guest.length - 1] : null,
    };
  };

  const snapshot = () => ({
    at: new Date().toISOString(),
    since: t0,
    page: typeof location === 'undefined' ? null : location.href,
    userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent,
    devicePixelRatio: typeof window === 'undefined' ? null : window.devicePixelRatio,
    gpu: gpuName(),
    summary: roundStats(summary()),
    frames: frames.slice(),
    draws: draws.slice(),
    views: [...views.entries()].map(([viewId, v]) => ({ viewId, ...v })),
    anchors: anchors.slice(),
    inputs: inputs.slice(-100),
    longFrames: longFrames.slice(),
    guest: guest.slice(),
  });

  let gpu = null;
  let glForGpu = null;
  const gpuName = () => {
    if (gpu) return gpu;
    try {
      const ext = glForGpu?.getExtension('WEBGL_debug_renderer_info');
      gpu = ext ? glForGpu.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
    } catch {
      gpu = null;
    }
    return gpu;
  };

  /** A corner panel: a few live numbers, and the records to copy or save. */
  const hud = (gl) => {
    glForGpu = gl;
    const el = document.createElement('div');
    el.className = 'orbits-perf';
    el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;font:11px/1.35 ui-monospace,monospace;color:#cde;background:rgba(8,12,20,.85);padding:6px 8px;border-radius:6px;pointer-events:auto;white-space:pre';
    const text = document.createElement('div');
    const row = document.createElement('div');
    row.style.cssText = 'margin-top:4px;display:flex;gap:4px';
    const button = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'font:inherit';
      b.onclick = async () => {
        b.textContent = await fn();
        setTimeout(() => (b.textContent = label), 2000);
      };
      row.append(b);
    };
    const copy = async (json) => {
      try {
        await navigator.clipboard.writeText(json);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = json;
        document.body.append(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      return `Copied ${(json.length / 1024).toFixed(0)} kB`;
    };
    button('Copy JSON', () => copy(JSON.stringify(snapshot())));
    button('Copy summary', () => {
      const s = snapshot();
      return copy(JSON.stringify({ at: s.at, page: s.page, userAgent: s.userAgent, devicePixelRatio: s.devicePixelRatio, gpu: s.gpu, summary: s.summary }, null, 1));
    });
    button('Save JSON', () => {
      const json = JSON.stringify(snapshot());
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      a.download = `netmap-orbits-perf-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return 'Saved';
    });
    el.append(text, row);
    document.body.append(el);
    const f = (s, d = 1) => (s?.median == null ? '–' : `${round(s.median, d)} / ${round(s.p95, d)}`);
    const top = (m, n = 3) =>
      Object.entries(m)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([k, v]) => `${k.replace(/^netgl /, '')} ${v}`)
        .join(', ') || '–';
    const tick = setInterval(() => {
      const s = summary();
      const g = s.guest ? Object.entries(s.guest).filter(([k, v]) => k !== 't' && typeof v === 'number').slice(0, 6) : [];
      const mt = s.mainThread;
      text.textContent =
        `orbits perf (median / p95)   wire: ${s.wire}\n` +
        `guest ${s.guestFps ?? '–'} fps   deck draws/guest frame ${s.deckDrawsPerGuestFrame ?? '–'} (rest ${s.deckDrawsPerGuestFrameAtRest ?? '–'}, input ${s.deckDrawsPerGuestFrameWithInput ?? '–'})\n` +
        `draws/animation frame max ${s.drawsPerVsync.max ?? '–'}, bursts (3+) ${s.bursts}\n` +
        `draw reasons ${top(s.drawReasons)}\n` +
        `input→shown ms     ${f(s.inputToShownMs, 0)}\n` +
        `view→drawn ms      ${f(s.viewToDrawnMs, 0)}   lag ms ${f(s.lagMs, 0)}\n` +
        `deck draw ms       ${f(s.deckDrawMs)}  replay ${f(s.replayMs)}\n` +
        `msgs/frame ${f(s.msgsPerFrame, 0)}  calls ${f(s.callsPerFrame, 0)}  kB/frame ${s.bytesPerFrame.median == null ? '–' : round(s.bytesPerFrame.median / 1024, 0)}\n` +
        `recv ms/frame deser ${s.deserMsPerFrame ? f(s.deserMsPerFrame) : 'n/a'} + handle ${f(s.handleMsPerFrame)}\n` +
        `main thread busy ${mt.pct == null ? 'n/a' : `≥${mt.pct}%`} (${mt.longFrames} long frames / ${mt.windowS} s)${mt.scriptMsPerS.messages ? `, messages ${mt.scriptMsPerS.messages} ms/s` : ''}\n` +
        `anchors ${s.anchors.n} msgs, recv ${f(s.anchors.deserMs, 0)} + ${f(s.anchors.handleMs, 0)} ms\n` +
        `guest ${g.length ? g.map(([k, v]) => `${k} ${round(v, 1)}`).join(', ') : '(no layer:stats)'}`;
    }, 500);
    return () => {
      clearInterval(tick);
      el.remove();
    };
  };

  /** Stop listening (the layer was turned off); deck's own draw comes back. */
  const detach = (deck) => {
    for (const u of undo.splice(0)) u?.();
    if (deck?.__orbitsPerfDrawLayers) deck._drawLayers = deck.__orbitsPerfDrawLayers;
  };

  return { wrapTransport, observe, attach, detach, guestStats, summary, snapshot, hud, frames, draws, views, anchors, inputs, longFrames, guest };
}
