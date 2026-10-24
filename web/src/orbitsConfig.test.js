// node --test: which pages the Orbits layer may load (src/orbitsConfig.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ORBITS_SRC, isAllowedOrbitsOrigin, orbitsQuery, parseOrigins, resolveOrbitsSrc } from './orbitsConfig.js';

const prod = { pageOrigin: 'https://pablo-mayrgundter.github.io' };

test('production by default', () => {
  assert.deepEqual(resolveOrbitsSrc(prod), { src: DEFAULT_ORBITS_SRC, origin: 'https://celestiary.org', rejected: null });
});

test('a link may pick a page on an allowed origin', () => {
  const r = resolveOrbitsSrc({ ...prod, param: 'https://celestiary.org/web/pr-preview/pr-296/layer.html' });
  assert.equal(r.src, 'https://celestiary.org/web/pr-preview/pr-296/layer.html');
  assert.equal(r.origin, 'https://celestiary.org');
  assert.equal(r.rejected, null);
});

test('a link may not pick any other origin', () => {
  for (const bad of [
    'https://evil.example/layer.html',
    'https://celestiary.org.evil.example/layer.html',
    'http://celestiary.org/layer.html', // not https
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    '//celestiary.org/layer.html', // not absolute
    'https://user:pw@celestiary.org/layer.html',
    'http://localhost:5480/layer.html', // localhost from a production page
  ]) {
    const r = resolveOrbitsSrc({ ...prod, param: bad });
    assert.equal(r.src, DEFAULT_ORBITS_SRC, bad);
    assert.equal(r.rejected, bad);
  }
});

test('localhost only in dev or from a local netmap', () => {
  const param = 'http://127.0.0.1:5480/layer.html';
  assert.equal(resolveOrbitsSrc({ ...prod, param, dev: true }).origin, 'http://127.0.0.1:5480');
  assert.equal(resolveOrbitsSrc({ pageOrigin: 'http://localhost:4173', param }).origin, 'http://127.0.0.1:5480');
  assert.equal(resolveOrbitsSrc({ ...prod, param }).origin, 'https://celestiary.org');
});

test('the build may choose the default and add origins', () => {
  assert.equal(resolveOrbitsSrc({ ...prod, envSrc: 'https://orbits.example/layer.html' }).origin, 'https://orbits.example');
  const r = resolveOrbitsSrc({ ...prod, envOrigins: 'https://mirror.example, not a url, https://x.example/path', param: 'https://mirror.example/l.html' });
  assert.equal(r.origin, 'https://mirror.example');
  assert.deepEqual(parseOrigins('https://a.example, https://b.example/x, ,http://c.example:81'), ['https://a.example', 'http://c.example:81']);
  assert.equal(isAllowedOrbitsOrigin('null'), false);
});

test('the guest query', () => {
  assert.deepEqual(orbitsQuery({ sats: true, starlink: true, iridium: false, dsn: true }), { nets: 'S,D', sats: '1', any: true });
  assert.deepEqual(orbitsQuery({ sats: false, starlink: false, iridium: false, dsn: false }), { nets: '', sats: '0', any: false });
});
