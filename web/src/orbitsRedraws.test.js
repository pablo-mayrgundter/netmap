import test from 'node:test';
import assert from 'node:assert/strict';
import { GUEST_FRAME_REASON, linksKey, makeRedraws } from './orbitsRedraws.js';

// A deck that draws like deck.gl 9: `redraw(reason)` forces a draw, `redraw()`
// draws only if a flag is set, and its loop (`frame()`) checks the flag once
// an animation frame.
function fakeDeck({ flag = true } = {}) {
  const deck = {
    props: { onBeforeRender: null },
    drawn: [],
    needs: false,
    setProps(p) {
      Object.assign(this.props, p);
    },
    redraw(reason) {
      const why = this.needs || reason;
      this.needs = false;
      if (!why) return;
      this.props.onBeforeRender?.({});
      this.drawn.push(why);
    },
    frame() {
      this.redraw();
    },
  };
  if (flag) deck.layerManager = { setNeedsRedraw: (r) => (deck.needs = deck.needs || r) };
  return deck;
}

test('clock ticks while frames stall make one draw, not a burst', () => {
  const deck = fakeDeck();
  const r = makeRedraws(deck);
  for (let i = 0; i < 100; i += 1) r.soon('orbits clock');
  deck.frame();
  assert.deepEqual(deck.drawn, ['orbits clock']);
  deck.frame();
  assert.equal(deck.drawn.length, 1);
});

test('without the flag, at most one animation-frame callback is pending, dropped if deck drew', () => {
  const deck = fakeDeck({ flag: false });
  const queued = [];
  const r = makeRedraws(deck, { raf: (cb) => queued.push(cb) });
  for (let i = 0; i < 100; i += 1) r.soon('orbits clock');
  assert.equal(queued.length, 1);
  queued.shift()();
  assert.deepEqual(deck.drawn, ['orbits clock']);
  r.soon('orbits clock');
  deck.redraw('camera'); // deck drew first: the tick rides along
  queued.shift()();
  assert.deepEqual(deck.drawn, ['orbits clock', 'camera']);
});

test('the adapter’s forced redraw for a guest frame already drawn is folded', () => {
  const deck = fakeDeck();
  const r = makeRedraws(deck);
  // A frame arrives; the links' update makes deck's loop draw it first.
  r.frameArrived();
  deck.layerManager.setNeedsRedraw('updating layers');
  deck.frame();
  r.host.redraw(GUEST_FRAME_REASON);
  assert.deepEqual(deck.drawn, ['updating layers']);
  assert.equal(r.stats.folded, 1);
  // A frame nothing else drew: the adapter's redraw draws it.
  r.frameArrived();
  r.host.redraw(GUEST_FRAME_REASON);
  assert.deepEqual(deck.drawn, ['updating layers', GUEST_FRAME_REASON]);
  // Other reasons always draw.
  r.host.redraw('netgl guest hello');
  assert.equal(deck.drawn.length, 3);
});

test('the adapter sees the same deck but for redraw', () => {
  const deck = fakeDeck();
  deck.getViewports = function () {
    return [this === deck];
  };
  const r = makeRedraws(deck);
  assert.deepEqual(r.host.getViewports(), [true]);
  r.host.setProps({ onAfterRender: 1 });
  assert.equal(deck.props.onAfterRender, 1);
  assert.equal(r.host.props, deck.props);
  r.stop();
  r.soon('orbits clock');
  deck.frame();
  assert.equal(deck.drawn.length, 0);
});

test('links key: same ids and places, same key', () => {
  const a = [{ id: 'norad:1', ecef: [1, 2, 3] }];
  assert.equal(linksKey(a), linksKey([{ id: 'norad:1', ecef: [1, 2, 3], kind: 'starlink' }]));
  assert.notEqual(linksKey(a), linksKey([{ id: 'norad:1', ecef: [1, 2, 3.5] }]));
  assert.notEqual(linksKey(a), linksKey([]));
});
