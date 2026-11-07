// The main thread's handle on the link model: a Web Worker (worker.js) when
// the browser has them, else the same core run inline. Requests are
// coalesced: while a tick is being computed, only the newest one waits.

import { createCore } from './core.js';

export function createEngine({ onTick, onError = () => {} } = {}) {
  let worker = null;
  let inline = null;
  let seq = 0;
  let busy = false;
  let next = null; // the newest tick waiting
  let ready = null; // resolves when init is done
  let resolveReady = null;
  let disposed = false;

  try {
    if (typeof Worker === 'function') worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }
  if (!worker) inline = createCore();

  const settle = (msg) => {
    if (disposed) return;
    if (msg.type === 'init') {
      if (msg.ok) resolveReady?.(msg.result);
      else onError(new Error(msg.error));
      return;
    }
    busy = false;
    if (msg.ok) onTick?.(msg.result);
    else onError(new Error(msg.error));
    pump();
  };
  if (worker) {
    worker.onmessage = (e) => settle(e.data);
    worker.onerror = (e) => (busy = false, onError(new Error(e.message || 'the model worker failed')));
  }

  function send(msg) {
    if (worker) return worker.postMessage(msg);
    // Inline: answer on a later task, like a worker would.
    setTimeout(() => {
      try {
        settle({ type: msg.type, id: msg.id, ok: true, result: msg.type === 'init' ? inline.init(msg) : inline.tick(msg) });
      } catch (err) {
        settle({ type: msg.type, id: msg.id, ok: false, error: String(err?.message ?? err) });
      }
    }, 0);
  }

  function pump() {
    if (busy || !next || disposed) return;
    const msg = next;
    next = null;
    busy = true;
    send(msg);
  }

  return {
    inWorker: !!worker,
    /** Build the model: { omm, gateways, pops }. Resolves with its init result. */
    init(payload) {
      ready = new Promise((res) => (resolveReady = res));
      send({ type: 'init', id: ++seq, ...payload });
      return ready;
    },
    /** Ask for a tick; the newest request wins while one is computing. */
    tick(req) {
      next = { type: 'tick', id: ++seq, ...req };
      ready?.then(pump);
    },
    dispose() {
      disposed = true;
      worker?.terminate();
      worker = null;
    },
  };
}
