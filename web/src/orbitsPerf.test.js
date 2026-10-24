import test from 'node:test';
import assert from 'node:assert/strict';
import { argBytes, callBytes, callKind, drawsPerVsync, inputToShown, invokerKind, makeOrbitsPerf, unpack } from './orbitsPerf.js';

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

// A transport and a receiver like portal-netgl's: calls, then frame-end.
function fakeLink(perf) {
  const listeners = new Set();
  const frameListeners = new Set();
  const transport = perf.wrapTransport({ post() {}, onMessage: (l) => (listeners.add(l), () => listeners.delete(l)) }, null);
  transport.onMessage((msg) => {
    for (const m of unpack(msg)) if (m?.type === 'netgl:frame-end') for (const f of frameListeners) f();
  });
  const deck = { props: {}, setProps(p) { Object.assign(this.props, p); }, getViewports: () => [] };
  perf.attach(deck, { receiver: { onFrame: (l) => (frameListeners.add(l), () => frameListeners.delete(l)) }, stats: {} });
  return { deliver: (msg) => { for (const l of listeners) l(msg); }, transport };
}

test('a frame in one message, or a call a message, counts the same calls', () => {
  const calls = [{ name: 'bindBuffer', args: [34962, { __netgl_handle: 1 }] }, { name: 'drawArrays', args: [0, 0, 3] }, { type: 'netgl:frame-end' }];
  const batched = makeOrbitsPerf();
  fakeLink(batched).deliver({ batch: calls });
  const single = makeOrbitsPerf();
  const link = fakeLink(single);
  for (const c of calls) link.deliver(c);
  for (const perf of [batched, single]) {
    assert.equal(perf.frames.length, 1);
    assert.equal(perf.frames[0].calls, 2);
    assert.equal(perf.frames[0].kinds.draw.n, 1);
  }
  assert.equal(batched.frames[0].deliveries, 1);
  assert.equal(single.frames[0].deliveries, 3);
  // No window messages seen: messages per frame are the transport's deliveries.
  assert.equal(batched.summary().wire, 'transport');
  assert.equal(batched.summary().msgsPerFrame.median, 1);
  assert.equal(batched.summary().deserMsPerFrame, null);
});

test('views and frames line up; anchors are counted apart from frames', () => {
  const perf = makeOrbitsPerf();
  const link = fakeLink(perf);
  link.transport.post({ type: 'layer:view', viewId: 7, view: { timeMs: 1 } });
  link.deliver({ name: 'drawArrays', args: [] });
  link.deliver({ type: 'netgl:frame-end' });
  link.deliver({ type: 'layer:anchors', anchors: [{ id: 'dsn:DSS-43' }] });
  assert.equal(perf.frames.length, 1);
  assert.equal(perf.frames[0].viewId, 7);
  assert.equal(perf.anchors.length, 1);
  assert.equal(perf.anchors[0].n, 1);
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
  perf.guestStats({ type: 'layer:stats', renderMs: 4.2, postMs: 1.1 });
  assert.equal(perf.summary().guest.renderMs, 4.2);
});
