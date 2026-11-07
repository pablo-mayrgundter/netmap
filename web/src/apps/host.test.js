import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppHost } from './host.js';
import { createRegistry } from './registry.js';
import { fakeBridge, fakeGraph, mountPoints } from './fixtures.js';

const ICON = '<svg viewBox="0 0 24 24"></svg>';
const tick = () => new Promise((r) => setTimeout(r, 0));

// An app that records its life, and keeps its ctx for the test to drive.
function recorder(id) {
  const log = [];
  const app = {
    id,
    title: id,
    icon: ICON,
    log,
    ctx: null,
    mount(el, ctx) {
      app.ctx = ctx;
      log.push(['mount', ctx.hash.all()]);
    },
    unmount() {
      log.push(['unmount']);
    },
    onHash(params) {
      log.push(['onHash', params]);
    },
  };
  return app;
}

function setup(apps = [recorder('one'), recorder('two')]) {
  const bridge = fakeBridge();
  const { made, mountPoint } = mountPoints();
  const host = createAppHost({ registry: createRegistry(apps), bridge, mountPoint, warn: () => {} });
  return { bridge, host, made, apps };
}

const q = (s) => new URLSearchParams(s);
const hashOf = (host) => host.writeHash(new URLSearchParams()).toString();

test('a permalink opens its app with its params; the host writes the same permalink back', async () => {
  const { host, apps } = setup();
  host.applyHash(q('data=x&app=one&side=0&one.pop=sea&two.ignored=1'));
  await tick();
  assert.deepEqual(apps[0].log, [['mount', { pop: 'sea' }]]);
  assert.deepEqual(host.state(), { app: 'one', side: false, loading: false, mounted: 'one' });
  assert.equal(hashOf(host), 'app=one&side=0&one.pop=sea');
});

test('ctx.hash.set writes the permalink, and onHash hears only edits from outside', async () => {
  const { host, bridge, apps } = setup();
  await host.open('one');
  const ctx = apps[0].ctx;
  ctx.hash.set('pop', 'lax');
  ctx.hash.set({ about: '0', pop: null });
  assert.equal(hashOf(host), 'app=one&side=1&one.about=0');
  assert.ok(bridge.calls.filter(([c]) => c === 'writeHash').length >= 2);
  assert.throws(() => ctx.hash.set('Bad Key', 1), TypeError);
  // the same hash coming back (a reload, or our own write echoed): no onHash
  host.applyHash(q(hashOf(host)));
  assert.equal(apps[0].log.filter(([e]) => e === 'onHash').length, 0);
  // an edit
  host.applyHash(q('app=one&side=1&one.about=1'));
  assert.deepEqual(apps[0].log.at(-1), ['onHash', { about: '1' }]);
  assert.equal(ctx.hash.get('about'), '1');
});

test('switching apps unmounts the first; closing by hash unmounts too', async () => {
  const { host, apps, made } = setup();
  host.applyHash(q('app=one'));
  await tick();
  host.applyHash(q('app=two&two.k=v'));
  await tick();
  assert.deepEqual(apps[0].log.map(([e]) => e), ['mount', 'unmount']);
  assert.equal(made[0].removed, true);
  assert.deepEqual(apps[1].log, [['mount', { k: 'v' }]]);
  host.applyHash(q('data=x'));
  assert.deepEqual(apps[1].log.map(([e]) => e), ['mount', 'unmount']);
  assert.equal(host.state().app, null);
  assert.equal(hashOf(host), '');
});

test('side: collapsing keeps the app mounted and in the permalink', async () => {
  const { host, apps } = setup();
  await host.open('one');
  host.applyHash(q('app=one&side=0'));
  assert.equal(host.state().side, false);
  assert.equal(host.state().mounted, 'one');
  assert.deepEqual(apps[0].log.map(([e]) => e), ['mount']);
  host.setSide(true);
  assert.equal(hashOf(host), 'app=one&side=1');
});

test('an unknown app in the hash is ignored', async () => {
  const { host } = setup();
  host.applyHash(q('app=nope'));
  await tick();
  assert.equal(host.state().app, null);
  assert.equal(await host.open('nope'), false);
});

test('quick switches: only the last app asked for mounts', async () => {
  let release;
  const slow = { id: 'slow', title: 'Slow', icon: ICON, load: () => new Promise((r) => (release = r)) };
  const fast = recorder('fast');
  const { host } = setup([slow, fast]);
  const p = host.open('slow');
  assert.equal(host.state().loading, true);
  await host.open('fast');
  release({ mount: () => assert.fail('slow mounted'), unmount() {} });
  await p;
  assert.equal(host.state().mounted, 'fast');
});

