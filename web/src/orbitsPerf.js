// The Orbits layer's performance probe: `?orbits_perf=1`.
//
// Measures, on the user's own GPU, where a camera move's time goes between
// netmap (the host) and celestiary's layer page (the guest, a cross-origin
// iframe), from the host's side only, so it works against the production
// guest as it is:
//   - each guest frame: the `layer:view` that asked for it, its GL-call
//     messages (count, bytes by call name), when the first and the last
//     (`netgl:frame-end`) arrived, and the main-thread time spent receiving
//     them (structured-clone deserialisation and the receiver's handler);
//   - each deck draw: why it ran, how long it took, whether it replayed a
//     new guest frame, re-ran the last one or had none, the replay's time,
//     and how many host draws behind the camera the guest content it showed
//     was (the view it answered vs the camera now);
//   - the anchors (`layer:anchors`): how many, how big, how long to receive.
// Times are on one clock, Unix ms (performance.timeOrigin + now), so a
// guest-side log on the same clock lines up with it.
//
// "Copy JSON" in the corner copies the raw records and a summary. Nothing is
// sent anywhere. Costs a little main-thread time per message; off unless
// asked for.

const clock = () => performance.timeOrigin + performance.now();

const UPLOAD_CALLS = new Set(['bufferData', 'bufferSubData', 'texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D', 'compressedTexImage2D', 'compressedTexSubImage2D']);
const DRAW_CALLS = new Set(['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements', 'drawBuffers']);

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

