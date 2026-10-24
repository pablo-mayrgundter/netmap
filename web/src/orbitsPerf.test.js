import test from 'node:test';
import assert from 'node:assert/strict';
import { argBytes, callBytes, callKind, drawsPerVsync, frameEndToNextAnimationFrame, inputToShown, invokerKind, makeOrbitsPerf, reprojectionShiftPx, unpack } from './orbitsPerf.js';

test('calls are grouped into the payload table’s families', () => {
  assert.equal(callKind('bufferSubData'), 'buffer');
  assert.equal(callKind('texSubImage2D'), 'texture');
  assert.equal(callKind('uniformMatrix4fv'), 'uniform');
  assert.equal(callKind('drawElementsInstanced'), 'draw');
  assert.equal(callKind('bindBuffer'), 'state');
});

test('a call’s size is its binary data plus a few bytes an argument', () => {
  const buffer = new ArrayBuffer(1200);
  const call = { name: 'bufferSubData', args: [34962, 0, { __netgl_typedarray: 'Float32Array', buffer, offset: 0, length: 300 }, 0, 30] };
  assert.equal(argBytes(call.args[2]), 1200);
  assert.equal(callBytes(call), 16 + 'bufferSubData'.length + 8 * 5 + 1200);
  assert.equal(argBytes([{ __netgl_arraybuffer: new ArrayBuffer(8) }, 3]), 8);
  assert.equal(argBytes(new Float32Array(4).subarray(1, 3)), 8); // a slice, as 0.6.0 may send
});

test('batches unpack, whatever their shape', () => {
  const c = { name: 'drawArrays', args: [] };
  assert.deepEqual(unpack([c]), [c]);
  assert.deepEqual(unpack({ batch: [c] }), [c]);
  assert.deepEqual(unpack({ type: 'netgl:frame', calls: [c] }), [c]);
  assert.deepEqual(unpack(c), [c]);
});

// A transport, receiver and adapter like portal-netgl's: calls, then frame-end.
function fakeLink(perf) {
  const listeners = new Set();
  const frameListeners = new Set();
  const transport = perf.wrapTransport({ post() {}, outputOrigin: 'https://g.example', onMessage: (l) => (listeners.add(l), () => listeners.delete(l)) }, null);
  const receive = (msg) => {
    for (const m of unpack(msg)) if (m?.type === 'netgl:frame-end') for (const f of frameListeners) f();
  };
  transport.onMessage(receive);
  const deck = { props: {}, setProps(p) { Object.assign(this.props, p); }, getViewports: () => [] };
  const layer = {
    stats: { viewsSent: 0, redrawsForced: 2, redrawsFolded: 5 },
    receiver: { onFrame: (l) => (frameListeners.add(l), () => frameListeners.delete(l)), wire: { version: 2, port: 'open', batches: 1 } },
    requestGuestFrame() {
      this.stats.viewsSent += 1;
      return true;
    },
  };
  perf.attach(deck, layer);
  return { deliver: (msg) => { for (const l of listeners) l(msg); }, transport, layer, receive };
}

test('a frame in one message, or a call a message, counts the same calls', () => {
  const calls = [{ name: 'bindBuffer', args: [34962, { __netgl_handle: 1 }] }, { name: 'drawArrays', args: [0, 0, 3] }, { type: 'netgl:frame-end' }];
  const batched = makeOrbitsPerf();
  const b = fakeLink(batched);
  batched.observe({ data: { type: 'netgl:batch', batch: calls } }); // the window listener, first
  b.deliver({ type: 'netgl:batch', batch: calls });
  const single = makeOrbitsPerf();
  const link = fakeLink(single);
  for (const c of calls) {
    single.observe({ data: c });
    link.deliver(c);
  }
  for (const perf of [batched, single]) {
    assert.equal(perf.frames.length, 1);
    assert.equal(perf.frames[0].calls, 2);
    assert.equal(perf.frames[0].kinds.draw.n, 1);
  }
  assert.equal(batched.frames[0].wireMsgs, 1);
  assert.equal(single.frames[0].wireMsgs, 3);
  assert.equal(batched.summary().msgsPerFrame.median, 1);
  assert.equal(batched.summary().wire.version, 2);
  assert.deepEqual(batched.summary().redraws, { forced: 2, folded: 5, viewsSent: 0, clockRequests: 0 });
});

test('without the wire in sight, messages a frame are the transport’s deliveries', () => {
  const perf = makeOrbitsPerf();
  const link = fakeLink(perf);
  link.deliver({ type: 'netgl:batch', batch: [{ name: 'drawArrays', args: [] }, { type: 'netgl:frame-end' }] });
  assert.equal(perf.summary().msgsPerFrame.median, 1);
  assert.equal(perf.summary().deserMsPerFrame, null);
});

