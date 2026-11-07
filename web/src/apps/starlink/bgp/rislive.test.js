import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPrefixTable } from './prefixes.js';
import { backoffDelay, createRisLive, foldPath, parseRisMessage, pathAsns, risSubscriptions, STARLINK_ASN } from './rislive.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/ris-live.json', import.meta.url)));
const table = createPrefixTable(JSON.parse(readFileSync(new URL('./fixtures/prefixes-sample.json', import.meta.url))));
// What the section treats as Starlink's: in the geofeed, or announced by it (RIPEstat).
const announced = new Set(['74.245.197.0/24']);
const isOurs = (p) => announced.has(p) || !!table.lookup(p);

test('foldPath: prepends folded, AS_SETs kept; pathAsns skips the sets', () => {
  const hops = foldPath([8298, 21859, 21859, 21859, 14593, 14593, [65001, 65002], '7']);
  assert.deepEqual(hops, [
    { asn: 8298, n: 1 },
    { asn: 21859, n: 3 },
    { asn: 14593, n: 2 },
    { asn: [65001, 65002], n: 1 },
    { asn: 7, n: 1 },
  ]);
  assert.deepEqual(pathAsns(hops), [8298, 21859, 14593, 7]);
  assert.deepEqual(foldPath(undefined), []);
});

test('parse: a v6 announcement originated by AS14593 (a recorded frame)', () => {
  const u = parseRisMessage(JSON.stringify(fx.v6_pop), { isOurs });
  assert.equal(u.type, 'update');
  assert.equal(u.host, 'rrc12');
  assert.equal(u.peerAsn, 51184);
  assert.equal(u.peer, '2001:7f8::c7f0:0:1');
  assert.equal(u.time, Math.round(fx.v6_pop.data.timestamp * 1000));
  assert.equal(u.id, fx.v6_pop.data.id);
  assert.deepEqual(pathAsns(u.path), [51184, 8529, 14593]);
  assert.equal(u.origin, STARLINK_ASN);
  assert.ok(u.via && !u.transit);
  assert.deepEqual(u.announce, ['2a0d:3344:4000::/38', '2a0d:3341:d400::/40']);
  assert.deepEqual(u.withdraw, []);
  assert.equal(table.lookup(u.announce[1]).pop, 'msctomn1');
});

test('parse: a v4 announcement with a 7-fold prepend, outside the geofeed', () => {
  const u = parseRisMessage(fx.v4_nopop, { isOurs });
  assert.deepEqual(u.path.at(-1), { asn: 14593, n: 7 });
  assert.equal(u.origin, 14593);
  assert.ok(u.announce.length > 0);
  for (const p of u.announce) assert.equal(table.lookup(p), null);
});

test('parse: a mixed frame keeps its announcement and drops the withdrawals that are not Starlink\'s', () => {
  const u = parseRisMessage(fx.mixed, { isOurs });
  assert.deepEqual(u.announce, ['74.245.197.0/24']);
  assert.deepEqual(u.withdraw, []); // 173.82.129.0/24 and 130.137.47.0/24 aren't
});

test('parse: transit, a customer route through AS14593', () => {
  const u = parseRisMessage(fx.transit, { isOurs });
  assert.ok(u.via && u.transit);
  assert.equal(u.origin, 134204);
  assert.deepEqual(u.announce, ['2400:4d40:6000::/36']);
});

test('parse: a withdrawal-only frame from the prefix subscription keeps only Starlink\'s', () => {
  const u = parseRisMessage(fx.withdraw, { isOurs });
  assert.deepEqual(u.withdraw, ['74.245.197.0/24']);
  assert.deepEqual(u.announce, []);
  assert.deepEqual(u.path, []);
  assert.equal(u.origin, null);
  assert.ok(!u.via);
  assert.equal(parseRisMessage(fx.withdraw, { isOurs: () => false }), null, 'none of them ours');
});

test('parse: control frames and junk', () => {
  assert.deepEqual(parseRisMessage(fx.subscribe_ok), { type: 'ok' });
  assert.deepEqual(parseRisMessage('{"type":"pong","data":null}'), { type: 'pong' });
  assert.deepEqual(parseRisMessage({ type: 'ris_error', data: { message: 'Too slow' } }), { type: 'error', message: 'Too slow' });
  assert.equal(parseRisMessage('not json'), null);
  assert.equal(parseRisMessage({ type: 'ris_message', data: { type: 'KEEPALIVE' } }), null);
  assert.equal(parseRisMessage(null), null);
});

test('risSubscriptions: the path, then withdrawals under the cover', () => {
  assert.deepEqual(risSubscriptions(), [{ type: 'UPDATE', path: 14593 }]);
  assert.deepEqual(risSubscriptions(14593, ['9.0.0.0/8']), [
    { type: 'UPDATE', path: 14593 },
    { type: 'UPDATE', require: 'withdrawals', prefix: ['9.0.0.0/8'] },
  ]);
});

test('backoffDelay: doubles from 1 s to a 60 s cap, ±25 %', () => {
  assert.deepEqual([0, 1, 2, 3, 6, 7, 20].map((a) => backoffDelay(a, {}, () => 0.5)), [1000, 2000, 4000, 8000, 60000, 60000, 60000]);
  assert.equal(backoffDelay(0, {}, () => 0), 750);
  assert.equal(backoffDelay(0, {}, () => 1), 1250);
});

