import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry, validateApp } from './registry.js';
import { APPS, createAppsRegistry } from './index.js';

const ICON = '<svg viewBox="0 0 24 24"></svg>';
const eager = (id, extra = {}) => ({ id, title: id.toUpperCase(), icon: ICON, mount() {}, unmount() {}, ...extra });

test('an app needs an id, a title, an icon and mount/unmount (or load)', () => {
  assert.doesNotThrow(() => validateApp(eager('a')));
  assert.doesNotThrow(() => validateApp({ id: 'lazy-one', title: 'Lazy', icon: ICON, load: async () => ({}) }));
  for (const bad of [
    null,
    eager('A'), // upper case
    eager('a.b'), // a dot: the hash prefix
    eager('1a'),
    { ...eager('a'), title: ' ' },
    { ...eager('a'), icon: 'satellite' }, // not SVG
    { id: 'a', title: 'A', icon: ICON }, // no mount, no load
    { ...eager('a'), unmount: undefined },
    { ...eager('a'), onHash: 'yes' },
  ]) assert.throws(() => validateApp(bad), TypeError, JSON.stringify(bad));
});

test('apps list in the order registered; ids are unique', () => {
  const r = createRegistry([eager('b'), eager('a')]);
  assert.deepEqual(r.list().map((a) => a.id), ['b', 'a']);
  assert.equal(r.has('a'), true);
  assert.equal(r.get('zz'), null);
  assert.throws(() => r.register(eager('a')), /already/);
});

test('a lazy app loads once, merged with its entry; a failed load is tried again', async () => {
  let loads = 0;
  let fail = true;
  const r = createRegistry([
    {
      id: 'lazy',
      title: 'Lazy',
      icon: ICON,
      load: async () => {
        loads++;
        if (fail) throw new Error('offline');
        return { default: { mount() {}, unmount() {}, onHash() {} } };
      },
    },
  ]);
  await assert.rejects(r.resolve('lazy'), /offline/);
  fail = false;
  const app = await r.resolve('lazy');
  assert.equal(app.id, 'lazy');
  assert.equal(app.title, 'Lazy');
  assert.equal(typeof app.mount, 'function');
  assert.equal(typeof app.onHash, 'function');
  assert.equal(await r.resolve('lazy'), app);
  assert.equal(loads, 2);
  await assert.rejects(r.resolve('nope'), /no app/);
});

test('a module without mount/unmount is not an app', async () => {
  const r = createRegistry([{ id: 'x', title: 'X', icon: ICON, load: async () => ({ mount() {} }) }]);
  await assert.rejects(r.resolve('x'), /no mount and unmount/);
});

test('the built-in apps register, Starlink first, and its code loads', async () => {
  const r = createAppsRegistry();
  assert.equal(APPS[0].id, 'starlink');
  assert.equal(r.get('starlink').title, 'Starlink');
  const app = await r.resolve('starlink');
  assert.equal(typeof app.mount, 'function');
  assert.equal(typeof app.unmount, 'function');
  assert.equal(typeof app.onHash, 'function');
});
