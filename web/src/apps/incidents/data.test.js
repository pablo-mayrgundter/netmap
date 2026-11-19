import test from 'node:test';
import assert from 'node:assert/strict';
import { ATC_2026, CENTERS, CENTER_BY_ID, chronological, distanceKm, eventById, INCIDENTS, nearestCenter, NOV13, parseStep, SEP21, shapeEvent, stepParam } from './data.js';

test('22 en route centers, unique ids, on the map', () => {
  assert.equal(CENTERS.length, 22);
  assert.equal(new Set(CENTERS.map((c) => c.id)).size, 22);
  for (const c of CENTERS) {
    assert.match(c.id, /^Z[A-Z]{2}$/);
    assert.ok(c.lat > 15 && c.lat < 72 && c.lon > -170 && c.lon < -60, c.id);
  }
});

test('distanceKm: about right, and symmetric', () => {
  const nyc = { lat: 40.71, lon: -74.01 }, la = { lat: 34.05, lon: -118.24 };
  const d = distanceKm(nyc, la);
  assert.ok(d > 3900 && d < 4000, String(d));
  assert.equal(Math.round(distanceKm(la, nyc)), Math.round(d));
  assert.equal(distanceKm(nyc, nyc), 0);
});

test('the Nov 13 sites link to their nearest center (the model)', () => {
  for (const l of NOV13.links.filter((x) => x.kind === 'access')) {
    const site = NOV13.points.find((p) => p.id === l.from);
    assert.equal(nearestCenter(site).id, l.to, l.id);
  }
});

test('the incident: three events, newest first, the ground stop by default', () => {
  assert.equal(ATC_2026.title, 'ATC Nationwide ground stop');
  assert.match(ATC_2026.summary, /air traffic control \(ATC\)/);
  assert.deepEqual(ATC_2026.events.map((e) => e.id), ['nov13', 'sep21', 'aug6']);
  assert.deepEqual(chronological(ATC_2026).map((e) => e.id), ['aug6', 'sep21', 'nov13']);
  assert.equal(eventById(ATC_2026, null), NOV13);
  assert.equal(eventById(ATC_2026, 'nope'), NOV13);
  assert.equal(eventById(ATC_2026, 'sep21'), SEP21);
});

test('parseStep and stepParam round-trip, default out of the hash', () => {
  for (const ev of ATC_2026.events) {
    assert.equal(parseStep(ev, null), ev.defaultStep);
    assert.equal(parseStep(ev, 'x'), ev.defaultStep);
    assert.equal(parseStep(ev, '1.5'), ev.defaultStep);
    assert.equal(parseStep(ev, '-3'), 0);
    assert.equal(parseStep(ev, '99'), ev.steps.length - 1);
    assert.equal(stepParam(ev, ev.defaultStep), null);
    for (let k = 0; k < ev.steps.length; k++) assert.equal(parseStep(ev, stepParam(ev, k)), k);
  }
});

test('Nov 13: the flood reaches every other center, then the sites are cut off', () => {
  const flood = shapeEvent(NOV13, NOV13.steps.findIndex((s) => s.title === 'The network goes unstable'));
  const reach = flood.links.filter((l) => l.kind === 'reach');
  assert.equal(reach.length, 2 * (CENTERS.length - 1));
  assert.ok(reach.every((r) => r.from !== r.to && r.status === 'flood'));
  assert.ok(flood.centers.every((c) => c.status === 'alert'));
  const block = shapeEvent(NOV13, NOV13.steps.findIndex((s) => s.title === 'Both sites blocked'));
  assert.equal(block.links.filter((l) => l.kind === 'reach').length, 0);
  assert.ok(block.points.every((p) => p.status === 'blocked'));
  assert.ok(block.links.every((l) => l.status === 'down'));
  assert.ok(block.centers.every((c) => c.status === 'ok'));
});

test('Philadelphia: the backup is down before the primary fails; airports join the stop', () => {
  const s0 = shapeEvent(SEP21, 0);
  const st = (s, id) => s.links.find((l) => l.id === id)?.status;
  assert.equal(st(s0, 'backup'), 'down');
  assert.equal(st(s0, 'primary'), 'ok');
  const s1 = shapeEvent(SEP21, 1);
  assert.equal(st(s1, 'primary'), 'down');
  assert.equal(s1.points.find((p) => p.id === 'pct').status, 'down');
  const s3 = shapeEvent(SEP21, 3);
  assert.deepEqual(s3.points.filter((p) => p.status === 'alert').map((p) => p.id).sort(), ['ewr', 'jfk', 'lga', 'phl', 'teb']);
  // the two links between the same places are bent apart
  const [a, b] = s0.links;
  const mid = (l) => l.path[Math.floor(l.path.length / 2)];
  assert.ok(Math.hypot(mid(a)[0] - mid(b)[0], mid(a)[1] - mid(b)[1]) > 0.05);
});

test('Minneapolis: its center goes down, then comes back', () => {
  const ev = eventById(ATC_2026, 'aug6');
  assert.equal(shapeEvent(ev, 0).centers.find((c) => c.id === 'ZMP').status, 'down');
  assert.equal(shapeEvent(ev, ev.steps.length - 1).centers.find((c) => c.id === 'ZMP').status, 'ok');
});

test('globe reach paths are lifted, flat ones are not', () => {
  const k = NOV13.defaultStep;
  assert.ok(shapeEvent(NOV13, k).links.every((r) => r.path.every((p) => p[2] === 0)));
  assert.ok(shapeEvent(NOV13, k, { globe: true }).links.some((r) => r.path.some((p) => p[2] > 6e3)));
});

test('every event: sources, a bbox, steps whose ids exist, links whose ends exist', () => {
  for (const inc of INCIDENTS) {
    for (const ev of inc.events) {
      assert.ok(ev.sources.length > 0 && ev.sources.every(([, u]) => /^https:\/\//.test(u)), ev.id);
      assert.equal(ev.bbox.length, 4);
      assert.ok(ev.defaultStep >= 0 && ev.defaultStep < ev.steps.length);
      const ids = new Set([...ev.points.map((p) => p.id), ...ev.links.map((l) => l.id), ...CENTERS.map((c) => c.id)]);
      for (const s of ev.steps) {
        assert.ok(s.time && s.title && s.text, ev.id);
        for (const id of Object.keys(s.status)) assert.ok(ids.has(id), `${ev.id}: ${id}`);
        if (s.focus) assert.ok(ev.points.some((p) => p.id === s.focus));
      }
      const ends = new Set([...ev.points.map((p) => p.id), ...CENTER_BY_ID.keys(), '*']);
      for (const l of ev.links) assert.ok(ends.has(l.from) && ends.has(l.to) && l.modelled && l.label, `${ev.id}: ${l.id}`);
    }
  }
});
