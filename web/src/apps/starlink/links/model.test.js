import test from 'node:test';
import assert from 'node:assert/strict';
import { LinkModel, MODEL, nearestPop, pickServing, slotOf } from './model.js';
import { gcKm, fibreMs, vacuumMs } from './geometry.js';
import { EPOCH, walker } from './testShells.js';

// A Gen1-like shell, 72 planes of 22 at 53° and 550 km, all with lasers.
const OMM = walker({ incl: 53, alt: 550, planes: 72, per: 22, phase: 39 });
const GATEWAYS = [
  { id: 'us-kc', name: 'Kansas City', lat: 39.137, lon: -94.578, alt_m: 230 },
  { id: 'us-merrillan', name: 'Merrillan', lat: 44.406, lon: -90.814 },
  { id: 'nz-awarua', name: 'Awarua', lat: -46.53, lon: 168.37 },
];
const POPS = [
  { code: 'knsymox1', city: 'Kansas City', lat: 39.2976, lon: -94.7139 },
  { code: 'chcoilx1', city: 'Chicago', lat: 41.9786, lon: -87.9048 },
  { code: 'acklnzl1', city: 'Auckland', lat: -37.008, lon: 174.792 },
  { code: 'staging2', city: null, lat: null, lon: null },
];
const T0 = Date.parse(`${EPOCH}Z`) + 3600e3;

test('slotOf: 15 s slots starting at :12, :27, :42, :57', () => {
  const m = Date.parse('2026-11-07T03:00:00Z');
  assert.equal(slotOf(m + 11999), slotOf(m - 3000));
  assert.equal(slotOf(m + 12000), slotOf(m + 26999));
  assert.equal(slotOf(m + 27000), slotOf(m + 12000) + 1);
  assert.equal(slotOf(m + 57000) + 1, slotOf(m + 72000));
});

test('pickServing: bent pipe first (highest), then the cheapest laser path, then the highest', () => {
  const vis = [{ i: 1, el: 80, terminal: false }, { i: 2, el: 40, terminal: true }, { i: 3, el: 60, terminal: true }];
  assert.deepEqual(pickServing(vis), { i: 3, rule: 'bent-pipe' });
  const none = vis.map((v) => ({ ...v, terminal: false }));
  assert.deepEqual(pickServing(none), { i: 1, rule: 'no-gateway' });
  assert.deepEqual(pickServing(none, { laserCost: (v) => ({ 1: 9, 2: 5, 3: Infinity })[v.i] }), { i: 2, rule: 'laser' });
  assert.equal(pickServing([]), null);
});

test('nearestPop: the closest placed PoP', () => {
  assert.equal(POPS[nearestPop(POPS, -94.6, 39.1).pop].code, 'knsymox1');
  assert.equal(POPS[nearestPop(POPS, 168.37, -46.53).pop].code, 'acklnzl1');
  assert.deepEqual(nearestPop([], 0, 0), { pop: -1, km: null });
});

test('a dish in Kansas: in view above the mask, a bent pipe to a gateway it sees, its PoP, the light times', () => {
  const m = new LinkModel({ omm: OMM, gateways: GATEWAYS, pops: POPS });
  m.propagate(T0);
  m.gatewayViews();
  const s = m.summary();
  assert.equal(s.sats, 1584);
  assert.equal(s.operational, 1584);
  const d = m.dish(-98.5, 38.5);
  assert.ok(d.nVisible >= 4, `${d.nVisible} in view`);
  for (const v of d.visible) assert.ok(v.el >= MODEL.userMask);
  const sv = d.serving;
  assert.equal(sv.rule, 'bent-pipe');
  // The highest of those that see a gateway.
  const terminals = d.visible.filter((v) => v.terminal);
  assert.equal(sv.el, Math.max(...terminals.map((v) => v.el)));
  assert.ok(d.gateways.length >= 1 && d.exit);
  assert.ok(['us-kc', 'us-merrillan'].includes(d.exit.id));
  // The exit gateway sees the satellite above its mask, and the PoP is the gateway's nearest.
  assert.equal(d.exit.popCode, d.exit.id === 'us-kc' ? 'knsymox1' : 'chcoilx1');
  const L = d.latency;
  assert.ok(Math.abs(L.up - vacuumMs(sv.range)) < 1e-9 && Math.abs(L.down - vacuumMs(d.exit.range)) < 1e-9);
  assert.ok(Math.abs(L.backhaul - fibreMs(gcKm(d.exit.lon, d.exit.lat, d.exit.popLon, d.exit.popLat))) < 1e-6);
  assert.ok(Math.abs(L.total - (L.up + L.down + L.backhaul)) < 1e-9);
  assert.ok(sv.range >= 550 && sv.range < 1150, `${sv.range}`);
  assert.ok(L.total > 3 && L.total < 10, `${L.total} ms`);
  // gatewaysOf agrees: every gateway listed sees the satellite.
  assert.deepEqual(new Set(d.gateways.map((g) => g.id)), new Set(m.gatewaysOf(sv.i).map(({ g }) => GATEWAYS[g].id)));
});

test('the serving satellite is held for its 15 s slot, then re-picked', () => {
  const m = new LinkModel({ omm: OMM, gateways: GATEWAYS, pops: POPS });
  // Start just after a slot begins.
  const t = (slotOf(T0) + 1) * MODEL.slotMs + MODEL.slotOffsetMs + 500;
  m.propagate(t);
  m.gatewayViews();
  const a = m.dish(-98.5, 38.5).serving;
  m.propagate(t + 10000);
  m.gatewayViews();
  const b = m.dish(-98.5, 38.5).serving;
  assert.equal(b.norad, a.norad);
  assert.equal(b.held, true);
  m.propagate(t + 15000 * 8);
  m.gatewayViews();
  const c = m.dish(-98.5, 38.5).serving;
  assert.equal(c.held, false); // a new slot: picked afresh
  // A pinned satellite serves while it's in view.
  const other = m.dish(-98.5, 38.5).visible.find((v) => v.norad !== c.norad);
  const p = m.dish(-98.5, 38.5, { pin: other.norad }).serving;
  assert.equal(p.norad, other.norad);
  assert.equal(p.rule, 'pinned');
});

test('mid-ocean: satellites in view, none sees a gateway', () => {
  const m = new LinkModel({ omm: OMM, gateways: GATEWAYS, pops: POPS });
  m.propagate(T0);
  m.gatewayViews();
  const d = m.dish(-150, 10);
  assert.ok(d.nVisible > 0);
  assert.equal(d.nTerminal, 0);
  assert.equal(d.serving.rule, 'no-gateway');
  assert.equal(d.exit, null);
  assert.equal(d.latency, null);
});