test('views come from the adapter’s count; frames take the last one', () => {
  const perf = makeOrbitsPerf();
  const link = fakeLink(perf);
  assert.equal(link.layer.requestGuestFrame(), true); // the clock asks
  link.deliver({ name: 'drawArrays', args: [] });
  link.deliver({ type: 'netgl:frame-end' });
  link.deliver({ type: 'layer:anchors', anchors: [{ id: 'dsn:DSS-43' }] });
  assert.equal(perf.frames.length, 1);
  assert.equal(perf.frames[0].viewId, 1);
  assert.equal(perf.views.get(1).by, 'request');
  assert.equal(perf.summary().redraws.clockRequests, 1);
  assert.equal(perf.anchors.length, 1);
});

test('a port the receiver opens is read like the window', { skip: typeof MessageChannel !== 'function' || !Object.getOwnPropertyDescriptor(globalThis.MessagePort?.prototype ?? {}, 'onmessage')?.set }, async () => {
  const perf = makeOrbitsPerf();
  const link = fakeLink(perf);
  const ch = new MessageChannel(); // as the receiver does, on wire 2
  const got = new Promise((resolve) => {
    ch.port1.onmessage = (ev) => {
      link.receive(ev.data);
      resolve();
    };
  });
  ch.port2.postMessage({ type: 'netgl:batch', batch: [{ name: 'drawArrays', args: [] }, { type: 'netgl:frame-end' }] });
  await got;
  ch.port1.close();
  perf.detach();
  assert.equal(perf.frames.length, 1);
  assert.equal(perf.frames[0].portMsgs, 1);
  assert.equal(perf.summary().wire.portMsgs, 1);
  assert.equal(globalThis.MessageChannel.__orbitsPerf, undefined); // put back
});

test('draws in one animation frame are a burst', () => {
  const draws = [{ vsync: 1 }, { vsync: 1 }, { vsync: 1 }, { vsync: 2 }, { vsync: null }];
  assert.deepEqual(drawsPerVsync(draws).sort(), [1, 3]);
});

test('input → shown: to the first frame drawn for a view sent after the input', () => {
  const frames = [
    { tView: 0, tDrawn: 50 },
    { tView: 100, tDrawn: 400 },
    { tView: 500, tDrawn: null },
    { tView: 600, tDrawn: 900 },
  ];
  assert.deepEqual(inputToShown([{ t: 10 }, { t: 450 }, { t: 2000 }], frames), [390, 450]);
});

test('frame end → next animation frame: the browser’s wait, apart from the adapter’s', () => {
  const frames = [{ tEnd: 15 }, { tEnd: 170 }, { tEnd: null }, { tEnd: 400 }];
  // Frames at 0, 150, 300: the first frame waits 135 ms, the second 130.
  assert.deepEqual(frameEndToNextAnimationFrame(frames, [0, 150, 300]), [135, 130]);
});

test('long frames’ scripts are sorted by who ran them', () => {
  assert.equal(invokerKind({ invoker: 'Window.onmessage', invokerType: 'event-listener' }), 'messages');
  assert.equal(invokerKind({ invoker: 'MessagePort.onmessage', invokerType: 'event-listener' }), 'messages');
  assert.equal(invokerKind({ invoker: 'FrameRequestCallback', invokerType: 'user-callback' }), 'animationFrame');
  assert.equal(invokerKind({ invoker: 'TimerHandler:setInterval', invokerType: 'user-callback' }), 'timers');
  assert.equal(invokerKind({ invoker: 'DIV.onpointermove', invokerType: 'event-listener' }), 'input');
});

test('the guest’s own stats, when it sends them, are in the summary', () => {
  const perf = makeOrbitsPerf();
  assert.equal(perf.summary().guest, null);
  perf.guestStats({ type: 'layer:stats', frames: 4, updateMs: 0.8, renderMs: 4.2, recordMs: 1.1, anchorsMs: 0.1, calls: 170, messages: 1, bytes: 50000 });
  assert.equal(perf.summary().guest.renderMs, 4.2);
});

test('a reprojection’s shift is the most the globe’s points moved, and 0 without a correction', () => {
  // A stand-in projection: x pixels = ECEF x / 1e5 plus the view's pan.
  const project = (view, p) => [p[0] / 1e5 + view.pan, p[1] / 1e5, 0];
  const from = { pan: 0, earth: { radius: 6e6 } };
  const to = { pan: 12, earth: { radius: 6e6 } };
  assert.equal(reprojectionShiftPx({ from, to, correction: [1] }, project), 12);
  assert.equal(reprojectionShiftPx({ from, to, correction: null }, project), 0);
  assert.equal(reprojectionShiftPx(null, project), 0);
  // Points out of the depth range don't count.
  const behind = (view, p) => [p[0] / 1e5 + view.pan, 0, 2];
  assert.equal(reprojectionShiftPx({ from, to, correction: [1] }, behind), 0);
});