test('a failed load shows a notice and opens nothing', async () => {
  const broken = { id: 'broken', title: 'Broken', icon: ICON, load: () => Promise.reject(new Error('404')) };
  const { host, bridge } = setup([broken]);
  assert.equal(await host.open('broken'), false);
  assert.equal(host.state().app, null);
  assert.ok(bridge.calls.some(([c, t]) => c === 'notice' && /Broken didn't load/.test(t)));
});

test('a mount that throws leaves a message in its element, not a broken sidebar', async () => {
  const bad = { ...recorder('bad'), mount: () => { throw new Error('nope'); } };
  const { host, made } = setup([bad]);
  await host.open('bad');
  assert.match(made[0].textContent, /failed to start: nope/);
  host.close();
  assert.equal(host.state().app, null);
});

test('unmounting drops the app\'s layers and listeners; its old ctx goes inert', async () => {
  const { host, bridge, apps } = setup();
  await host.open('one');
  const ctx = apps[0].ctx;
  const heard = [];
  ctx.on('view', (v) => heard.push(v.view));
  const fake = { id: 'dots', clone(p) { return { ...this, ...p }; } };
  ctx.layers.set('pops', [fake]);
  assert.deepEqual(host.layers({}).above.map((l) => l.id), ['app:one:pops:dots']);
  host.emit('view');
  assert.deepEqual(heard, ['globe']);
  assert.equal(ctx.signal.aborted, false);
  host.close();
  assert.equal(ctx.signal.aborted, true);
  assert.deepEqual(host.layers({}).above, []);
  host.emit('view');
  assert.deepEqual(heard, ['globe']);
  // a late callback from the closed app changes nothing
  const before = bridge.calls.length;
  ctx.layers.set('late', [fake]);
  ctx.hash.set('x', '1');
  assert.equal(ctx.select(14593), false);
  assert.equal(ctx.flyTo({ lon: 1, lat: 2 }), false);
  assert.deepEqual(host.layers({}).above, []);
  assert.equal(bridge.calls.length, before);
  assert.throws(() => ctx.on('nope', () => {}), TypeError);
});

test('ctx reads the graph by ASN: node, info, neighbours, position, dataset', async () => {
  const { host, bridge, apps } = setup();
  await host.open('one');
  const ctx = apps[0].ctx;
  assert.equal(ctx.dataset(), null);
  assert.equal(ctx.node(14593), null);
  bridge.G = fakeGraph();
  assert.deepEqual(ctx.dataset(), { id: 'tiny', base: '/data', root: '/data/tiny', name: 'tiny', kind: 'as', synthetic: false, counts: { nodes: 5, edges: 3 }, generated: '2026-11-01T00:00:00+00:00' });
  assert.deepEqual(ctx.node(14593), { asn: 14593, name: 'Space Exploration Technologies Corporation', degree: 3, level: 0.7, region: 'North America', geolocated: true });
  assert.equal(ctx.node(4242), null);
  assert.deepEqual(ctx.neighbours(14593).map(({ asn, rel }) => [asn, rel]), [[3356, 'provider'], [714, 'peer'], [999, 'customer']]);
  assert.deepEqual(ctx.neighbours(999).map(({ asn, rel }) => [asn, rel]), [[14593, 'provider']]);
  assert.deepEqual(ctx.neighbours(4242), []);
  assert.equal((await ctx.info(14593)).cone, 2);
  assert.equal(await ctx.info(4242), null);
  assert.deepEqual(ctx.position(714), [2, 2, 0]);
  assert.equal(ctx.position(4242), null);
});

test('ctx moves the map: select, flyTo an AS, a point or a bbox, a route', async () => {
  const { host, bridge, apps } = setup();
  await host.open('one');
  const ctx = apps[0].ctx;
  bridge.G = fakeGraph();
  assert.equal(ctx.select(3356), true);
  assert.deepEqual(ctx.selection(), { asn: 3356, name: 'Level 3', kind: 'explore' });
  assert.equal(ctx.select(4242), false);
  ctx.flyTo({ asn: 714 });
  ctx.flyTo({ lon: -122.4, lat: 37.8, zoom: 6 });
  ctx.flyTo({ bbox: [-10, 35, 30, 60] });
  assert.equal(ctx.flyTo({ bbox: [1, 2, 3] }), false);
  assert.equal(ctx.route([14593, 4242, 3356]), 2);
  ctx.view.set({ mode: 'geo' });
  const moves = bridge.calls.filter(([c]) => ['select', 'flyToNode', 'flyTo', 'fitBounds', 'setRoute', 'setView'].includes(c));
  assert.deepEqual(moves, [
    ['select', 1],
    ['flyToNode', 1],
    ['flyToNode', 2],
    ['flyTo', { lon: -122.4, lat: 37.8, zoom: 6 }],
    ['fitBounds', [-10, 35, 30, 60]],
    ['setRoute', [0, 1], { fly: true }],
    ['setView', { mode: 'geo' }],
  ]);
});

test('events carry what changed; track names the app', async () => {
  const { host, bridge, apps } = setup();
  await host.open('one');
  const ctx = apps[0].ctx;
  bridge.G = fakeGraph();
  const got = [];
  ctx.on('dataset', (d) => got.push(['dataset', d.id]));
  ctx.on('selection', (s) => got.push(['selection', s?.asn ?? null]));
  ctx.on('camera', (c) => got.push(['camera', c.zoom]));
  ctx.on('orbits', (o) => got.push(['orbits', o.active]));
  host.emit('dataset');
  bridge.sel.selected = 2;
  host.emit('selection');
  host.emit('camera');
  host.emit('orbits');
  assert.deepEqual(got, [['dataset', 'tiny'], ['selection', 714], ['camera', 2], ['orbits', false]]);
  ctx.track('fly', { to: 14593 });
  assert.deepEqual(bridge.calls.filter(([c]) => c === 'track'), [['track', 'app_open', { app_id: 'one' }], ['track', 'fly', { app_id: 'one', to: 14593 }]]);
  assert.equal(ctx.clock.now(), 1_700_000_000_000);
  assert.equal(ctx.clock.live, false);
  assert.equal(ctx.orbits.active(), false);
  assert.deepEqual(ctx.orbits.starlinkLinks(), []);
});
