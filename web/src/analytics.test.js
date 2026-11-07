import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAnalytics, sanitizeParams, viewParam, pageLocation, countBucket, privacySignal, gate, track, analytics, STORAGE_KEY, GTAG_SRC,
} from './analytics.js';

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

// A page: its storage, dataLayer host, loaded scripts and cookie clears.
function page({ id = 'G-TEST123', enabled = true, blocked = false, stored = undefined, storage } = {}) {
  const s = storage ?? memoryStorage(stored ? { [STORAGE_KEY]: stored } : {});
  const host = {};
  const scripts = [];
  let cleared = 0;
  const a = createAnalytics({
    id,
    enabled,
    blocked,
    storage: s,
    host,
    loadScript: (src) => scripts.push(src),
    location: { origin: 'https://example.org', pathname: '/netmap/', hash: '#data=internet&as=3356&lon=1', search: '?ga_debug=1' },
    clearCookies: () => cleared++,
  });
  a.setView(() => ({ mode: 'geo', view: 'globe', dataset: 'internet' }));
  return {
    a, host, scripts, storage: s,
    cleared: () => cleared,
    // the dataLayer as arrays (gtag pushes Arguments objects)
    layer: () => (host.dataLayer || []).map((x) => Array.from(x)),
    events: () => (host.dataLayer || []).map((x) => Array.from(x)).filter((x) => x[0] === 'event'),
  };
}

test('no measurement ID: off, no prompt, track is a no-op', () => {
  const p = page({ id: '' });
  assert.equal(p.a.status(), 'off');
  assert.equal(p.a.needsPrompt(), false);
  p.a.track('mode_change', { mode: 'geo' });
  assert.equal(p.a.queued(), 0);
  p.a.grant();
  assert.equal(p.host.dataLayer, undefined);
  assert.deepEqual(p.scripts, []);
  assert.equal(p.storage.m.size, 0);
});

test('the module instance under node is off, and its track a no-op', () => {
  assert.equal(analytics.status(), 'off');
  assert.doesNotThrow(() => track('app_open', { app_id: 'celestiary' }));
  assert.equal(analytics.queued(), 0);
});

test('the gate: an ID and a production build, or forced', () => {
  assert.deepEqual(gate({ id: '', prod: true }), { enabled: false, debug: false });
  assert.deepEqual(gate({ id: 'G-X', prod: true }), { enabled: true, debug: false });
  assert.deepEqual(gate({ id: 'G-X', prod: false }), { enabled: false, debug: false }, 'dev and tests are off');
  assert.deepEqual(gate({ id: 'G-X', prod: false, search: '?ga_debug=1' }), { enabled: true, debug: true });
  assert.deepEqual(gate({ id: 'G-X', prod: false, force: true }), { enabled: true, debug: false });
  assert.deepEqual(gate({ id: '', search: '?ga_debug=1' }), { enabled: false, debug: true }, 'debug without an ID is still off');
});

test('not enabled (a dev server): off even with an ID', () => {
  const p = page({ enabled: false });
  assert.equal(p.a.status(), 'off');
  p.a.track('search', { result: 'hit' });
  p.a.grant();
  assert.deepEqual(p.scripts, []);
});

test('nothing loads before consent; events queue', () => {
  const p = page();
  assert.equal(p.a.status(), 'pending');
  assert.equal(p.a.needsPrompt(), true);
  p.a.track('dataset_load', { dataset_id: 'internet', nodes: 'gte1m' });
  p.a.track('mode_change', { mode: 'cyber', from: 'geo', via: 'button' });
  assert.equal(p.a.queued(), 2);
  assert.deepEqual(p.scripts, []);
  assert.equal(p.host.dataLayer, undefined, 'no dataLayer, no gtag');
});

