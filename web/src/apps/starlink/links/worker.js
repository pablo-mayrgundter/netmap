// The link model's Web Worker: propagation, the mesh, routing and the
// traffic estimate off the main thread (core.js). Messages: { type: 'init' |
// 'tick', id, ... }; each is answered with { type, id, ok, result | error },
// a tick's line buffers transferred, not copied.

import { createCore, transferables } from './core.js';

const core = createCore();
self.onmessage = (e) => {
  const { type, id } = e.data;
  try {
    const result = type === 'init' ? core.init(e.data) : core.tick(e.data);
    self.postMessage({ type, id, ok: true, result }, transferables(result));
  } catch (err) {
    self.postMessage({ type, id, ok: false, error: String(err?.message ?? err) });
  }
};
