import test from 'node:test';
import assert from 'node:assert/strict';
import { composeLayers, createLayerStore, layerId, parseLayerId } from './layers.js';

// deck.gl layers, as far as the store cares: an id, props, and clone()
class Fake {
  constructor(props) {
    this.props = props;
    this.id = props.id;
  }
  clone(p) {
    return new Fake({ ...this.props, ...p });
  }
}
const L = (id, extra = {}) => new Fake({ id, ...extra });
const ids = (ls) => ls.map((l) => l.id);

test('layer ids are namespaced by app and group, and parse back', () => {
  assert.equal(layerId('starlink', 'pops', 'dots'), 'app:starlink:pops:dots');
  assert.deepEqual(parseLayerId('app:starlink:pops:dots:2'), { app: 'starlink', group: 'pops', id: 'dots:2' });
  assert.equal(parseLayerId('nodes'), null);
  assert.equal(parseLayerId(undefined), null);
});

test('set, replace, remove and clear; each change asks for a redraw', () => {
  let redraws = 0;
  const s = createLayerStore({ onChange: () => redraws++ });
  s.set('a', 'g1', [L('x'), L('y')]);
  s.set('b', 'g1', [L('x')]);
  s.set('a', 'g2', [L('z')]);
  assert.deepEqual(ids(s.compose({}).above), ['app:a:g1:x', 'app:a:g1:y', 'app:a:g2:z', 'app:b:g1:x']);
  s.set('a', 'g1', [L('w')]); // replaced in place
  assert.deepEqual(ids(s.compose({}).above), ['app:a:g1:w', 'app:a:g2:z', 'app:b:g1:x']);
  s.remove('a', 'g2');
  s.remove('a', 'nope'); // no change, no redraw
  assert.deepEqual(s.groups('a'), ['g1']);
  s.clear('a');
  assert.deepEqual(ids(s.compose({}).above), ['app:b:g1:x']);
  assert.equal(redraws, 6);
});

test('the clone keeps the layer\'s props; the original is untouched', () => {
  const s = createLayerStore();
  const orig = L('x', { radius: 3 });
  s.set('a', 'g', [orig]);
  const [c] = s.compose({}).above;
  assert.equal(c.props.radius, 3);
  assert.equal(orig.id, 'x');
});

test('a function group gets the render\'s env (2D map or globe)', () => {
  const s = createLayerStore();
  s.set('a', 'g', (env) => [L(env.globe ? 'arc' : 'line'), env.geographic && L('geo-only')]);
  assert.deepEqual(ids(s.compose({ globe: true, geographic: false }).above), ['app:a:g:arc']);
  assert.deepEqual(ids(s.compose({ globe: false, geographic: true }).above), ['app:a:g:line', 'app:a:g:geo-only']);
});

test('below and above', () => {
  const s = createLayerStore();
  s.set('a', 'under', [L('u')], { placement: 'below' });
  s.set('a', 'over', [L('o')]);
  const apps = s.compose({});
  assert.deepEqual(ids(apps.below), ['app:a:under:u']);
  assert.deepEqual(ids(apps.above), ['app:a:over:o']);
  assert.throws(() => s.set('a', 'g', [], { placement: 'top' }), TypeError);
  assert.throws(() => s.set('a', 'bad id', []), TypeError);
});

test('composition: Earth, apps below, the network, apps above, then the Orbits links', () => {
  const s = createLayerStore();
  s.set('a', 'under', [L('u')], { placement: 'below' });
  s.set('a', 'over', [L('o')]);
  const apps = s.compose({ globe: true });
  const globe = composeLayers({ base: [L('ocean'), L('land')], network: [L('edges'), L('nodes')], apps, top: [L('orbit-links')] });
  assert.deepEqual(ids(globe), ['ocean', 'land', 'app:a:under:u', 'edges', 'nodes', 'app:a:over:o', 'orbit-links']);
  const map = composeLayers({ network: [L('edges'), L('nodes')], apps });
  assert.deepEqual(ids(map), ['app:a:under:u', 'edges', 'nodes', 'app:a:over:o']);
  // no app: just the network, as before apps
  assert.deepEqual(ids(composeLayers({ network: [L('edges')], apps: createLayerStore().compose({}) })), ['edges']);
});

test('an app\'s broken layers are skipped (warned once), not the render', () => {
  const warned = [];
  const s = createLayerStore({ warn: (...a) => warned.push(a[0]) });
  s.set('a', 'boom', () => {
    throw new Error('bug');
  });
  s.set('a', 'junk', [{ id: 'not-a-layer' }, null, false]);
  s.set('b', 'ok', [L('fine')]);
  for (let k = 0; k < 3; k++) assert.deepEqual(ids(s.compose({}).above), ['app:b:ok:fine']);
  assert.equal(warned.length, 2);
});

test('tooltips come from the hovered layer\'s group', () => {
  const s = createLayerStore({ warn: () => {} });
  s.set('a', 'g', [L('x')], { tooltip: (info) => `#${info.index}` });
  s.set('a', 'quiet', [L('y')]);
  s.set('a', 'bad', [L('z')], { tooltip: () => { throw new Error('x'); } });
  assert.equal(s.tooltip({ layer: { id: 'app:a:g:x' }, index: 4 }), '#4');
  assert.equal(s.tooltip({ layer: { id: 'app:a:quiet:y' }, index: 0 }), null);
  assert.equal(s.tooltip({ layer: { id: 'app:a:bad:z' }, index: 0 }), null);
  assert.equal(s.tooltip({ layer: { id: 'nodes' }, index: 0 }), null);
  assert.equal(s.tooltip({}), null);
});