const quantile = (xs, q) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.floor(q * v.length))];
};
const stat = (xs) => ({ n: xs.filter(Number.isFinite).length, median: quantile(xs, 0.5), p95: quantile(xs, 0.95), max: quantile(xs, 1) });
const round = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);

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
  let cur = null; // the guest frame being received
  let lastViewId = null; // the last layer:view posted
  let cam = 0; // camera version: bumped when deck's view matrix changes
  let camKey = '';
  let drawing = null; // the deck draw in progress
  let shown = null; // the guest frame on screen (its record)
  let framesSinceDrain = 0;
  let lastInput = null;
  const push = (arr, x) => {
    arr.push(x);
    if (arr.length > keep) arr.shift();
  };
  const newFrame = (t) => ({ seq: frames.length ? frames[frames.length - 1].seq + 1 : 1, tFirst: t, tEnd: null, viewId: null, msgs: 0, calls: 0, bytes: 0, deserMs: 0, handleMs: 0, kinds: {}, names: {}, drawnIn: null, tDrawn: null });

  // Inbound: a raw listener, registered before the receiver's, sees each
  // message first, so reading `data` here is where Chromium deserialises it.
  const one = (msg, a, deser) => {
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.name === 'string') {
      if (!cur) cur = newFrame(a);
      cur.msgs += 1;
      cur.calls += 1;
      cur.deserMs += deser;
      const b = callBytes(msg);
      cur.bytes += b;
      const k = callKind(msg.name);
      const kk = (cur.kinds[k] ??= { n: 0, bytes: 0, deserMs: 0 });
      kk.n += 1;
      kk.bytes += b;
      kk.deserMs += deser;
      const nn = (cur.names[msg.name] ??= { n: 0, bytes: 0, deserMs: 0 });
      nn.n += 1;
      nn.bytes += b;
      nn.deserMs += deser;
    } else if (msg.type === 'netgl:frame-end') {
      if (!cur) cur = newFrame(a);
      cur.msgs += 1;
      cur.deserMs += deser;
      cur.tEnd = a;
      cur.viewId = lastViewId;
      const v = views.get(lastViewId);
      if (v) cur.tView = v.t;
      push(frames, cur);
      cur = null;
      framesSinceDrain += 1;
    } else if (msg.type === 'layer:anchors') {
      const n = Array.isArray(msg.anchors) ? msg.anchors.length : 0;
      push(anchors, { t: a, viewId: msg.viewId ?? null, n, deserMs: deser });
    }
  };
  // One message event: its data (deserialised here, first), or a batch of
  // calls in one message (`{ batch: [...] }`), counted as one message.
  const observe = (ev) => {
    const a = clock();
    const msg = ev.data;
    const deser = clock() - a;
    if (Array.isArray(msg?.batch)) {
      if (!cur) cur = newFrame(a);
      cur.batches = (cur.batches ?? 0) + 1;
      cur.msgs -= msg.batch.length - 1; // one message carried them all
      msg.batch.forEach((m, i) => one(m, a, i === 0 ? deser : 0));
    } else one(msg, a, deser);
  };
  let source = null;
  const raw = (ev) => {
    if (source && ev.source !== source) return;
    observe(ev);
  };

  const wrapTransport = (transport, win) => {
    source = win;
    window.addEventListener('message', raw, true);
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
        return transport.onMessage((msg) => {
          const a = clock();
          listener(msg);
          const d = clock() - a;
          if (typeof msg?.name === 'string' || msg?.type === 'netgl:frame-end') {
            const f = msg.type === 'netgl:frame-end' ? frames[frames.length - 1] : cur;
            if (f) f.handleMs += d;
          } else if (msg?.type === 'layer:anchors' && anchors.length) {
            anchors[anchors.length - 1].handleMs = d;
          }
        });
      },
    };
  };

  /**
   * Hook the deck and the layer (attachNetGLDeckLayer's handle), after attach.
   * @param {object} deck
   * @param {object} layer
   */
  const attach = (deck, layer) => {
    // One probe at a time: a restarted layer wraps deck's own method, not the last probe's.
    deck.__orbitsPerfDrawLayers ??= deck._drawLayers;
    const drawLayers = deck.__orbitsPerfDrawLayers?.bind(deck);
    let i = 0;
    if (drawLayers) {
      deck._drawLayers = (reason, opts) => {
        const d = { i: ++i, t0: clock(), reason: String(reason ?? ''), replay: 'none', replayMs: 0, viewSent: null, cam: null, shownSeq: null, lagDraws: null, lagMs: null, inputAgeMs: null };
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
        drawing.replayMs = layer.stats?.lastMs ?? 0;
        if (pending > 0 && layer.stats) {
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
    const target = canvas?.parentElement ?? window;
    for (const type of ['pointermove', 'pointerdown', 'wheel', 'keydown']) {
      target.addEventListener(
        type,
        (ev) => {
          if (type === 'pointermove' && !ev.buttons) return;
          lastInput = performance.timeOrigin + ev.timeStamp;
          push(inputs, { t: lastInput, type });
        },
        { capture: true, passive: true },
      );
    }
  };

  /** The summary: medians and p95s over the records kept. */
  const summary = () => {
    const done = frames.filter((f) => f.tEnd);
    const span = done.length > 1 ? (done[done.length - 1].tEnd - done[0].tEnd) / 1000 : 0;
    const kinds = {};
    for (const f of done) for (const [k, v] of Object.entries(f.kinds)) {
      const s = (kinds[k] ??= { n: [], bytes: [] });
      s.n.push(v.n);
      s.bytes.push(v.bytes);
    }
    const moving = draws.filter((d) => d.lagDraws !== null && d.lagDraws > 0);
    const withCam = draws.filter((d) => d.lagDraws !== null);
    return {
      guestFrames: done.length,
      guestFps: span ? round((done.length - 1) / span) : null,
      deckDraws: draws.length,
      deckDrawsPerGuestFrame: done.length ? round(draws.length / done.length) : null,
      drawReasons: draws.reduce((m, d) => ((m[d.reason] = (m[d.reason] ?? 0) + 1), m), {}),
      viewToFrameEndMs: stat(done.map((f) => f.tEnd - f.tView)),
      receiveSpanMs: stat(done.map((f) => f.tEnd - f.tFirst)),
      frameEndToDrawnMs: stat(done.map((f) => f.tDrawn - f.tEnd)),
      viewToDrawnMs: stat(done.map((f) => f.tDrawn - f.tView)),
      msgsPerFrame: stat(done.map((f) => f.msgs)),
      bytesPerFrame: stat(done.map((f) => f.bytes)),
      deserMsPerFrame: stat(done.map((f) => f.deserMs)),
      handleMsPerFrame: stat(done.map((f) => f.handleMs)),
      byKind: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, { n: quantile(v.n, 0.5), bytes: quantile(v.bytes, 0.5) }])),
      deckDrawMs: stat(draws.map((d) => d.ms)),
      replayMs: stat(draws.filter((d) => d.replay !== 'none').map((d) => d.replayMs)),
      replays: draws.reduce((m, d) => ((m[d.replay] = (m[d.replay] ?? 0) + 1), m), {}),
      staleDraws: withCam.length ? round(moving.length / withCam.length) : null,
      lagDraws: stat(moving.map((d) => d.lagDraws)),
      lagMs: stat(moving.map((d) => d.lagMs)),
      inputToDrawMs: stat(draws.filter((d) => d.inputAgeMs !== null && d.inputAgeMs < 1000).map((d) => d.inputAgeMs)),
      anchors: { n: anchors.length, perMsg: stat(anchors.map((a) => a.n)), deserMs: stat(anchors.map((a) => a.deserMs)), handleMs: stat(anchors.map((a) => a.handleMs)) },
    };
  };

  const snapshot = () => ({
    at: new Date().toISOString(),
    since: t0,
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    gpu: gpuName(),
    summary: summary(),
    frames: frames.slice(),
    draws: draws.slice(),
    views: [...views.entries()].map(([viewId, v]) => ({ viewId, ...v })),
    anchors: anchors.slice(),
    inputs: inputs.slice(-100),
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

  /** A corner panel: a few live numbers and "Copy JSON". */
  const hud = (gl) => {
    glForGpu = gl;
    const el = document.createElement('div');
    el.className = 'orbits-perf';
    el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;font:11px/1.35 ui-monospace,monospace;color:#cde;background:rgba(8,12,20,.85);padding:6px 8px;border-radius:6px;pointer-events:auto;white-space:pre';
    const text = document.createElement('div');
    const btn = document.createElement('button');
    btn.textContent = 'Copy JSON';
    btn.style.cssText = 'margin-top:4px;font:inherit';
    btn.onclick = async () => {
      const json = JSON.stringify(snapshot());
      try {
        await navigator.clipboard.writeText(json);
        btn.textContent = `Copied ${(json.length / 1024).toFixed(0)} kB`;
      } catch {
        const ta = document.createElement('textarea');
        ta.value = json;
        document.body.append(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        btn.textContent = 'Copied';
      }
      setTimeout(() => (btn.textContent = 'Copy JSON'), 2000);
    };
    el.append(text, btn);
    document.body.append(el);
    const f = (s, d = 1) => (s?.median == null ? '–' : `${round(s.median, d)} / ${round(s.p95, d)}`);
    const tick = setInterval(() => {
      const s = summary();
      text.textContent =
        `orbits perf (median / p95)\n` +
        `guest ${s.guestFps ?? '–'} fps, deck draws/guest frame ${s.deckDrawsPerGuestFrame ?? '–'}\n` +
        `view→frame-end ms ${f(s.viewToFrameEndMs)}\n` +
        `view→drawn ms     ${f(s.viewToDrawnMs)}\n` +
        `deck draw ms      ${f(s.deckDrawMs)}  replay ${f(s.replayMs)}\n` +
        `msgs/frame ${f(s.msgsPerFrame, 0)}  kB/frame ${s.bytesPerFrame.median == null ? '–' : round(s.bytesPerFrame.median / 1024, 0)}\n` +
        `recv ms/frame ${f(s.deserMsPerFrame)} + ${f(s.handleMsPerFrame)}\n` +
        `stale draws ${s.staleDraws ?? '–'}  lag draws ${f(s.lagDraws, 0)}  lag ms ${f(s.lagMs, 0)}`;
    }, 500);
    return () => {
      clearInterval(tick);
      el.remove();
    };
  };

  /** Stop listening (the layer was turned off); deck's own draw comes back. */
  const detach = (deck) => {
    window.removeEventListener('message', raw, true);
    if (deck?.__orbitsPerfDrawLayers) deck._drawLayers = deck.__orbitsPerfDrawLayers;
  };

  return { wrapTransport, observe, attach, detach, summary, snapshot, hud, frames, draws, views, anchors };
}
