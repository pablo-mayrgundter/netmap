import test from 'node:test';
import assert from 'node:assert/strict';
import { argBytes, callBytes, callKind, makeOrbitsPerf } from './orbitsPerf.js';

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
});

test('a batch of calls in one message counts as one message of one frame', () => {
  const perf = makeOrbitsPerf();
  const calls = [{ name: 'bindBuffer', args: [34962, { __netgl_handle: 1 }] }, { name: 'drawArrays', args: [0, 0, 3] }, { type: 'netgl:frame-end' }];
  perf.observe({ data: { batch: calls } });
  assert.equal(perf.frames.length, 1);
  assert.equal(perf.frames[0].calls, 2);
  assert.equal(perf.frames[0].msgs, 1);
  assert.equal(perf.frames[0].kinds.draw.n, 1);
});