// A fake socket and clock for the client.
function harness() {
  const sockets = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
      sockets.push(this);
    }
    send(s) {
      this.sent.push(JSON.parse(s));
    }
    close() {
      this.closed = true;
    }
  }
  let t = 0;
  let nextId = 1;
  const pending = new Map(); // id -> { at, fn, every }
  const timers = {
    setTimeout: (fn, ms) => (pending.set(nextId, { at: t + ms, fn }), nextId++),
    clearTimeout: (id) => pending.delete(id),
    setInterval: (fn, ms) => (pending.set(nextId, { at: t + ms, fn, every: ms }), nextId++),
    clearInterval: (id) => pending.delete(id),
  };
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      const due = [...pending].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, p] = due;
      t = p.at;
      if (p.every) p.at += p.every;
      else pending.delete(id);
      p.fn();
    }
    t = end;
  };
  return { sockets, FakeWS, timers, advance, now: () => t };
}

test('client: subscribes on open, passes frames on, reconnects with backoff and resubscribes', () => {
  const h = harness();
  const frames = [];
  const states = [];
  const c = createRisLive({ WebSocket: h.FakeWS, timers: h.timers, now: h.now, random: () => 0.5, subscriptions: risSubscriptions(), onMessage: (d) => frames.push(d), onState: (s) => states.push(s.status) });
  c.start();
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0].url, 'wss://ris-live.ripe.net/v1/ws/?client=netmap');
  assert.equal(c.state.status, 'connecting');
  h.sockets[0].onopen();
  assert.equal(c.state.status, 'open');
  assert.deepEqual(h.sockets[0].sent, [{ type: 'ris_subscribe', data: { type: 'UPDATE', path: 14593 } }]);
  c.subscribe({ type: 'UPDATE', require: 'withdrawals', prefix: ['9.0.0.0/8'] }); // sent at once when open
  assert.equal(h.sockets[0].sent.length, 2);
  h.sockets[0].onmessage({ data: 'x' });
  assert.deepEqual(frames, ['x']);

  // drops: 1 s, then 2 s, then 4 s
  h.sockets[0].onclose({ code: 1006 });
  assert.equal(c.state.status, 'waiting');
  assert.equal(c.state.retryAt, h.now() + 1000);
  h.advance(999);
  assert.equal(h.sockets.length, 1);
  h.advance(1);
  assert.equal(h.sockets.length, 2);
  h.sockets[1].onclose({ code: 1006 });
  assert.equal(c.state.retryAt - h.now(), 2000);
  h.advance(2000);
  h.sockets[2].onclose({ code: 1006 });
  assert.equal(c.state.retryAt - h.now(), 4000);
  assert.equal(c.state.attempt, 3);
  h.advance(4000);
  // this one works: both subscriptions resent, and the backoff starts over after a frame
  h.sockets[3].onopen();
  assert.equal(h.sockets[3].sent.length, 2);
  h.sockets[3].onmessage({ data: 'y' });
  assert.equal(c.state.attempt, 0);
  h.sockets[3].onclose({ code: 1006 });
  assert.equal(c.state.retryAt - h.now(), 1000);

  c.stop();
  assert.equal(c.state.status, 'off');
  h.advance(120_000);
  assert.equal(h.sockets.length, 4, 'no reconnect after stop');
  assert.ok(states.includes('waiting') && states.at(-1) === 'off');
});

test('client: pings while open, and reconnects when an open socket goes silent', () => {
  const h = harness();
  const c = createRisLive({ WebSocket: h.FakeWS, timers: h.timers, now: h.now, random: () => 0.5, pingMs: 30_000, stallMs: 90_000 });
  c.start();
  h.sockets[0].onopen();
  h.advance(30_000);
  assert.deepEqual(h.sockets[0].sent.at(-1), { type: 'ping', data: null });
  h.sockets[0].onmessage({ data: '{"type":"pong","data":null}' });
  h.advance(60_000); // 60 s since the pong: still fine
  assert.equal(c.state.status, 'open');
  h.advance(60_000); // 120 s of silence
  assert.equal(c.state.status, 'waiting');
  assert.ok(h.sockets[0].closed);
  assert.match(c.state.error, /no data/);
  c.stop();
});

test('client: stop() mid-connect leaves no handlers, and a late event from the old socket is ignored', () => {
  const h = harness();
  const frames = [];
  const c = createRisLive({ WebSocket: h.FakeWS, timers: h.timers, now: h.now, onMessage: (d) => frames.push(d) });
  c.start();
  const s = h.sockets[0];
  const onmessage = s.onmessage;
  c.stop();
  assert.ok(s.closed);
  assert.equal(s.onmessage, null);
  onmessage({ data: 'late' });
  assert.deepEqual(frames, []);
  c.start(); // and it can start again
  assert.equal(h.sockets.length, 2);
  c.stop();
});

test('client: a constructor that throws (blocked) waits and retries', () => {
  const h = harness();
  let n = 0;
  class Throws {
    constructor() {
      n++;
      throw new Error('blocked');
    }
  }
  const c = createRisLive({ WebSocket: Throws, timers: h.timers, now: h.now, random: () => 0.5 });
  c.start();
  assert.equal(c.state.status, 'waiting');
  assert.equal(c.state.error, 'blocked');
  h.advance(1000);
  assert.equal(n, 2);
  c.stop();
});