test('allow: consent defaults denied, then analytics granted, the tag, the queue', () => {
  const p = page();
  p.a.track('dataset_load', { dataset_id: 'internet' });
  p.a.grant();
  assert.equal(p.a.status(), 'granted');
  assert.equal(p.storage.getItem(STORAGE_KEY), 'granted');
  assert.deepEqual(p.scripts, [`${GTAG_SRC}?id=G-TEST123`]);
  const l = p.layer();
  const def = l.findIndex((x) => x[0] === 'consent' && x[1] === 'default');
  const upd = l.findIndex((x) => x[0] === 'consent' && x[1] === 'update');
  const cfg = l.findIndex((x) => x[0] === 'config');
  assert.equal(def, 0, 'consent default comes first');
  assert.deepEqual(l[def][2], { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied' });
  assert.ok(upd > def && cfg > upd);
  assert.deepEqual(l[upd][2], { analytics_storage: 'granted' }, 'only analytics is granted');
  const config = l[cfg][2];
  assert.equal(l[cfg][1], 'G-TEST123');
  assert.equal(config.allow_google_signals, false);
  assert.equal(config.allow_ad_personalization_signals, false);
  assert.equal(config.page_location, 'https://example.org/netmap/', 'no hash, no query');
  assert.equal(config.view, 'geo:globe:internet');
  assert.deepEqual(p.events(), [['event', 'dataset_load', { dataset_id: 'internet', view: 'geo:globe:internet' }]]);
  assert.equal(p.a.queued(), 0);
  p.a.track('as_select', { asn: 3356, how: 'search' });
  assert.deepEqual(p.events().at(-1), ['event', 'as_select', { asn: 3356, how: 'search', view: 'geo:globe:internet' }]);
});

test('gtag pushes Arguments objects, as gtag.js expects', () => {
  const p = page();
  p.a.grant();
  for (const x of p.host.dataLayer) assert.equal(Object.prototype.toString.call(x), '[object Arguments]');
  assert.equal(typeof p.host.gtag, 'function');
});

test('no thanks: the queue is dropped and nothing ever loads', () => {
  const p = page();
  p.a.track('dataset_load', { dataset_id: 'internet' });
  p.a.track('globe_toggle', { to: 'map' });
  p.a.deny();
  assert.equal(p.a.status(), 'denied');
  assert.equal(p.a.queued(), 0);
  assert.equal(p.storage.getItem(STORAGE_KEY), 'denied');
  p.a.track('search', { result: 'miss' });
  assert.equal(p.a.queued(), 0);
  assert.deepEqual(p.scripts, []);
  assert.equal(p.host.dataLayer, undefined);
  assert.equal(p.cleared(), 0, 'nothing to clear: GA never ran');
});

test('a stored choice: granted starts at once, denied stays off, neither asks', () => {
  const g = page({ stored: 'granted' });
  assert.equal(g.a.status(), 'granted');
  assert.equal(g.a.needsPrompt(), false);
  assert.equal(g.scripts.length, 1);
  g.a.track('globe_toggle', { to: 'map' });
  assert.equal(g.events().length, 1);

  const d = page({ stored: 'denied' });
  assert.equal(d.a.status(), 'denied');
  assert.equal(d.a.needsPrompt(), false);
  d.a.track('globe_toggle', { to: 'map' });
  assert.equal(d.a.queued(), 0);
  assert.deepEqual(d.scripts, []);

  const junk = page({ stored: 'maybe' });
  assert.equal(junk.a.status(), 'pending');
});

test('withdrawing consent: analytics denied, cookies cleared, no more events', () => {
  const p = page({ stored: 'granted' });
  p.a.deny();
  const last = p.layer().at(-1);
  assert.deepEqual(last, ['consent', 'update', { analytics_storage: 'denied' }]);
  assert.equal(p.cleared(), 1);
  const n = p.events().length;
  p.a.track('globe_toggle', { to: 'map' });
  assert.equal(p.events().length, n);
  p.a.grant(); // and back: no second script
  assert.equal(p.scripts.length, 1);
  assert.deepEqual(p.layer().at(-1), ['consent', 'update', { analytics_storage: 'granted' }]);
});

test('storage that throws: still works for the page, just not remembered', () => {
  const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  const p = page({ storage: bad });
  assert.equal(p.a.status(), 'pending');
  assert.doesNotThrow(() => p.a.grant());
  assert.equal(p.a.status(), 'granted');
});

test('Do Not Track / Global Privacy Control: off, never asks, never loads', () => {
  assert.equal(privacySignal({ doNotTrack: '1' }), true);
  assert.equal(privacySignal({}, { doNotTrack: '1' }), true);
  assert.equal(privacySignal({ msDoNotTrack: '1' }), true);
  assert.equal(privacySignal({ globalPrivacyControl: true }), true);
  assert.equal(privacySignal({ doNotTrack: '0', globalPrivacyControl: false }), false);
  assert.equal(privacySignal({ doNotTrack: 'unspecified' }), false);

  const p = page({ blocked: true, stored: 'granted' });
  assert.equal(p.a.status(), 'blocked');
  assert.equal(p.a.needsPrompt(), false);
  p.a.track('mode_change', { mode: 'geo' });
  p.a.grant();
  assert.equal(p.a.queued(), 0);
  assert.deepEqual(p.scripts, [], 'a stored yes does not override the browser');
  assert.equal(p.host.dataLayer, undefined);
});

test('the queue is bounded', () => {
  const p = page();
  for (let i = 0; i < 500; i++) p.a.track('style_change', { control: 'edgeAlpha' });
  assert.equal(p.a.queued(), 100);
});

test('bad event names are ignored', () => {
  const p = page({ stored: 'granted' });
  for (const n of ['', 'Mode Change', 'a#b', 'x'.repeat(41), null, 3]) p.a.track(n, {});
  assert.equal(p.events().length, 0);
});

test('params: no hash, URL or free text gets through', () => {
  assert.deepEqual(
    sanitizeParams({
      asn: 3356,
      dataset_id: 'internet',
      on: true,
      off: false,
      result: 'hit',
      q_len: 7,
      ratio: 1 / 3,
      page_location: 'https://example.org/#data=internet&as=3356',
      page_referrer: 'https://x',
      page_title: 'netmap - Cogent',
      q: 'cogent',
      query: 'level3',
      search_term: 'x',
      hash: 'data=internet&as=3356',
      link: 'https://example.org/netmap/#lon=1',
      frag: '#as=3356',
      name: 'Level 3 Parent, LLC',
      long: 'x'.repeat(65),
      nan: NaN,
      inf: Infinity,
      obj: { a: 1 },
      list: [1, 2],
      'Bad-Key': 'x',
      _x: 'y',
    }),
    { asn: 3356, dataset_id: 'internet', on: 1, off: 0, result: 'hit', q_len: 7, ratio: 0.333 },
  );
  assert.deepEqual(sanitizeParams(null), {});
});

test('events carry the view token, which overrides any `view` param', () => {
  const p = page({ stored: 'granted' });
  p.a.track('globe_toggle', { to: 'map', view: 'geo:map:internet#as=3356' });
  assert.equal(p.events()[0][2].view, 'geo:globe:internet');
  p.a.setView(() => ({ mode: 'cyber', view: 'map', dataset: 'routers' }));
  p.a.track('globe_toggle', { to: 'map' });
  assert.equal(p.events()[1][2].view, 'cyber:map:routers');
});

test('viewParam keeps to known values', () => {
  assert.equal(viewParam({ mode: 'hybrid', view: 'map', dataset: 'synthetic' }), 'hybrid:map:synthetic');
  assert.equal(viewParam({ mode: 'x', view: 'y', dataset: 'a b#c' }), 'other:other:other');
  assert.equal(viewParam({}), 'other:other:none');
  assert.equal(viewParam(), 'other:other:none');
});

test('pageLocation drops the query and the hash', () => {
  assert.equal(pageLocation({ origin: 'https://a.io', pathname: '/netmap/', search: '?tiles=x', hash: '#as=1' }), 'https://a.io/netmap/');
});

test('countBucket', () => {
  assert.deepEqual([0, 999, 1000, 9999, 10000, 80966, 148673, 2e6, undefined].map(countBucket), ['lt1k', 'lt1k', '1k-10k', '1k-10k', '10k-100k', '10k-100k', '100k-1m', 'gte1m', 'lt1k']);
});

test('onChange hears the choice', () => {
  const p = page();
  const heard = [];
  p.a.onChange((s) => heard.push(s));
  p.a.grant();
  p.a.deny();
  assert.deepEqual(heard, ['granted', 'denied']);
});
